import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Auth: verify Supabase session + check admin/sales role ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResp(401, { error: "Unauthorized" });
    }

    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const {
      data: { user },
      error: authError,
    } = await anonClient.auth.getUser();
    if (authError || !user) {
      return jsonResp(401, { error: "Invalid session" });
    }

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: roleRow } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!roleRow || !["admin", "sales"].includes(roleRow.role)) {
      return jsonResp(403, { error: "Insufficient permissions" });
    }

    const body = await req.json();
    const { customer_email, plan_id, discount_percent, billing_cycle } = body;

    if (!customer_email || !plan_id) {
      return jsonResp(400, { error: "Missing customer_email or plan_id" });
    }

    // ── Read plan directly from DB ──
    const { data: plan, error: planError } = await adminClient
      .from("subscription_plans")
      .select("*")
      .eq("id", plan_id)
      .maybeSingle();

    if (planError || !plan) {
      return jsonResp(404, { error: "Plan not found" });
    }

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) {
      return jsonResp(500, { error: "Stripe not configured" });
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });

    const monthlyPrice = Number(plan.price_thb) || 0;
    const months =
      billing_cycle === "3_months" ? 3 : billing_cycle === "6_months" ? 6 : 12;
    const baseTotal = monthlyPrice * months;
    const discountPct = Number(discount_percent) || 0;
    const finalPrice = Math.max(0, baseTotal * (1 - discountPct / 100));
    const unitAmount = Math.max(1, Math.round(finalPrice * 100)); // satang

    if (finalPrice <= 0) {
      return jsonResp(400, {
        error: `Invalid price: discount ${discountPct}% makes price zero or negative`,
      });
    }

    const upfrontCredits = plan.upfront_credits || 0;
    const totalCredits = upfrontCredits * months;
    const cycleLabel =
      billing_cycle === "3_months"
        ? "3 เดือน"
        : billing_cycle === "6_months"
          ? "6 เดือน"
          : "12 เดือน";

    const origin =
      req.headers.get("origin") ||
      req.headers.get("referer")?.replace(/\/[^/]*$/, "") ||
      "https://mediaforge.co";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email,
      payment_method_types: ["promptpay", "card"],
      success_url: `${origin}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/subscriptions`,
      line_items: [
        {
          price_data: {
            currency: "thb",
            product_data: {
              name: `${plan.name} Plan — Direct Sales (${cycleLabel})`,
              description: `MediaForge ${plan.name} — ${cycleLabel} prepaid`,
            },
            unit_amount: unitAmount,
          },
          quantity: 1,
        },
      ],
      metadata: {
        customer_email,
        plan_id,
        plan_name: plan.name,
        billing_cycle,
        months: String(months),
        total_credits: String(totalCredits),
        credits: String(totalCredits),
        discount_percent: String(discountPct),
        price_thb: String(finalPrice),
        direct_sales: "true",
      },
    });

    // ── Audit log (non-blocking) ──
    try {
      await adminClient.from("admin_audit_logs").insert({
        admin_user_id: user.id,
        action: "generate_stripe_link",
        target_user_id: null,
        details: {
          target_email: customer_email,
          plan_name: plan.name,
          billing_cycle,
          discount_percent: discountPct,
          final_price: finalPrice,
          total_credits: totalCredits,
        },
      });
    } catch (_) {
      // Non-blocking
    }

    return jsonResp(200, { url: session.url });
  } catch (error: any) {
    console.error("[generate-stripe-link] Error:", error);
    return jsonResp(500, { error: error.message });
  }
});
