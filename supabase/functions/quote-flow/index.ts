import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { rejectIfOrgUser } from "../_shared/orgUserGuard.ts";
import { quoteFlowCost, NODE_TYPE_REGISTRY, PricingConfigError, fetchFeatureMultipliers } from "../_shared/pricing.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const orgBlock = await rejectIfOrgUser(req);
  if (orgBlock) return orgBlock;

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Authorization required" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { flow_id, graph_nodes, all_node_params } = body as {
      flow_id: string;
      graph_nodes?: Array<{ id: string; type: string; data: Record<string, unknown> }>;
      all_node_params?: Record<string, Record<string, unknown>>;
    };

    if (!flow_id) {
      return new Response(JSON.stringify({ error: "flow_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch flow (incl. ERP overrides)
    const { data: flow, error: flowErr } = await supabase
      .from("flows")
      .select("user_id, markup_multiplier, markup_multiplier_override, selling_price, base_cost, is_official, settings")
      .eq("id", flow_id).maybeSingle();

    if (flowErr || !flow) {
      return new Response(JSON.stringify({ error: "Flow not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const isOwner = user.id === flow.user_id;
    // ERP override priority:
    //   1. markup_multiplier_override > 0 → use as effective multiplier
    //   2. else fall back to flow.markup_multiplier (default 4.0)
    const overrideMultiplier = Number(flow.markup_multiplier_override) || 0;
    const markupMultiplier = overrideMultiplier > 0
      ? overrideMultiplier
      : (Number(flow.markup_multiplier) || 4.0);
    // Hard price override (from ERP). When > 0, this wins over node-by-node calc.
    const overrideSellingPrice = Number(flow.selling_price) || 0;
    const overrideBaseCost = Number(flow.base_cost) || 0;
    const isOfficial = !!flow.is_official;

    // Subscription discount
    let discountPercent = 0;
    if (!isOwner) {
      const { data: profile } = await supabase
        .from("profiles").select("subscription_plan_id")
        .eq("user_id", user.id).maybeSingle();
      if (profile?.subscription_plan_id) {
        const { data: plan } = await supabase
          .from("subscription_plans")
          .select("discount_official, discount_community")
          .eq("id", profile.subscription_plan_id).maybeSingle();
        if (plan) {
          discountPercent = isOfficial
            ? Number(plan.discount_official) || 0
            : Number(plan.discount_community) || 0;
        }
      }
    }

    // Use provided graph_nodes OR fallback to flow's stored graph
    let nodes = graph_nodes;
    if (!nodes) {
      const settings = flow.settings as Record<string, unknown> | null;
      const graph = settings?.graph as { nodes?: Array<{ id: string; type: string; data: Record<string, unknown> }> } | null;
      nodes = graph?.nodes ?? [];
    }

    // Fetch platform feature multipliers (used only when no ERP override)
    const featureMultipliers = overrideMultiplier > 0
      ? undefined  // disable feature-level mults so the ERP override wins
      : await fetchFeatureMultipliers(supabase);

    const quote = await quoteFlowCost(supabase, {
      graphNodes: nodes,
      allNodeParams: all_node_params,
      markupMultiplier,
      isOwner,
      discountPercent,
      featureMultipliers,
      // Pass the flow owner so revshare is split using the OWNER's
      // current rank — not the runner's. The runner is the consumer.
      creatorUserId: flow.user_id as string,
    });

    // ── Apply HARD ERP override (selling_price) if set ──
    let finalPrice = quote.price;
    let finalDiscount = quote.discount;
    let finalBaseCost = quote.total_base_cost;
    let appliedOverride: "selling_price" | "multiplier" | "none" = "none";

    if (overrideSellingPrice > 0) {
      appliedOverride = "selling_price";
      // Owner sees raw override; consumers get subscription discount applied to it
      if (isOwner) {
        finalPrice = overrideSellingPrice;
        finalDiscount = 0;
      } else {
        const discountAmount = discountPercent > 0
          ? Math.floor(overrideSellingPrice * (discountPercent / 100))
          : 0;
        finalPrice = Math.max(overrideSellingPrice - discountAmount, 1);
        finalDiscount = discountAmount;
      }
      // Use ERP base_cost when provided; otherwise keep computed
      if (overrideBaseCost > 0) finalBaseCost = overrideBaseCost;
    } else if (overrideMultiplier > 0) {
      appliedOverride = "multiplier";
    }

    return new Response(
      JSON.stringify({
        price: finalPrice,
        base_cost: finalBaseCost,
        discount: finalDiscount,
        discount_percent: discountPercent,
        is_owner: quote.is_owner,
        per_node_costs: quote.per_node_costs,
        override_applied: appliedOverride,
        breakdown: {
          markup_multiplier: quote.markup_multiplier,
          raw_price: overrideSellingPrice > 0 ? overrideSellingPrice : quote.pricing.raw_price,
          transaction_type: quote.pricing.transaction_type,
          rev_share: quote.pricing.rev_share_amount,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[quote-flow] Error:", e);

    // Return 400 for missing pricing config so frontend can show a clear message
    if (e instanceof PricingConfigError) {
      return new Response(
        JSON.stringify({ error: e.message, code: "PRICING_CONFIG_MISSING" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
