import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? ""
  );

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  try {
    const authHeader = req.headers.get("Authorization")!;
    const token = authHeader.replace("Bearer ", "");
    const { data } = await supabaseClient.auth.getUser(token);
    const user = data.user;
    if (!user?.email) throw new Error("User not authenticated");

    const { packageId, billingInterval = "monthly", embedded = false, intent = false } = await req.json();
    if (!packageId || typeof packageId !== "string") throw new Error("Missing packageId");
    if (!["monthly", "annual"].includes(billingInterval)) throw new Error("Invalid billingInterval");

    // Fetch subscription plan
    const { data: plan, error: planError } = await supabaseAdmin
      .from("subscription_plans")
      .select("*")
      .eq("id", packageId)
      .eq("is_active", true)
      .single();

    if (planError || !plan) {
      console.error("[CREATE-CHECKOUT] Plan not found:", packageId, planError);
      return new Response(JSON.stringify({ error: "Plan not found or inactive" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const priceId = plan.stripe_price_id;
    if (!priceId) {
      return new Response(JSON.stringify({ error: `No Stripe price configured for this plan` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // CRITICAL: validate upfront_credits BEFORE creating session — prevents zero-credit grant downstream
    const upfrontCredits = Number(plan.upfront_credits);
    if (!Number.isFinite(upfrontCredits) || upfrontCredits <= 0) {
      console.error("[CREATE-CHECKOUT] Invalid plan.upfront_credits:", plan.upfront_credits, "for plan", plan.id);
      return new Response(JSON.stringify({ error: "Plan misconfigured (no credits)" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    console.log(`[CREATE-CHECKOUT] Plan: ${plan.name} (${plan.target}/${plan.billing_cycle}), Price: ${priceId}, Credits: ${upfrontCredits}`);

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    // Get or create Stripe customer
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("stripe_customer_id, current_plan_id, subscription_status")
      .eq("user_id", user.id)
      .single();

    // Block downgrade
    if (profile?.current_plan_id) {
      const { data: currentPlan } = await supabaseAdmin
        .from("subscription_plans")
        .select("sort_order")
        .eq("id", profile.current_plan_id)
        .single();
      if (currentPlan && plan.sort_order < currentPlan.sort_order) {
        return new Response(JSON.stringify({ error: "Cannot downgrade. Please choose a higher plan." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    let customerId = profile?.stripe_customer_id;
    if (customerId) {
      try {
        await stripe.customers.retrieve(customerId);
      } catch {
        customerId = null;
        await supabaseAdmin.from("profiles").update({ stripe_customer_id: null }).eq("user_id", user.id);
      }
    }
    if (!customerId) {
      const customers = await stripe.customers.list({ email: user.email, limit: 1 });
      if (customers.data.length > 0) {
        customerId = customers.data[0].id;
      } else {
        const customer = await stripe.customers.create({
          email: user.email,
          metadata: { supabase_user_id: user.id },
        });
        customerId = customer.id;
      }
      await supabaseAdmin.from("profiles").update({ stripe_customer_id: customerId }).eq("user_id", user.id);
    }

    // LOCKED metadata convention — webhook reads `upfront_credits`
    const metadata: Record<string, string> = {
      user_id: user.id,
      plan_id: plan.id,
      plan_name: plan.name,
      plan_target: plan.target,
      billing_cycle: plan.billing_cycle,
      upfront_credits: upfrontCredits.toString(),
      type: "subscription_oneoff",
    };

    // ── In-app PaymentIntent flow (Stripe Elements, PromptPay + Card) ──
    if (intent) {
      const amountSatang = Math.round(Number(plan.price_thb) * 100);
      if (!Number.isFinite(amountSatang) || amountSatang <= 0) {
        return new Response(JSON.stringify({ error: "Plan misconfigured (invalid price)" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const pi = await stripe.paymentIntents.create({
        amount: amountSatang,
        currency: "thb",
        customer: customerId,
        payment_method_types: ["promptpay", "card"],
        metadata,
      });

      console.log(`[CREATE-CHECKOUT] PaymentIntent created ${pi.id} for plan ${plan.name}`);

      return new Response(
        JSON.stringify({
          clientSecret: pi.client_secret,
          paymentIntentId: pi.id,
          amount: amountSatang,
          currency: "thb",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // mode=payment with PromptPay first, then card. One-off payment, not recurring subscription.
    const sessionParams: any = {
      customer: customerId,
      client_reference_id: user.id,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "payment",
      payment_method_types: ["promptpay", "card"],
      metadata,
      payment_intent_data: {
        // Mirror metadata onto PaymentIntent so payment_intent.succeeded webhook works for async PromptPay
        metadata,
      },
    };

    if (embedded) {
      sessionParams.ui_mode = "embedded";
      sessionParams.return_url = `${req.headers.get("origin")}/app/pricing?payment=success`;
    } else {
      sessionParams.success_url = `${req.headers.get("origin")}/app/pricing?payment=success`;
      sessionParams.cancel_url = `${req.headers.get("origin")}/app/pricing?payment=cancelled`;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    const responseBody = embedded
      ? { clientSecret: session.client_secret }
      : { url: session.url };

    return new Response(JSON.stringify(responseBody), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[CREATE-CHECKOUT] Error:", error instanceof Error ? error.message : error);
    const msg = error instanceof Error ? error.message : "";
    const safeMessages = ["User not authenticated", "Missing packageId", "Invalid billingInterval"];
    const clientMsg = safeMessages.includes(msg) ? msg : "Checkout failed. Please try again.";
    return new Response(JSON.stringify({ error: clientMsg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
