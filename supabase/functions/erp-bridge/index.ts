import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { lookupBaseCost, NODE_TYPE_REGISTRY, PricingConfigError } from "../_shared/pricing.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function respond(ok: boolean, data: unknown) {
  return new Response(
    JSON.stringify({ ok, ...(ok ? { data } : { error: data }) }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

// Revenue share for creator payout (20% of contribution margin)
const REVSHARE = 0.20;
const DEFAULT_MULTIPLIER = 4.0;

type FeatureMultipliers = {
  image: number;
  video: number;
  chat: number;
};

/**
 * Fetch the current platform markup multipliers from subscription_settings.
 * Falls back to DEFAULT_MULTIPLIER (4.0) for any missing key.
 */
async function fetchFeatureMultipliers(
  supabase: ReturnType<typeof createClient>,
): Promise<FeatureMultipliers> {
  const { data, error } = await supabase
    .from("subscription_settings")
    .select("key, value")
    .in("key", [
      "markup_multiplier_image",
      "markup_multiplier_video",
      "markup_multiplier_chat",
    ]);
  if (error) throw error;
  const map: Record<string, number> = {};
  (data || []).forEach((r: { key: string; value: string }) => {
    const n = parseFloat(r.value);
    map[r.key] = Number.isFinite(n) && n > 0 ? n : DEFAULT_MULTIPLIER;
  });
  return {
    image: map.markup_multiplier_image ?? DEFAULT_MULTIPLIER,
    video: map.markup_multiplier_video ?? DEFAULT_MULTIPLIER,
    chat: map.markup_multiplier_chat ?? DEFAULT_MULTIPLIER,
  };
}

/**
 * Determine the primary pricing category (image | video | chat) for a flow
 * based on its node types. Video > Image > Chat priority since video is the
 * dominant cost driver when present.
 */
function determineFlowCategory(
  nodes: Array<{ node_type?: string | null; config?: Record<string, unknown> | null }>,
): keyof FeatureMultipliers {
  let hasVideo = false;
  let hasImage = false;
  let hasChat = false;

  for (const n of nodes ?? []) {
    const t = String(n?.node_type ?? "").toLowerCase();
    if (!t) continue;
    if (
      t.includes("video") ||
      t.includes("kling") ||
      t.includes("motion") ||
      t.includes("omni")
    ) {
      hasVideo = true;
    } else if (
      t.includes("image") ||
      t.includes("banana") ||
      t.includes("gemini-image") ||
      t.includes("imagen")
    ) {
      hasImage = true;
    } else if (
      t.includes("chat") ||
      t.includes("text") ||
      t.includes("llm") ||
      t.includes("gpt")
    ) {
      hasChat = true;
    }
  }

  if (hasVideo) return "video";
  if (hasImage) return "image";
  if (hasChat) return "chat";
  return "image"; // safe default
}

function computePricing(apiCost: number, multiplier: number) {
  const safeApi = Math.max(0, Math.round(Number(apiCost) || 0));
  const safeMult = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : DEFAULT_MULTIPLIER;
  const sellingPrice = Math.ceil(safeApi * safeMult);
  const contributionMargin = Math.max(0, sellingPrice - safeApi);
  const creatorPayout = Math.ceil(contributionMargin * REVSHARE);
  return {
    api_cost: safeApi,
    markup_multiplier: safeMult,
    selling_price: sellingPrice,
    contribution_margin: contributionMargin,
    creator_payout: creatorPayout,
  };
}

/**
 * Map LEGACY DB node_type strings (stored in `flow_nodes.node_type`) to the
 * MODERN registry keys used by `_shared/pricing.ts` (NODE_TYPE_REGISTRY).
 *
 * The platform stores graph data in two places (technical debt):
 *   1. `flow_nodes` table — legacy `ai/banana_pro`, `ai/kling_2_6_i2v`, etc.
 *   2. `flows.settings.graph.nodes` — modern `bananaProNode`, `klingVideoNode`, etc.
 *
 * Pricing logic in `_shared/pricing.ts` only knows the modern keys, so we
 * normalize before lookup.
 */
const LEGACY_NODE_TYPE_MAP: Record<string, string> = {
  "ai/banana_pro":      "bananaProNode",
  "ai/image_gen":       "bananaProNode",
  "ai/kling_2_6_i2v":   "klingVideoNode",
  "ai/kling_2_6_camera":"klingVideoNode",
  "ai/kling_3_0_i2v":   "klingVideoNode",
  "ai/kling_video":     "klingVideoNode",
  "ai/chat_ai":         "chatAiNode",
  "ai/text_gen":        "chatAiNode",
};

function normalizeNodeType(rawType: string | null | undefined): string | null {
  if (!rawType) return null;
  if (NODE_TYPE_REGISTRY[rawType]) return rawType;          // already modern
  return LEGACY_NODE_TYPE_MAP[rawType] ?? null;             // map legacy → modern
}

/**
 * Build a normalized list of action nodes (with params) for a flow.
 *
 * Source priority:
 *   1. `flows.settings.graph.nodes` (modern, richer params) — preferred.
 *   2. `flow_nodes` rows (legacy fallback) — used when the JSON graph is empty.
 */
function collectActionNodes(
  settingsGraph: unknown,
  flowNodeRows: Array<{ node_type: string; config: Record<string, unknown> | null }>,
): Array<{ id: string; type: string; params: Record<string, unknown> }> {
  // Try graph JSON first
  const graphNodes =
    settingsGraph && typeof settingsGraph === "object"
      ? (settingsGraph as { nodes?: unknown }).nodes
      : null;
  if (Array.isArray(graphNodes) && graphNodes.length > 0) {
    const out: Array<{ id: string; type: string; params: Record<string, unknown> }> = [];
    for (const n of graphNodes as Array<Record<string, unknown>>) {
      const normalized = normalizeNodeType(String(n.type ?? ""));
      if (!normalized) continue;
      const data = (n.data ?? {}) as Record<string, unknown>;
      const params = (data.params ?? {}) as Record<string, unknown>;
      out.push({
        id: String(n.id ?? crypto.randomUUID()),
        type: normalized,
        params,
      });
    }
    if (out.length > 0) return out;
  }

  // Fallback: flow_nodes table
  const out: Array<{ id: string; type: string; params: Record<string, unknown> }> = [];
  for (const row of flowNodeRows) {
    const normalized = normalizeNodeType(row.node_type);
    if (!normalized) continue;
    const cfg = (row.config ?? {}) as Record<string, unknown>;
    // legacy `flow_nodes.config` typically has `params: {...}`; if not, treat the whole config as params
    const params = (cfg.params && typeof cfg.params === "object")
      ? (cfg.params as Record<string, unknown>)
      : cfg;
    out.push({ id: crypto.randomUUID(), type: normalized, params });
  }
  return out;
}

/**
 * Compute the total base API cost for a flow by summing per-node costs from
 * `credit_costs`. Uses the strict shared `lookupBaseCost` from `_shared/pricing.ts`.
 *
 * Returns `{ apiCost, perNode, missingPricing }`. If a node has no pricing row
 * configured, it is collected in `missingPricing` (the flow is NOT skipped).
 */
async function computeFlowApiCost(
  supabase: ReturnType<typeof createClient>,
  actionNodes: Array<{ id: string; type: string; params: Record<string, unknown> }>,
): Promise<{
  apiCost: number;
  perNode: Array<{ type: string; cost: number }>;
  missingPricing: Array<{ type: string; reason: string }>;
}> {
  let total = 0;
  const perNode: Array<{ type: string; cost: number }> = [];
  const missingPricing: Array<{ type: string; reason: string }> = [];

  for (const node of actionNodes) {
    const def = NODE_TYPE_REGISTRY[node.type];
    if (!def) {
      // Unknown node type — DO NOT skip the entire flow. Default this node's
      // cost to 0 and continue accumulating the other nodes' costs.
      missingPricing.push({
        type: node.type,
        reason: `Unknown node type "${node.type}" — not in NODE_TYPE_REGISTRY. Defaulted to 0.`,
      });
      perNode.push({ type: node.type, cost: 0 });
      continue;
    }
    try {
      const cost = await lookupBaseCost(supabase, def, node.params);
      total += cost;
      perNode.push({ type: node.type, cost });
    } catch (e) {
      // Pricing row missing for a recognized node — DO NOT skip the flow.
      // Default this node to 0 and surface the gap to admin via missingPricing.
      const msg = e instanceof PricingConfigError
        ? e.message
        : (e instanceof Error ? e.message : String(e));
      missingPricing.push({ type: node.type, reason: msg });
      perNode.push({ type: node.type, cost: 0 });
    }
  }

  return { apiCost: total, perNode, missingPricing };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return respond(false, "Method not allowed");
  }

  let parsedBody: { action?: string; secret?: string; payload?: Record<string, unknown> } = {};
  try {
    parsedBody = await req.json();
  } catch (parseErr) {
    console.error("[ERP-BRIDGE] JSON parse error:", parseErr);
    return respond(false, {
      message: "Invalid JSON body",
      stage: "request_parse",
      details: parseErr instanceof Error ? parseErr.message : String(parseErr),
    });
  }

  try {
    const { action, secret, payload } = parsedBody;

    // Log every submit_review request for debugging
    if (action === "submit_review") {
      console.log("[ERP-BRIDGE:submit_review] Incoming payload:", JSON.stringify({
        flow_id: payload?.flow_id,
        decision: payload?.decision,
        reviewer_id: payload?.reviewer_id,
        admin_user_email: payload?.admin_user_email,
        has_secret: !!secret,
      }));
    }

    // Validate secret
    const expectedSecret = Deno.env.get("ERP_BRIDGE_SECRET");
    if (!expectedSecret) {
      console.error("[ERP-BRIDGE] ERP_BRIDGE_SECRET env var is not set");
      return respond(false, {
        message: "Server misconfiguration: ERP_BRIDGE_SECRET missing",
        stage: "auth",
      });
    }
    if (secret !== expectedSecret) {
      console.warn(`[ERP-BRIDGE] Unauthorized request — secret mismatch (action=${action})`);
      return respond(false, {
        message: "Unauthorized — invalid or missing ERP_BRIDGE_SECRET",
        stage: "auth",
        hint: "Ensure your ERP system sends the correct 'secret' field in the JSON body matching the ERP_BRIDGE_SECRET env var.",
      });
    }

    // Validate env vars
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("[ERP-BRIDGE] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
      return respond(false, "Server configuration error");
    }

    // Service-role client — bypasses RLS
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    let result: unknown;

    switch (action) {
      // ── Dashboard Stats ────────────────────────────────────
      case "dashboard_stats": {
        const [profilesRes, demoLinksRes, codesRes, plansRes, auditRes] =
          await Promise.all([
            supabase.from("profiles").select("id", { count: "exact", head: true }),
            supabase.from("demo_links").select("id", { count: "exact", head: true }),
            supabase.from("redemption_codes").select("id", { count: "exact", head: true }),
            supabase.from("subscription_plans").select("id", { count: "exact", head: true }).eq("is_active", true),
            supabase.from("admin_audit_logs").select("id", { count: "exact", head: true }),
          ]);
        if (profilesRes.error) throw profilesRes.error;
        if (demoLinksRes.error) throw demoLinksRes.error;
        if (codesRes.error) throw codesRes.error;
        if (plansRes.error) throw plansRes.error;
        if (auditRes.error) throw auditRes.error;

        result = {
          total_users: profilesRes.count ?? 0,
          total_demo_links: demoLinksRes.count ?? 0,
          total_redemption_codes: codesRes.count ?? 0,
          total_active_plans: plansRes.count ?? 0,
          total_audit_logs: auditRes.count ?? 0,
        };
        break;
      }

      // ── List Users ─────────────────────────────────────────
      case "list_users": {
        const limit = payload?.limit ?? 100;
        const offset = payload?.offset ?? 0;

        const { data, error } = await supabase
          .from("profiles")
          .select(`
            user_id,
            display_name,
            avatar_url,
            company,
            industry,
            role,
            is_official,
            subscription_status,
            subscription_plan_id,
            current_period_end,
            created_at,
            updated_at
          `)
          .order("created_at", { ascending: false })
          .range(offset, offset + limit - 1);
        if (error) throw error;

        const userIds = (data || []).map((p: { user_id: string }) => p.user_id);
        const { data: credits, error: creditsErr } = await supabase
          .from("user_credits")
          .select("user_id, balance, total_purchased, total_used")
          .in("user_id", userIds);
        if (creditsErr) throw creditsErr;

        const creditMap = new Map(
          (credits || []).map((c: { user_id: string }) => [c.user_id, c]),
        );

        result = (data || []).map((p: { user_id: string }) => ({
          ...p,
          credits: creditMap.get(p.user_id) ?? {
            balance: 0,
            total_purchased: 0,
            total_used: 0,
          },
        }));
        break;
      }

      // ── Grant Credits ──────────────────────────────────────
      case "grant_credits": {
        const {
          user_id,
          amount,
          source_type = "bonus",
          expiry_days = 90,
          description = "ERP credit grant",
          reference_id = null,
        } = payload;

        if (!user_id) throw new Error("Missing user_id");
        if (!amount || amount <= 0) throw new Error("Amount must be positive");
        if (amount > 5000000) throw new Error("Amount exceeds safety limit");

        const { error } = await supabase.rpc("grant_credits", {
          p_user_id: user_id,
          p_amount: amount,
          p_source_type: source_type,
          p_expiry_days: expiry_days,
          p_description: description,
          p_reference_id: reference_id,
        });
        if (error) throw error;

        result = { success: true, user_id, amount };
        break;
      }

      // ── Redemption Codes ───────────────────────────────────
      case "insert_redemption_code": {
        const { data, error } = await supabase
          .from("redemption_codes")
          .insert(payload)
          .select()
          .single();
        if (error) throw error;
        result = data;
        break;
      }

      case "list_redemption_codes": {
        const { data, error } = await supabase
          .from("redemption_codes")
          .select("*")
          .order("created_at", { ascending: false });
        if (error) throw error;
        result = data;
        break;
      }

      // ── Demo Links ─────────────────────────────────────────
      case "insert_demo_link": {
        const { data, error } = await supabase
          .from("demo_links")
          .insert(payload)
          .select()
          .single();
        if (error) throw error;
        result = data;
        break;
      }

      case "list_demo_links": {
        const { data, error } = await supabase
          .from("demo_links")
          .select("*")
          .order("created_at", { ascending: false });
        if (error) throw error;
        result = data;
        break;
      }

      case "update_demo_link": {
        const { id, ...updates } = payload;
        if (!id) throw new Error("Missing id in payload");
        const { data, error } = await supabase
          .from("demo_links")
          .update(updates)
          .eq("id", id)
          .select()
          .single();
        if (error) throw error;
        result = data;
        break;
      }

      // ── Demo Budget ────────────────────────────────────────
      case "get_demo_budget": {
        const { month } = payload;
        if (!month) throw new Error("Missing month");
        const { data, error } = await supabase
          .from("demo_budget")
          .select("total_credits_granted, max_monthly_credits")
          .eq("month", month)
          .maybeSingle();
        if (error) throw error;
        result = data ?? { total_credits_granted: 0, max_monthly_credits: 100000 };
        break;
      }

      case "count_demo_links_today": {
        const { start_of_today } = payload;
        if (!start_of_today) throw new Error("Missing start_of_today");
        const { count, error } = await supabase
          .from("demo_links")
          .select("id", { count: "exact", head: true })
          .gte("created_at", start_of_today);
        if (error) throw error;
        result = count ?? 0;
        break;
      }

      case "upsert_demo_budget": {
        const { month, credits_to_add } = payload;
        if (!month || credits_to_add == null)
          throw new Error("Missing month or credits_to_add");
        const { data: existing, error: existErr } = await supabase
          .from("demo_budget")
          .select("id, total_credits_granted")
          .eq("month", month)
          .maybeSingle();
        if (existErr) throw existErr;
        if (existing) {
          const { error } = await supabase
            .from("demo_budget")
            .update({
              total_credits_granted:
                existing.total_credits_granted + credits_to_add,
              updated_at: new Date().toISOString(),
            })
            .eq("id", existing.id);
          if (error) throw error;
        } else {
          const { error } = await supabase.from("demo_budget").insert({
            month,
            total_credits_granted: credits_to_add,
          });
          if (error) throw error;
        }
        result = { success: true };
        break;
      }

      // ── Subscription Plans ────────────────────────────────
      case "list_plans": {
        const { data, error } = await supabase
          .from("subscription_plans")
          .select("*")
          .eq("is_active", true)
          .order("sort_order", { ascending: true });
        if (error) throw error;
        result = data;
        break;
      }

      // ── Audit Logs ─────────────────────────────────────────
      case "list_audit_logs": {
        const limit = payload?.limit ?? 200;
        const { data, error } = await supabase
          .from("admin_audit_logs")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) throw error;
        result = data;
        break;
      }

      case "insert_audit_log": {
        const { admin_email, action_type, target_email, details } = payload ?? {};
        if (!action_type) throw new Error("Missing action_type");
        const { data, error } = await supabase
          .from("admin_audit_logs")
          .insert({
            admin_user_id: payload.admin_user_id ?? "00000000-0000-0000-0000-000000000000",
            action: action_type,
            target_table: payload.target_table ?? "erp_bridge",
            target_user_id: payload.target_user_id ?? null,
            details: { admin_email, target_email, ...details },
            ip_address: payload.ip_address ?? null,
          })
          .select()
          .single();
        if (error) throw error;
        result = data;
        break;
      }

      // ── Redemption Code Lookup ─────────────────────────────
      case "get_code_by_stripe_session": {
        const { stripe_session_id } = payload;
        if (!stripe_session_id) throw new Error("Missing stripe_session_id");
        const { data, error } = await supabase
          .from("redemption_codes")
          .select("*")
          .eq("stripe_session_id", stripe_session_id)
          .maybeSingle();
        if (error) throw error;
        result = data;
        break;
      }

      // ── Execute Demo Redemption (Full Cycle) ───────────────
      case "execute_demo_redemption": {
        const { token, user_id, user_email, admin_email } = payload ?? {};

        if (!token || typeof token !== "string" || token.length < 4 || token.length > 100) {
          return respond(false, "Invalid or missing token");
        }
        if (!user_id) {
          return respond(false, "Missing user_id");
        }

        // Step 1: Validate token against demo_links
        const { data: demoLink, error: linkErr } = await supabase
          .from("demo_links")
          .select("*")
          .eq("token", token)
          .maybeSingle();

        if (linkErr) {
          console.error("[ERP-BRIDGE] demo_links lookup error:", linkErr);
          return respond(false, "ไม่สามารถตรวจสอบ Token ได้");
        }
        if (!demoLink) {
          return respond(false, "ลิงก์ Demo ไม่ถูกต้อง");
        }
        if (!demoLink.is_active) {
          return respond(false, "ลิงก์ Demo นี้ถูกปิดใช้งานแล้ว");
        }
        if (new Date(demoLink.expires_at) < new Date()) {
          return respond(false, "ลิงก์ Demo นี้หมดอายุแล้ว");
        }
        if (demoLink.redeemed_by) {
          return respond(false, "ลิงก์ Demo นี้ถูกใช้ไปแล้ว");
        }

        // Step 2: Idempotency check via credit_transactions
        const { data: existingTx } = await supabase
          .from("credit_transactions")
          .select("id, created_at")
          .eq("user_id", user_id)
          .eq("reference_id", `demo:${token}`)
          .maybeSingle();

        if (existingTx) {
          // Repair stale link state if needed
          try {
            await supabase
              .from("demo_links")
              .update({
                redeemed_by: demoLink.redeemed_by ?? user_id,
                redeemed_at: demoLink.redeemed_at ?? existingTx.created_at ?? new Date().toISOString(),
                is_active: false,
              })
              .eq("id", demoLink.id);
          } catch (repairErr) {
            console.error("[ERP-BRIDGE] Repair stale link failed:", repairErr);
          }

          result = { success: true, credits: demoLink.credits_budget || 500, already_redeemed: true };
          break;
        }

        const creditsToGrant = demoLink.credits_budget || 500;

        // Step 3: Check monthly budget
        const currentMonth = new Date().toISOString().slice(0, 7);
        const { data: budget, error: budgetErr } = await supabase
          .from("demo_budget")
          .select("*")
          .eq("month", currentMonth)
          .maybeSingle();
        if (budgetErr) {
          console.error("[ERP-BRIDGE] Budget lookup error:", budgetErr);
          return respond(false, "ไม่สามารถตรวจสอบงบประมาณได้");
        }

        const totalGranted = budget?.total_credits_granted || 0;
        const maxMonthly = budget?.max_monthly_credits || 100000;

        if (totalGranted + creditsToGrant > maxMonthly) {
          return respond(false, "เครดิต Demo ประจำเดือนหมดแล้ว กรุณาลองใหม่เดือนหน้า");
        }

        // Step 4: Mark demo link as redeemed (optimistic lock)
        const { data: updatedRows, error: markErr } = await supabase
          .from("demo_links")
          .update({
            redeemed_by: user_id,
            redeemed_at: new Date().toISOString(),
            is_active: false,
          })
          .eq("id", demoLink.id)
          .is("redeemed_by", null)
          .select("id");

        if (markErr) {
          console.error("[ERP-BRIDGE] Failed to mark redeemed:", markErr);
          return respond(false, "ไม่สามารถอัปเดตสถานะ Demo link ได้");
        }
        if (!updatedRows || updatedRows.length === 0) {
          return respond(false, "ลิงก์ Demo นี้ถูกใช้ไปแล้ว (race condition)");
        }

        // Step 5: Grant credits via RPC
        const { error: grantError } = await supabase.rpc("grant_credits", {
          p_user_id: user_id,
          p_amount: creditsToGrant,
          p_source_type: "bonus",
          p_expiry_days: 90,
          p_description: "Demo Link Credits",
          p_reference_id: `demo:${token}`,
        });

        if (grantError) {
          console.error("[ERP-BRIDGE] grant_credits error:", grantError);
          // Rollback demo link
          try {
            await supabase
              .from("demo_links")
              .update({ redeemed_by: null, redeemed_at: null, is_active: true })
              .eq("id", demoLink.id);
          } catch (rollbackErr) {
            console.error("[ERP-BRIDGE] Rollback failed:", rollbackErr);
          }
          return respond(false, "ไม่สามารถเพิ่มเครดิตได้ กรุณาลองใหม่");
        }

        // Step 6: Update monthly budget
        try {
          if (budget) {
            await supabase
              .from("demo_budget")
              .update({
                total_credits_granted: totalGranted + creditsToGrant,
                updated_at: new Date().toISOString(),
              })
              .eq("id", budget.id);
          } else {
            await supabase
              .from("demo_budget")
              .insert({ month: currentMonth, total_credits_granted: creditsToGrant });
          }
        } catch (budgetUpdateErr) {
          console.error("[ERP-BRIDGE] Budget update failed (non-fatal):", budgetUpdateErr);
        }

        // Step 7: Insert audit log
        try {
          await supabase
            .from("admin_audit_logs")
            .insert({
              admin_user_id: payload.admin_user_id ?? "00000000-0000-0000-0000-000000000000",
              action: "demo_redemption",
              target_table: "demo_links",
              target_user_id: user_id,
              details: {
                admin_email: admin_email || null,
                user_email: user_email || null,
                token,
                credits: creditsToGrant,
              },
              ip_address: payload.ip_address ?? null,
            });
        } catch (auditErr) {
          console.error("[ERP-BRIDGE] Audit log insert failed (non-fatal):", auditErr);
        }

        console.log(`[ERP-BRIDGE] Demo redeemed: ${creditsToGrant} credits → ${user_id} (${user_email || "no-email"}) token=${token}`);
        result = { success: true, credits: creditsToGrant, token, user_id };
        break;
      }

      // ── Credit Costs CRUD (ERP exact actions: list_credit_costs, upsert_credit_cost, delete_credit_cost) ──
      case "list_credit_costs":
      case "fetch_credit_costs": {
        const { data, error } = await supabase
          .from("credit_costs")
          .select("*")
          .order("feature", { ascending: true })
          .order("cost", { ascending: true });
        if (error) throw error;
        result = data;
        break;
      }

      case "upsert_credit_cost": {
        const { id, feature, model, label, cost, pricing_type, duration_seconds, has_audio, admin_user_email } = payload ?? {};
        if (!feature || !label || cost == null) throw new Error("feature, label, cost required");
        const row = {
          feature,
          model: model || null,
          label,
          cost: Number(cost),
          pricing_type: pricing_type || "per_operation",
          duration_seconds: feature === "generate_freepik_video" ? (duration_seconds ?? null) : null,
          has_audio: feature === "generate_freepik_video" ? (has_audio ?? false) : false,
        };
        let savedId = id ?? null;
        if (id) {
          const { error: upErr } = await supabase.from("credit_costs").update(row).eq("id", id);
          if (upErr) throw upErr;
        } else {
          const { data: ins, error: insErr } = await supabase.from("credit_costs").insert(row).select("id").single();
          if (insErr) throw insErr;
          savedId = ins?.id ?? null;
        }
        try {
          await supabase.from("admin_audit_logs").insert({
            admin_user_id: payload.admin_user_id ?? "00000000-0000-0000-0000-000000000000",
            action: id ? "update_credit_cost" : "create_credit_cost",
            target_table: "credit_costs",
            details: { admin_email: admin_user_email ?? null, id: savedId, ...row },
            ip_address: payload.ip_address ?? null,
          });
        } catch (auditErr) {
          console.error("[ERP-BRIDGE] Audit log (upsert_credit_cost) failed:", auditErr);
        }
        result = { success: true, id: savedId };
        break;
      }

      case "delete_credit_cost": {
        const { id, admin_user_email } = payload ?? {};
        if (!id) throw new Error("Missing id");
        const { data: existing } = await supabase
          .from("credit_costs")
          .select("*")
          .eq("id", id)
          .maybeSingle();
        const { error: delErr } = await supabase.from("credit_costs").delete().eq("id", id);
        if (delErr) throw delErr;
        try {
          await supabase.from("admin_audit_logs").insert({
            admin_user_id: payload.admin_user_id ?? "00000000-0000-0000-0000-000000000000",
            action: "delete_credit_cost",
            target_table: "credit_costs",
            details: { admin_email: admin_user_email ?? null, id, deleted: existing ?? null },
            ip_address: payload.ip_address ?? null,
          });
        } catch (auditErr) {
          console.error("[ERP-BRIDGE] Audit log (delete_credit_cost) failed:", auditErr);
        }
        result = { success: true, id };
        break;
      }

      // ── Platform Markup Multipliers (ERP exact actions: get_multipliers, update_multipliers) ──
      case "get_multipliers":
      case "get_markup_multipliers": {
        const { data, error } = await supabase
          .from("subscription_settings")
          .select("key, value")
          .in("key", ["markup_multiplier_image", "markup_multiplier_video", "markup_multiplier_chat"]);
        if (error) throw error;
        const map: Record<string, number> = {};
        (data || []).forEach((r: { key: string; value: string }) => {
          map[r.key] = parseFloat(r.value) || 4.0;
        });
        result = {
          markup_multiplier_image: map.markup_multiplier_image ?? 4.0,
          markup_multiplier_video: map.markup_multiplier_video ?? 4.0,
          markup_multiplier_chat: map.markup_multiplier_chat ?? 4.0,
          // Backward-compat short keys
          image: map.markup_multiplier_image ?? 4.0,
          video: map.markup_multiplier_video ?? 4.0,
          chat: map.markup_multiplier_chat ?? 4.0,
        };
        break;
      }

      case "update_multipliers":
      case "set_markup_multipliers": {
        const {
          image,
          video,
          chat,
          markup_multiplier_image,
          markup_multiplier_video,
          markup_multiplier_chat,
          admin_user_email,
        } = payload ?? {};

        // ── Safe float parser: rejects NaN / non-finite / non-positive values ──
        const safeParseMultiplier = (raw: unknown): number | null => {
          if (raw === null || raw === undefined || raw === "") return null;
          const n = typeof raw === "number" ? raw : parseFloat(String(raw));
          if (!Number.isFinite(n)) return null;
          if (n <= 0) return null;
          return n;
        };

        const candidates: Array<{ key: string; raw: unknown }> = [
          { key: "markup_multiplier_image", raw: markup_multiplier_image ?? image },
          { key: "markup_multiplier_video", raw: markup_multiplier_video ?? video },
          { key: "markup_multiplier_chat",  raw: markup_multiplier_chat  ?? chat  },
        ];

        const updates: { key: string; value: string; numeric: number }[] = [];
        const invalid: { key: string; raw: unknown }[] = [];
        for (const c of candidates) {
          if (c.raw === null || c.raw === undefined) continue; // not provided → ignore
          const parsed = safeParseMultiplier(c.raw);
          if (parsed === null) {
            invalid.push({ key: c.key, raw: c.raw });
            continue;
          }
          updates.push({ key: c.key, value: String(parsed), numeric: parsed });
        }

        if (invalid.length > 0) {
          return respond(false, {
            error: "Invalid multiplier value(s)",
            invalid,
          });
        }

        if (updates.length === 0) {
          return respond(false, {
            error: "No valid multipliers provided in payload (expected: image, video, chat as positive numbers)",
          });
        }

        // ── Force upsert + .select() and verify each write actually landed ──
        const writeResults: Array<{ key: string; value: string; verified: boolean }> = [];
        for (const u of updates) {
          const { data: rows, error: upErr } = await supabase
            .from("subscription_settings")
            .upsert(
              { key: u.key, value: u.value, updated_at: new Date().toISOString() },
              { onConflict: "key" }
            )
            .select("key, value");

          if (upErr) {
            console.error(`[ERP-BRIDGE] set_markup_multipliers upsert error for ${u.key}:`, upErr);
            return respond(false, {
              error: `DB write failed for ${u.key}: ${upErr.message}`,
              key: u.key,
              value: u.value,
            });
          }

          if (!rows || rows.length === 0) {
            console.error(`[ERP-BRIDGE] set_markup_multipliers: empty result for ${u.key} — write not confirmed`);
            return respond(false, {
              error: `DB write not confirmed for ${u.key} (empty result from upsert)`,
              key: u.key,
              value: u.value,
            });
          }

          // Confirm the value the DB now holds matches what we wrote
          const stored = rows[0] as { key: string; value: string };
          if (String(stored.value) !== u.value) {
            console.error(`[ERP-BRIDGE] set_markup_multipliers: stored value mismatch for ${u.key}: expected ${u.value}, got ${stored.value}`);
            return respond(false, {
              error: `Stored value mismatch for ${u.key}: expected ${u.value}, got ${stored.value}`,
            });
          }

          writeResults.push({ key: u.key, value: u.value, verified: true });
        }

        try {
          await supabase.from("admin_audit_logs").insert({
            admin_user_id: payload.admin_user_id ?? "00000000-0000-0000-0000-000000000000",
            action: "update_markup_multipliers",
            target_table: "subscription_settings",
            details: {
              admin_email: admin_user_email ?? null,
              updates: writeResults.reduce((acc: Record<string, string>, u) => {
                acc[u.key] = u.value;
                return acc;
              }, {}),
            },
            ip_address: payload.ip_address ?? null,
          });
        } catch (auditErr) {
          console.error("[ERP-BRIDGE] Audit log (set_markup_multipliers) failed:", auditErr);
        }

        result = {
          ok: true,
          success: true,
          updated: writeResults.length,
          written: writeResults,
        };
        break;
      }

      // ── User History (Transactions + Flow Runs) ────────────
      case "get_user_history": {
        const { user_id, tx_limit = 200, run_limit = 200 } = payload ?? {};
        if (!user_id) throw new Error("Missing user_id");

        const [profileRes, creditsRes, txRes, runsRes] = await Promise.all([
          supabase
            .from("profiles")
            .select("user_id, display_name, avatar_url, company, role, is_official, subscription_status, subscription_plan_id, current_period_end, created_at")
            .eq("user_id", user_id)
            .maybeSingle(),
          supabase
            .from("user_credits")
            .select("balance, total_purchased, total_used")
            .eq("user_id", user_id)
            .maybeSingle(),
          supabase
            .from("credit_transactions")
            .select("id, amount, type, feature, description, reference_id, balance_after, created_at")
            .eq("user_id", user_id)
            .order("created_at", { ascending: false })
            .limit(tx_limit),
          supabase
            .from("flow_runs")
            .select("id, flow_id, status, credits_used, duration_ms, started_at, completed_at, error_message")
            .eq("user_id", user_id)
            .order("started_at", { ascending: false })
            .limit(run_limit),
        ]);
        if (profileRes.error) throw profileRes.error;
        if (creditsRes.error) throw creditsRes.error;
        if (txRes.error) throw txRes.error;
        if (runsRes.error) throw runsRes.error;

        result = {
          profile: profileRes.data ?? null,
          credits: creditsRes.data ?? { balance: 0, total_purchased: 0, total_used: 0 },
          transactions: txRes.data ?? [],
          flow_runs: runsRes.data ?? [],
        };
        break;
      }

      // ── Admin Manage User (status / official badge) ────────
      case "admin_manage_user": {
        const { user_id, is_official, subscription_status, banned, admin_user_email } = payload ?? {};
        if (!user_id) throw new Error("Missing user_id");

        const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (typeof is_official === "boolean") updates.is_official = is_official;
        if (typeof subscription_status === "string") updates.subscription_status = subscription_status;
        // Convenience: banned=true sets subscription_status='banned', banned=false sets 'inactive'
        if (typeof banned === "boolean" && typeof subscription_status !== "string") {
          updates.subscription_status = banned ? "banned" : "inactive";
        }

        if (Object.keys(updates).length <= 1) {
          throw new Error("No changes provided (is_official, subscription_status, or banned required)");
        }

        const { data, error } = await supabase
          .from("profiles")
          .update(updates)
          .eq("user_id", user_id)
          .select("user_id, is_official, subscription_status, updated_at")
          .single();
        if (error) throw error;

        try {
          await supabase.from("admin_audit_logs").insert({
            admin_user_id: payload.admin_user_id ?? "00000000-0000-0000-0000-000000000000",
            action: "admin_manage_user",
            target_table: "profiles",
            target_user_id: user_id,
            details: { admin_email: admin_user_email ?? null, updates },
            ip_address: payload.ip_address ?? null,
          });
        } catch (auditErr) {
          console.error("[ERP-BRIDGE] Audit log (admin_manage_user) failed:", auditErr);
        }

        result = data;
        break;
      }

      // ── CMS: Homepage Sections + Featured ──────────────────
      case "cms_manage_homepage": {
        const { op, target, data: rowData, id, admin_user_email } = payload ?? {};
        if (!op || !target) throw new Error("Missing op or target");
        if (target !== "sections" && target !== "featured") {
          throw new Error("target must be 'sections' or 'featured'");
        }
        const table = target === "sections" ? "homepage_sections" : "homepage_featured";

        let opResult: unknown;
        switch (op) {
          case "list": {
            const { data, error } = await supabase
              .from(table)
              .select("*")
              .order("sort_order", { ascending: true });
            if (error) throw error;
            opResult = data;
            break;
          }
          case "create": {
            if (!rowData || typeof rowData !== "object") throw new Error("Missing data");
            const { data, error } = await supabase.from(table).insert(rowData).select().single();
            if (error) throw error;
            opResult = data;
            break;
          }
          case "update": {
            if (!id) throw new Error("Missing id");
            if (!rowData || typeof rowData !== "object") throw new Error("Missing data");
            const updates = { ...rowData, updated_at: new Date().toISOString() };
            const { data, error } = await supabase
              .from(table)
              .update(updates)
              .eq("id", id)
              .select()
              .single();
            if (error) throw error;
            opResult = data;
            break;
          }
          case "delete": {
            if (!id) throw new Error("Missing id");
            const { error } = await supabase.from(table).delete().eq("id", id);
            if (error) throw error;
            opResult = { success: true, id };
            break;
          }
          default:
            throw new Error(`Unknown op: ${op} (use list|create|update|delete)`);
        }

        if (op !== "list") {
          try {
            await supabase.from("admin_audit_logs").insert({
              admin_user_id: payload.admin_user_id ?? "00000000-0000-0000-0000-000000000000",
              action: `cms_${op}_${target}`,
              target_table: table,
              details: { admin_email: admin_user_email ?? null, id: id ?? null, data: rowData ?? null },
              ip_address: payload.ip_address ?? null,
            });
          } catch (auditErr) {
            console.error("[ERP-BRIDGE] Audit log (cms_manage_homepage) failed:", auditErr);
          }
        }

        result = opResult;
        break;
      }

      // ── Flow Approval: Review Queue ────────────────────────
      case "get_review_queue": {
        const { data: flows, error } = await supabase
          .from("flows")
          .select("id, name, description, category, thumbnail_url, status, api_cost, base_cost, selling_price, markup_multiplier, markup_multiplier_override, contribution_margin, performance_bonus_percent, creator_payout, tags, user_id, settings, created_at, updated_at")
          .eq("status", "submitted")
          .order("updated_at", { ascending: false });
        if (error) throw error;

        const flowList = (flows || []) as Array<Record<string, unknown>>;
        const userIds = Array.from(new Set(flowList.map((f) => f.user_id as string)));
        const flowIds = flowList.map((f) => f.id as string);

        // Fetch profiles + flow_nodes (legacy fallback) + feature multipliers in parallel
        const [profilesRes, flowNodesRes, multipliers] = await Promise.all([
          supabase
            .from("profiles")
            .select("user_id, display_name, avatar_url, is_official")
            .in("user_id", userIds),
          flowIds.length > 0
            ? supabase
                .from("flow_nodes")
                .select("flow_id, node_type, config")
                .in("flow_id", flowIds)
            : Promise.resolve({ data: [], error: null }),
          fetchFeatureMultipliers(supabase),
        ]);

        const profileMap = new Map(
          (profilesRes.data || []).map((p: { user_id: string }) => [p.user_id, p]),
        );

        // Group flow_nodes by flow_id for legacy fallback
        const nodesByFlow = new Map<string, Array<{ node_type: string; config: Record<string, unknown> | null }>>();
        for (const row of (flowNodesRes.data || []) as Array<{ flow_id: string; node_type: string; config: Record<string, unknown> | null }>) {
          const arr = nodesByFlow.get(row.flow_id) ?? [];
          arr.push({ node_type: row.node_type, config: row.config });
          nodesByFlow.set(row.flow_id, arr);
        }

        // For each flow, compute LIVE pricing using the same logic as approval.
        // This guarantees ERP shows the rolled-up credit price end-users would
        // pay, even before the flow has been approved (DB columns are 0 until then).
        const enriched = await Promise.all(
          flowList.map(async (f) => {
            const settings = f.settings as Record<string, unknown> | null;
            const settingsGraph = settings?.graph ?? null;
            const actionNodes = collectActionNodes(
              settingsGraph,
              nodesByFlow.get(f.id as string) ?? [],
            );
            const { apiCost, perNode, missingPricing } = await computeFlowApiCost(
              supabase,
              actionNodes,
            );
            const category = determineFlowCategory(
              actionNodes.map((n) => ({ node_type: n.type })),
            );
            // Per-flow override wins over the platform-feature multiplier
            const overrideRaw = f.markup_multiplier_override;
            const override = overrideRaw === null || overrideRaw === undefined || overrideRaw === ""
              ? null
              : Number(overrideRaw);
            const effectiveMultiplier = override !== null && Number.isFinite(override) && override > 0
              ? override
              : multipliers[category];
            const calc = computePricing(apiCost, effectiveMultiplier);

            // Strip `settings` from response payload — large + not needed by ERP table
            const { settings: _omit, ...rest } = f;
            return {
              ...rest,
              creator: profileMap.get(f.user_id as string) ?? null,
              // LIVE pricing fields (override DB 0s for unapproved flows)
              api_cost: calc.api_cost,
              base_cost: calc.api_cost,
              selling_price: calc.selling_price,
              markup_multiplier: calc.markup_multiplier,
              contribution_margin: calc.contribution_margin,
              creator_payout: calc.creator_payout,
              pricing_category: category,
              pricing_per_node: perNode,
              pricing_warnings: missingPricing,
            };
          }),
        );

        result = enriched;
        break;
      }

      // ── Flow Approval: Single Flow Detail ──────────────────
      case "get_flow_detail": {
        const { flow_id } = payload ?? {};
        if (!flow_id) throw new Error("Missing flow_id");

        const [flowRes, nodesRes, reviewsRes] = await Promise.all([
          supabase.from("flows").select("*").eq("id", flow_id).maybeSingle(),
          supabase.from("flow_nodes").select("*").eq("flow_id", flow_id).order("sort_order", { ascending: true }),
          supabase.from("flow_reviews").select("*").eq("flow_id", flow_id).order("created_at", { ascending: false }),
        ]);
        if (flowRes.error) throw flowRes.error;
        if (nodesRes.error) throw nodesRes.error;
        if (reviewsRes.error) throw reviewsRes.error;
        if (!flowRes.data) throw new Error("Flow not found");

        const { data: creator } = await supabase
          .from("profiles")
          .select("user_id, display_name, avatar_url, is_official, company")
          .eq("user_id", flowRes.data.user_id)
          .maybeSingle();

        result = {
          flow: flowRes.data,
          nodes: nodesRes.data ?? [],
          reviews: reviewsRes.data ?? [],
          creator: creator ?? null,
        };
        break;
      }

      // ── Flow Approval: Submit Review (Approve / Reject / Changes Requested) ──
      case "submit_review": {
        const {
          flow_id,
          reviewer_id: payload_reviewer_id,
          decision,
          reviewer_notes,
          internal_notes,
          output_quality = 0,
          consistency = 0,
          commercial_usability = 0,
          originality = 0,
          efficiency = 0,
          workflow_clarity = 0,
          safety = 0,
          api_cost: payload_api_cost,
          selling_price: payload_selling_price,
          admin_user_email,
        } = payload ?? {};

        if (!flow_id) throw new Error("Missing flow_id");
        if (!decision) throw new Error("Missing decision");

        // Resolve reviewer_id: prefer explicit value, else look up by admin_user_email
        let reviewer_id: string | null = payload_reviewer_id ?? null;
        if (!reviewer_id && admin_user_email) {
          const { data: adminRow, error: adminLookupErr } = await supabase
            .from("admin_accounts")
            .select("id")
            .eq("email", String(admin_user_email).toLowerCase().trim())
            .eq("is_active", true)
            .maybeSingle();
          if (adminLookupErr) {
            console.error("[erp-bridge:submit_review] admin lookup failed:", adminLookupErr.message);
          }
          if (adminRow?.id) {
            reviewer_id = adminRow.id as string;
            console.log(`[erp-bridge:submit_review] Resolved reviewer_id ${reviewer_id} from email ${admin_user_email}`);
          }
        }
        if (!reviewer_id) {
          throw new Error(
            `Missing reviewer_id — could not resolve admin_accounts.id for email ${admin_user_email ?? "(none provided)"}. Pass reviewer_id explicitly or ensure the email exists in admin_accounts.`
          );
        }

        const validDecisions = ["approved", "rejected", "changes_requested"];
        if (!validDecisions.includes(decision)) {
          throw new Error(`Invalid decision: must be one of ${validDecisions.join(", ")}`);
        }

        // Fetch the flow
        const { data: flow, error: flowErr } = await supabase
          .from("flows")
          .select("id, name, user_id, api_cost, base_cost, status")
          .eq("id", flow_id)
          .maybeSingle();
        if (flowErr) throw flowErr;
        if (!flow) throw new Error("Flow not found");

        // total_score is a GENERATED ALWAYS column in DB — compute locally for downstream use,
        // but DO NOT include it in the insert payload (DB will reject it).
        const total_score =
          Number(output_quality) + Number(consistency) + Number(commercial_usability) +
          Number(originality) + Number(efficiency) + Number(workflow_clarity) + Number(safety);

        // Insert review (omit total_score — generated by DB)
        const { data: review, error: reviewErr } = await supabase
          .from("flow_reviews")
          .insert({
            flow_id,
            reviewer_id,
            decision,
            reviewer_notes: reviewer_notes ?? null,
            internal_notes: internal_notes ?? null,
            output_quality: Number(output_quality),
            consistency: Number(consistency),
            commercial_usability: Number(commercial_usability),
            originality: Number(originality),
            efficiency: Number(efficiency),
            workflow_clarity: Number(workflow_clarity),
            safety: Number(safety),
          })
          .select()
          .single();
        if (reviewErr) throw reviewErr;

        // Map decision → flow status
        const statusMap: Record<string, string> = {
          approved: "published",
          rejected: "rejected",
          changes_requested: "changes_requested",
        };
        const newStatus = statusMap[decision];

        const flowUpdates: Record<string, unknown> = {
          status: newStatus,
          updated_at: new Date().toISOString(),
        };

        // If approved → calculate pricing using DYNAMIC multipliers from subscription_settings
        let pricing:
          | {
              api_cost: number;
              markup_multiplier: number;
              selling_price: number;
              contribution_margin: number;
              creator_payout: number;
              category: keyof FeatureMultipliers;
            }
          | null = null;
        if (decision === "approved") {
          // ── Coerce payload_api_cost: treat null/undefined/NaN/<=0 as "missing" ──
          // (avoids Number(null)===0 trap that silently zeroed flows)
          const rawPayloadCost = Number(payload_api_cost);
          const hasValidPayloadCost =
            payload_api_cost !== undefined &&
            payload_api_cost !== null &&
            Number.isFinite(rawPayloadCost) &&
            rawPayloadCost > 0;

          // Fetch live multipliers + full flow data (settings.graph + flow_nodes fallback)
          const [multipliers, settingsRes, nodesRes] = await Promise.all([
            fetchFeatureMultipliers(supabase),
            supabase.from("flows").select("settings").eq("id", flow_id).maybeSingle(),
            supabase.from("flow_nodes").select("node_type, config").eq("flow_id", flow_id),
          ]);
          if (nodesRes.error) throw nodesRes.error;
          if (settingsRes.error) throw settingsRes.error;

          // Always determine category from action nodes (richer than raw flow_nodes)
          const settingsGraph = settingsRes.data?.settings && typeof settingsRes.data.settings === "object"
            ? (settingsRes.data.settings as { graph?: unknown }).graph
            : null;
          const actionNodes = collectActionNodes(settingsGraph, nodesRes.data ?? []);
          const category = determineFlowCategory(
            actionNodes.length > 0
              ? actionNodes.map((n) => ({ node_type: n.type }))
              : (nodesRes.data ?? []),
          );
          const multiplier = multipliers[category];

          // ── Auto-compute api_cost from nodes when ERP didn't send one ──
          // This is the safety net so officially-approved flows never publish at price 0.
          let apiCost: number;
          let computedFromNodes = false;
          if (hasValidPayloadCost) {
            apiCost = rawPayloadCost;
          } else if (actionNodes.length > 0) {
            const computed = await computeFlowApiCost(supabase, actionNodes);
            apiCost = computed.apiCost;
            computedFromNodes = true;
            console.log(
              `[erp-bridge:submit_review] Auto-computed api_cost=${apiCost} for flow ${flow_id} ` +
              `(payload_api_cost missing/invalid; ${actionNodes.length} action nodes; ` +
              `${computed.missingPricing.length} missing pricing entries)`,
            );
          } else {
            // Last-resort fallback: existing DB values
            apiCost = Number(flow.api_cost ?? flow.base_cost ?? 0);
            console.warn(
              `[erp-bridge:submit_review] No payload_api_cost AND no action nodes for flow ${flow_id} — ` +
              `falling back to stored api_cost=${apiCost}`,
            );
          }

          const calc = computePricing(apiCost, multiplier);

          // ── ERP selling_price override ──
          // If ERP explicitly sends selling_price, use it as the final price
          // and back-calculate margin/payout. This lets ops set a custom price
          // (e.g. 999) regardless of computed api_cost × multiplier.
          const rawPayloadSelling = Number(payload_selling_price);
          const hasValidSellingOverride =
            payload_selling_price !== undefined &&
            payload_selling_price !== null &&
            Number.isFinite(rawPayloadSelling) &&
            rawPayloadSelling > 0;

          let finalSelling = calc.selling_price;
          let finalMargin = calc.contribution_margin;
          let finalPayout = calc.creator_payout;
          let sellingOverridden = false;

          if (hasValidSellingOverride) {
            finalSelling = Math.ceil(rawPayloadSelling);
            finalMargin = Math.max(0, finalSelling - calc.api_cost);
            finalPayout = Math.ceil(finalMargin * REVSHARE);
            sellingOverridden = true;
            console.log(
              `[erp-bridge:submit_review] ERP override selling_price=${finalSelling} for flow ${flow_id} ` +
              `(api_cost=${calc.api_cost}, computed_selling=${calc.selling_price}, margin=${finalMargin}, payout=${finalPayout})`,
            );
          }

          flowUpdates.api_cost = calc.api_cost;
          flowUpdates.base_cost = calc.api_cost;
          flowUpdates.markup_multiplier = calc.markup_multiplier;
          flowUpdates.selling_price = finalSelling;
          flowUpdates.contribution_margin = finalMargin;
          flowUpdates.creator_payout = finalPayout;

          pricing = {
            ...calc,
            selling_price: finalSelling,
            contribution_margin: finalMargin,
            creator_payout: finalPayout,
            category,
          };
          (pricing as Record<string, unknown>).computed_from_nodes = computedFromNodes;
          (pricing as Record<string, unknown>).selling_price_overridden = sellingOverridden;
        }

        const { data: updatedFlow, error: updErr } = await supabase
          .from("flows")
          .update(flowUpdates)
          .eq("id", flow_id)
          .select()
          .single();
        if (updErr) throw updErr;

        // Notify creator
        const notifyTitleMap: Record<string, string> = {
          approved: `🎉 Flow "${flow.name}" ได้รับการอนุมัติแล้ว`,
          rejected: `❌ Flow "${flow.name}" ไม่ผ่านการพิจารณา`,
          changes_requested: `✏️ Flow "${flow.name}" ต้องการการแก้ไข`,
        };
        const notifyIconMap: Record<string, string> = {
          approved: "check-circle",
          rejected: "x-circle",
          changes_requested: "edit",
        };
        try {
          await supabase.from("notifications").insert({
            user_id: flow.user_id,
            type: "flow_review",
            title: notifyTitleMap[decision],
            message: reviewer_notes ?? null,
            icon: notifyIconMap[decision],
            link: `/creator/flows`,
            metadata: { flow_id, decision, total_score, pricing },
          });
        } catch (notifyErr) {
          console.error("[ERP-BRIDGE] Notification insert failed (non-fatal):", notifyErr);
        }

        // Audit log
        try {
          await supabase.from("admin_audit_logs").insert({
            admin_user_id: reviewer_id,
            action: `flow_review_${decision}`,
            target_table: "flows",
            target_user_id: flow.user_id,
            details: {
              admin_email: admin_user_email ?? null,
              flow_id,
              flow_name: flow.name,
              decision,
              total_score,
              pricing,
              reviewer_notes: reviewer_notes ?? null,
            },
            ip_address: payload.ip_address ?? null,
          });
        } catch (auditErr) {
          console.error("[ERP-BRIDGE] Audit log (submit_review) failed:", auditErr);
        }

        result = { success: true, review, flow: updatedFlow, pricing };
        break;
      }

      // ── Per-flow markup override (Sprint 1.1 — flows-bridge actions) ──
      case "get_flow_markup_override": {
        const { flow_id } = payload ?? {};
        if (!flow_id) throw new Error("Missing flow_id");
        const { data, error } = await supabase
          .from("flows")
          .select("id, name, markup_multiplier, markup_multiplier_override, api_cost, selling_price, contribution_margin, creator_payout")
          .eq("id", flow_id)
          .maybeSingle();
        if (error) throw error;
        if (!data) throw new Error(`Flow ${flow_id} not found`);
        result = data;
        break;
      }

      case "set_flow_markup_override": {
        const {
          flow_id,
          markup_multiplier_override,
          selling_price: payloadSellingPrice,
          admin_user_email,
          admin_user_id,
        } = payload ?? {};
        if (!flow_id) throw new Error("Missing flow_id");

        // Load current flow first (we need api_cost to back-calculate from selling_price)
        const { data: before, error: beforeErr } = await supabase
          .from("flows")
          .select("api_cost, markup_multiplier, markup_multiplier_override, selling_price, creator_payout")
          .eq("id", flow_id)
          .maybeSingle();
        if (beforeErr) throw beforeErr;
        if (!before) throw new Error(`Flow ${flow_id} not found`);

        // Resolve effective override:
        //  1. If selling_price provided → back-calculate multiplier so the trigger
        //     reproduces this exact selling price (compute_flow_pricing uses CEIL).
        //  2. Else if markup_multiplier_override provided → use it directly.
        //  3. Allow explicit null on either field to clear the override.
        let parsedOverride: number | null = null;
        let mode: "selling_price" | "multiplier" | "clear" = "clear";

        const hasSellingPrice =
          payloadSellingPrice !== undefined &&
          payloadSellingPrice !== null &&
          payloadSellingPrice !== "";
        const hasMultiplier =
          markup_multiplier_override !== undefined &&
          markup_multiplier_override !== null &&
          markup_multiplier_override !== "";

        if (hasSellingPrice) {
          const sp = typeof payloadSellingPrice === "number"
            ? payloadSellingPrice
            : parseFloat(String(payloadSellingPrice));
          if (!Number.isFinite(sp) || sp <= 0) {
            return respond(false, { error: "selling_price must be a positive number" });
          }
          const apiCost = Number(before.api_cost) || 0;
          if (apiCost <= 0) {
            return respond(false, {
              error: "Cannot set selling_price: flow has no api_cost. Set markup_multiplier_override instead.",
            });
          }
          // Back-calculate multiplier. The trigger does CEIL(api_cost * mult) so we
          // need a multiplier slightly above (sp / api_cost) when sp isn't a clean
          // multiple. Use (sp / api_cost) + tiny epsilon to land on CEIL = sp.
          // Then clamp to >= 1.0 (CHECK constraint). If the requested price is
          // below api_cost, multiplier ends up < 1.0 → reject.
          const rawMult = sp / apiCost;
          if (rawMult < 1.0) {
            return respond(false, {
              error: `selling_price ${sp} is below api_cost ${apiCost}; multiplier would be < 1.0`,
            });
          }
          // Round up to 4 decimal places so CEIL(api_cost * mult) == sp.
          parsedOverride = Math.ceil(rawMult * 10000) / 10000;
          // Sanity check: if api_cost * parsedOverride doesn't CEIL to sp due to
          // floating-point, bump by one ulp at the 4th decimal.
          if (Math.ceil(apiCost * parsedOverride) !== sp) {
            parsedOverride = parsedOverride + 0.0001;
          }
          mode = "selling_price";
        } else if (hasMultiplier) {
          const n = typeof markup_multiplier_override === "number"
            ? markup_multiplier_override
            : parseFloat(String(markup_multiplier_override));
          if (!Number.isFinite(n) || n < 1.0) {
            return respond(false, { error: "markup_multiplier_override must be >= 1.0 or null" });
          }
          parsedOverride = n;
          mode = "multiplier";
        }
        // else: explicit clear — parsedOverride stays null

        // IMPORTANT: also touch `api_cost` in the SET clause so the
        // `trg_compute_flow_pricing` trigger fires (it watches a fixed column
        // list via UPDATE OF). Re-assigning api_cost to its current value is a
        // no-op data-wise but guarantees the recompute runs.
        const { data: updated, error: updErr } = await supabase
          .from("flows")
          .update({
            markup_multiplier_override: parsedOverride,
            api_cost: Number(before.api_cost) || 0,
          })
          .eq("id", flow_id)
          .select("id, name, markup_multiplier_override, selling_price, contribution_margin, creator_payout, api_cost")
          .maybeSingle();
        if (updErr) throw updErr;
        if (!updated) throw new Error(`Flow ${flow_id} not found`);

        // Verify the trigger produced the requested selling_price (selling_price mode)
        if (mode === "selling_price") {
          const requested = Number(payloadSellingPrice);
          if (updated.selling_price !== requested) {
            console.warn(
              `[erp-bridge:set_flow_markup_override] selling_price mismatch: requested=${requested}, ` +
              `actual=${updated.selling_price}, override=${parsedOverride}, api_cost=${updated.api_cost}`,
            );
          }
        }

        try {
          await supabase.from("admin_audit_logs").insert({
            admin_user_id: admin_user_id ?? "00000000-0000-0000-0000-000000000000",
            action: "set_flow_markup_override",
            target_table: "flows",
            target_user_id: null,
            details: {
              admin_email: admin_user_email ?? null,
              flow_id,
              mode,
              requested_selling_price: hasSellingPrice ? Number(payloadSellingPrice) : null,
              before: before ?? null,
              after: {
                markup_multiplier_override: parsedOverride,
                selling_price: updated.selling_price,
                creator_payout: updated.creator_payout,
              },
            },
          });
        } catch (auditErr) {
          console.error("[ERP-BRIDGE] Audit log (set_flow_markup_override) failed:", auditErr);
        }

        result = { success: true, flow: updated, mode };
        break;
      }

      // ── Nano Banana global tier override (Standard / Flex throttle) ──
      case "get_nano_banana_tier_override": {
        const { data, error } = await supabase
          .from("subscription_settings")
          .select("value")
          .eq("key", "nano_banana_tier_override")
          .maybeSingle();
        if (error) throw error;
        result = { tier_override: (data?.value as string | undefined) ?? "auto" };
        break;
      }

      case "set_nano_banana_tier_override": {
        const { tier_override, admin_user_email, admin_user_id } = payload ?? {};
        const allowed = ["auto", "force_standard", "force_flex"];
        if (!allowed.includes(tier_override)) {
          return respond(false, { error: `tier_override must be one of: ${allowed.join(", ")}` });
        }

        const { error: upErr } = await supabase
          .from("subscription_settings")
          .upsert({ key: "nano_banana_tier_override", value: String(tier_override) }, { onConflict: "key" });
        if (upErr) throw upErr;

        try {
          await supabase.from("admin_audit_logs").insert({
            admin_user_id: admin_user_id ?? "00000000-0000-0000-0000-000000000000",
            action: "set_nano_banana_tier_override",
            target_table: "subscription_settings",
            details: { admin_email: admin_user_email ?? null, tier_override },
          });
        } catch (auditErr) {
          console.error("[ERP-BRIDGE] Audit log (set_nano_banana_tier_override) failed:", auditErr);
        }

        result = { success: true, tier_override };
        break;
      }

      // ── Recalculate ALL Flow Prices using current dynamic multipliers ──
      // Computes api_cost ON-THE-FLY from the flow's nodes + credit_costs table.
      // Does NOT skip flows where stored api_cost is 0 — recalculates from scratch.
      case "recalculate_all_prices": {
        const { admin_user_email, dry_run = false, statuses } = payload ?? {};
        const targetStatuses: string[] = Array.isArray(statuses) && statuses.length > 0
          ? statuses
          : ["published", "submitted"];

        // 1. Fetch LIVE multipliers from subscription_settings (no stale cache)
        const multipliers = await fetchFeatureMultipliers(supabase);

        // 2. Fetch all candidate flows (include settings for graph JSON)
        const { data: flows, error: flowsErr } = await supabase
          .from("flows")
          .select("id, name, status, api_cost, base_cost, selling_price, markup_multiplier, contribution_margin, creator_payout, settings")
          .in("status", targetStatuses);
        if (flowsErr) throw flowsErr;

        const flowList = (flows ?? []) as Array<{
          id: string; name: string; status: string;
          api_cost: number | null; base_cost: number | null;
          selling_price: number | null; markup_multiplier: number | null;
          contribution_margin: number | null; creator_payout: number | null;
          settings: unknown;
        }>;
        const flowIds = flowList.map((f) => f.id);

        // 3. Fetch flow_nodes for all flows in one round-trip (legacy fallback source)
        const { data: nodeRows, error: nodesErr } = flowIds.length > 0
          ? await supabase
              .from("flow_nodes")
              .select("flow_id, node_type, config")
              .in("flow_id", flowIds)
          : { data: [], error: null };
        if (nodesErr) throw nodesErr;

        const nodesByFlow = new Map<string, Array<{ node_type: string; config: Record<string, unknown> }>>();
        (nodeRows ?? []).forEach((n: { flow_id: string; node_type: string; config: Record<string, unknown> }) => {
          const arr = nodesByFlow.get(n.flow_id) ?? [];
          arr.push({ node_type: n.node_type, config: n.config });
          nodesByFlow.set(n.flow_id, arr);
        });

        let updatedCount = 0;
        let noActionNodesCount = 0;
        let writeNotConfirmedCount = 0;
        const processedFlowIds: string[] = [];
        const errors: Array<{ flow_id: string; flow_name?: string; error: string }> = [];
        const samples: Array<Record<string, unknown>> = [];
        const allMissingPricing: Array<{ flow_id: string; flow_name: string; missing: Array<{ type: string; reason: string }> }> = [];

        // 4. Per-flow: compute REAL api_cost from nodes + credit_costs
        for (const f of flowList) {
          try {
            const settingsGraph = f.settings && typeof f.settings === "object"
              ? (f.settings as { graph?: unknown }).graph
              : null;
            const flowNodeRows = nodesByFlow.get(f.id) ?? [];

            // Normalize nodes from settings.graph (preferred) or flow_nodes (fallback)
            const actionNodes = collectActionNodes(settingsGraph, flowNodeRows);

            // Only skip when there is literally nothing to price (no nodes at all).
            // Unknown node types are now handled inside computeFlowApiCost (default 0,
            // logged in missingPricing) instead of being skipped silently.
            if (actionNodes.length === 0) {
              noActionNodesCount += 1;
              errors.push({
                flow_id: f.id,
                flow_name: f.name,
                error: "No action nodes found in flow graph or flow_nodes table",
              });
              continue;
            }

            // Determine pricing category from action nodes (for multiplier selection)
            const category = determineFlowCategory(
              actionNodes.map((n) => ({ node_type: n.type })),
            );
            const multiplier = multipliers[category];

            // Compute total api_cost dynamically from credit_costs lookups.
            // Unknown / unpriced nodes default to 0 cost (and are logged) rather
            // than aborting the entire flow.
            const { apiCost, perNode, missingPricing } = await computeFlowApiCost(supabase, actionNodes);

            if (missingPricing.length > 0) {
              allMissingPricing.push({
                flow_id: f.id,
                flow_name: f.name,
                missing: missingPricing,
              });
            }

            // Recalculate selling_price, contribution_margin, creator_payout from REAL api_cost
            const calc = computePricing(apiCost, multiplier);

            // ── NO `isNoOp` skip ── Per architect spec, every flow must be
            // recalculated and written. The DB will store the same value if
            // nothing actually changed; this guarantees we never skip a flow
            // because a stale `null` api_cost happens to equal `Number(null) === 0`.

            if (samples.length < 10) {
              samples.push({
                flow_id: f.id,
                name: f.name,
                category,
                node_count: actionNodes.length,
                per_node: perNode,
                old: {
                  api_cost: f.api_cost,
                  selling_price: f.selling_price,
                  markup_multiplier: f.markup_multiplier,
                  creator_payout: f.creator_payout,
                },
                new: {
                  api_cost: calc.api_cost,
                  selling_price: calc.selling_price,
                  markup_multiplier: calc.markup_multiplier,
                  creator_payout: calc.creator_payout,
                },
              });
            }

            if (!dry_run) {
              // ── Force .select() to verify the update actually affected a row ──
              const { data: updatedRows, error: upErr } = await supabase
                .from("flows")
                .update({
                  api_cost: calc.api_cost,
                  base_cost: calc.api_cost,
                  markup_multiplier: calc.markup_multiplier,
                  selling_price: calc.selling_price,
                  contribution_margin: calc.contribution_margin,
                  creator_payout: calc.creator_payout,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", f.id)
                .select("id, api_cost, selling_price, markup_multiplier, contribution_margin, creator_payout");

              if (upErr) {
                console.error(`[ERP-BRIDGE] recalculate_all_prices update error for flow ${f.id}:`, upErr);
                throw upErr;
              }

              if (!updatedRows || updatedRows.length === 0) {
                writeNotConfirmedCount += 1;
                errors.push({
                  flow_id: f.id,
                  flow_name: f.name,
                  error: "DB update returned 0 rows — write not confirmed (possible RLS or stale id)",
                });
                continue;
              }
            }

            updatedCount += 1;
            processedFlowIds.push(f.id);
          } catch (e) {
            errors.push({
              flow_id: f.id,
              flow_name: f.name,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        // 5. Audit log
        try {
          await supabase.from("admin_audit_logs").insert({
            admin_user_id: payload?.admin_user_id ?? "00000000-0000-0000-0000-000000000000",
            action: dry_run ? "recalculate_all_prices_dry_run" : "recalculate_all_prices",
            target_table: "flows",
            details: {
              admin_email: admin_user_email ?? null,
              statuses: targetStatuses,
              multipliers,
              total_scanned: flowList.length,
              updated_count: updatedCount,
              no_action_nodes_count: noActionNodesCount,
              write_not_confirmed_count: writeNotConfirmedCount,
              error_count: errors.length,
              missing_pricing_count: allMissingPricing.length,
              samples,
            },
            ip_address: payload?.ip_address ?? null,
          });
        } catch (auditErr) {
          console.error("[ERP-BRIDGE] Audit log (recalculate_all_prices) failed:", auditErr);
        }

        result = {
          ok: true,
          dry_run,
          multipliers,
          total_scanned: flowList.length,
          updated_count: updatedCount,
          no_action_nodes_count: noActionNodesCount,
          write_not_confirmed_count: writeNotConfirmedCount,
          error_count: errors.length,
          processed_flow_ids: processedFlowIds,
          errors,
          missing_pricing: allMissingPricing,
          samples,
        };
        break;
      }

      // ── Flow Approval: Review Queue with filters (Phase 1 ERP support) ──
      // Same shape as `get_review_queue` but honors filters sent by ERP's
      // admin-api: status (single string or array), tier, include_published, limit.
      //
      // @todo tier filter — `flows.tier` column was dropped on 2026-04-03
      // (migration 20260403183850). Response always sets `tier: null` so ERP's
      // client-side tier filter returns 0 rows for Pro / Masterpiece selections.
      // Restore the column (or derive tier elsewhere) before enabling real
      // tier-based filtering.
      case "list_review_queue": {
        const p = payload ?? {};
        // status: accept string | string[] | null (null/undefined = no filter)
        const statusInput = p.status;
        const statusList: string[] | null = Array.isArray(statusInput)
          ? (statusInput as string[]).filter((s) => typeof s === "string" && s.length > 0)
          : typeof statusInput === "string" && statusInput.length > 0
            ? [statusInput]
            : null;
        const includePublished = Boolean(p.include_published);
        const rawLimit = Number(p.limit);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200;

        // Build the query. When no status filter is given, default to pending
        // (submitted + in_review) to mirror the ERP "pending_all" default and
        // avoid accidentally returning thousands of historical rows.
        const effectiveStatusList: string[] =
          statusList && statusList.length > 0
            ? includePublished && !statusList.includes("published")
              ? [...statusList, "published"]
              : statusList
            : includePublished
              ? ["submitted", "in_review", "published"]
              : ["submitted", "in_review"];

        let query = supabase
          .from("flows")
          .select("id, name, description, category, thumbnail_url, status, api_cost, base_cost, selling_price, markup_multiplier, markup_multiplier_override, contribution_margin, performance_bonus_percent, creator_payout, tags, user_id, settings, created_at, updated_at")
          .in("status", effectiveStatusList)
          .order("updated_at", { ascending: false })
          .limit(limit);

        const { data: flows, error } = await query;
        if (error) throw error;

        const flowList = (flows || []) as Array<Record<string, unknown>>;
        const userIds = Array.from(new Set(flowList.map((f) => f.user_id as string)));
        const flowIds = flowList.map((f) => f.id as string);

        const [profilesRes, flowNodesRes, multipliers] = await Promise.all([
          supabase
            .from("profiles")
            .select("user_id, display_name, avatar_url, is_official")
            .in("user_id", userIds),
          flowIds.length > 0
            ? supabase
                .from("flow_nodes")
                .select("flow_id, node_type, config")
                .in("flow_id", flowIds)
            : Promise.resolve({ data: [], error: null }),
          fetchFeatureMultipliers(supabase),
        ]);

        const profileMap = new Map(
          (profilesRes.data || []).map((pr: { user_id: string }) => [pr.user_id, pr]),
        );

        const nodesByFlow = new Map<string, Array<{ node_type: string; config: Record<string, unknown> | null }>>();
        for (const row of (flowNodesRes.data || []) as Array<{ flow_id: string; node_type: string; config: Record<string, unknown> | null }>) {
          const arr = nodesByFlow.get(row.flow_id) ?? [];
          arr.push({ node_type: row.node_type, config: row.config });
          nodesByFlow.set(row.flow_id, arr);
        }

        const enriched = await Promise.all(
          flowList.map(async (f) => {
            const settings = f.settings as Record<string, unknown> | null;
            const settingsGraph = settings?.graph ?? null;
            const actionNodes = collectActionNodes(
              settingsGraph,
              nodesByFlow.get(f.id as string) ?? [],
            );
            const { apiCost, perNode, missingPricing } = await computeFlowApiCost(
              supabase,
              actionNodes,
            );
            const category = determineFlowCategory(
              actionNodes.map((n) => ({ node_type: n.type })),
            );
            const overrideRaw = f.markup_multiplier_override;
            const override = overrideRaw === null || overrideRaw === undefined || overrideRaw === ""
              ? null
              : Number(overrideRaw);
            const effectiveMultiplier = override !== null && Number.isFinite(override) && override > 0
              ? override
              : multipliers[category];
            const calc = computePricing(apiCost, effectiveMultiplier);

            const { settings: _omit, ...rest } = f;
            return {
              ...rest,
              creator: profileMap.get(f.user_id as string) ?? null,
              tier: null, // see @todo above; column was dropped in migration 20260403183850
              api_cost: calc.api_cost,
              base_cost: calc.api_cost,
              selling_price: calc.selling_price,
              markup_multiplier: calc.markup_multiplier,
              contribution_margin: calc.contribution_margin,
              creator_payout: calc.creator_payout,
              pricing_category: category,
              pricing_per_node: perNode,
              pricing_warnings: missingPricing,
            };
          }),
        );

        result = enriched;
        break;
      }

      // ── Resolve Main admin_accounts.id from ERP admin email ──
      // Needed because Main's `submit_review` still requires a valid
      // admin_accounts.id (FK) as reviewer_id. ERP's admin-api tries this
      // action first to map its Supabase Auth user to the Main reviewer row.
      //
      // ⚠️ DEPENDENCY: this action reads from `admin_accounts`. The Phase 3
      // migration `20260422140000_drop_admin_accounts.sql` will remove that
      // table once applied — this action and `submit_review`'s email lookup
      // must both be updated (or removed) before that migration runs.
      case "lookup_admin_by_email":
      case "get_admin_by_email":
      case "resolve_admin_id": {
        const email = (payload?.email ?? payload?.admin_email ?? "") as string;
        if (!email) throw new Error("Missing email");
        const { data: adminRow, error: lookupErr } = await supabase
          .from("admin_accounts")
          .select("id, email, display_name, admin_role")
          .eq("email", String(email).toLowerCase().trim())
          .eq("is_active", true)
          .maybeSingle();
        if (lookupErr) throw lookupErr;
        if (!adminRow) {
          result = { id: null };
        } else {
          result = {
            id: adminRow.id,
            admin_id: adminRow.id,
            email: adminRow.email,
            display_name: adminRow.display_name,
            admin_role: adminRow.admin_role,
          };
        }
        break;
      }

      // ── Flow Badges: List ──────────────────────────────────
      case "list_flow_badges": {
        const flowId = payload?.flow_id as string | undefined;
        if (!flowId) throw new Error("Missing flow_id");
        const { data, error } = await supabase
          .from("flow_badges")
          .select("badge, assigned_by, created_at")
          .eq("flow_id", flowId)
          .order("created_at", { ascending: true });
        if (error) throw error;
        result = data ?? [];
        break;
      }

      // ── Flow Badges: Add ───────────────────────────────────
      case "add_flow_badge": {
        const flowId = payload?.flow_id as string | undefined;
        const badge = payload?.badge as string | undefined;
        const assignedBy = (payload?.assigned_by ?? null) as string | null;
        const assignedByEmail = (payload?.assigned_by_email ?? null) as string | null;
        const ALLOWED = ["official_flow", "top_performing", "enterprise_ready"];
        if (!flowId) throw new Error("Missing flow_id");
        if (!badge) throw new Error("Missing badge");
        if (!ALLOWED.includes(badge)) {
          throw new Error(`badge must be one of: ${ALLOWED.join(", ")}`);
        }
        const { data, error } = await supabase
          .from("flow_badges")
          .upsert(
            { flow_id: flowId, badge, assigned_by: assignedBy },
            { onConflict: "flow_id,badge" },
          )
          .select()
          .single();
        if (error) throw error;

        try {
          await supabase.from("admin_audit_logs").insert({
            admin_user_id: assignedBy ?? "00000000-0000-0000-0000-000000000000",
            action: "add_flow_badge",
            target_table: "flow_badges",
            details: { admin_email: assignedByEmail, flow_id: flowId, badge },
            ip_address: (payload?.ip_address ?? null) as string | null,
          });
        } catch (auditErr) {
          console.error("[ERP-BRIDGE] Audit log (add_flow_badge) failed:", auditErr);
        }

        result = data;
        break;
      }

      // ── Flow Badges: Remove ────────────────────────────────
      case "remove_flow_badge": {
        const flowId = payload?.flow_id as string | undefined;
        const badge = payload?.badge as string | undefined;
        const assignedBy = (payload?.assigned_by ?? null) as string | null;
        const assignedByEmail = (payload?.assigned_by_email ?? null) as string | null;
        if (!flowId) throw new Error("Missing flow_id");
        if (!badge) throw new Error("Missing badge");
        const { error } = await supabase
          .from("flow_badges")
          .delete()
          .eq("flow_id", flowId)
          .eq("badge", badge);
        if (error) throw error;

        try {
          await supabase.from("admin_audit_logs").insert({
            admin_user_id: assignedBy ?? "00000000-0000-0000-0000-000000000000",
            action: "remove_flow_badge",
            target_table: "flow_badges",
            details: { admin_email: assignedByEmail, flow_id: flowId, badge },
            ip_address: (payload?.ip_address ?? null) as string | null,
          });
        } catch (auditErr) {
          console.error("[ERP-BRIDGE] Audit log (remove_flow_badge) failed:", auditErr);
        }

        result = { success: true };
        break;
      }

      // ── Unpublish: revert published flow back to submitted ─
      // Accepts `set_flow_status` alias when payload.status === "submitted".
      // Notifies the creator and writes an audit log entry.
      case "unpublish_flow":
      case "set_flow_status": {
        const flowId = payload?.flow_id as string | undefined;
        const targetStatus = (payload?.status ?? "submitted") as string;
        const reason = (payload?.reason ?? "Admin unpublish") as string;
        const actorId = (payload?.actor_id ?? null) as string | null;
        const actorEmail = (payload?.actor_email ?? null) as string | null;
        if (!flowId) throw new Error("Missing flow_id");
        if (action === "set_flow_status" && targetStatus !== "submitted") {
          // Keep this action narrow — only the unpublish transition is supported
          // via the bridge today. Other transitions go through submit_review.
          throw new Error(
            `set_flow_status only supports status="submitted" via this action (received "${targetStatus}")`,
          );
        }

        const { data: updatedFlow, error: updErr } = await supabase
          .from("flows")
          .update({ status: "submitted", updated_at: new Date().toISOString() })
          .eq("id", flowId)
          .eq("status", "published")
          .select("id, name, user_id, status")
          .maybeSingle();
        if (updErr) throw updErr;
        if (!updatedFlow) {
          throw new Error(
            `Flow not unpublished — either flow_id "${flowId}" does not exist or its status is not "published".`,
          );
        }

        try {
          await supabase.from("notifications").insert({
            user_id: updatedFlow.user_id,
            type: "flow_review",
            title: "Flow Sent Back for Review",
            message: `Your flow "${updatedFlow.name}" has been unpublished and sent back for review.${reason ? ` Reason: ${reason}` : ""}`,
            icon: "alert-circle",
            link: "/creator/flows",
            metadata: { flow_id: flowId, action: "unpublished", reason },
          });
        } catch (notifyErr) {
          console.error("[ERP-BRIDGE] Notification insert failed (unpublish_flow):", notifyErr);
        }

        try {
          await supabase.from("admin_audit_logs").insert({
            admin_user_id: actorId ?? "00000000-0000-0000-0000-000000000000",
            action: "unpublish_flow",
            target_table: "flows",
            target_user_id: updatedFlow.user_id,
            details: { admin_email: actorEmail, flow_id: flowId, flow_name: updatedFlow.name, reason },
            ip_address: (payload?.ip_address ?? null) as string | null,
          });
        } catch (auditErr) {
          console.error("[ERP-BRIDGE] Audit log (unpublish_flow) failed:", auditErr);
        }

        result = { success: true, flow: updatedFlow };
        break;
      }


      default:
        return respond(false, `Unknown action: ${action}`);
    }

    return respond(true, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    const action = parsedBody?.action ?? "unknown";
    console.error(`[ERP-BRIDGE] Error in action="${action}":`, message);
    if (stack) console.error("[ERP-BRIDGE] Stack:", stack);
    return respond(false, {
      message,
      stage: `action:${action}`,
      payload_keys: parsedBody?.payload ? Object.keys(parsedBody.payload) : [],
    });
  }
});
