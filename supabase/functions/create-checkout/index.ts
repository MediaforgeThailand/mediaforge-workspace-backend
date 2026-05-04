import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { rejectIfOrgUser } from "../_shared/orgUserGuard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const TEAM_SEAT_PRICE_THB = 1600;
const TEAM_SEAT_PLATFORM_FEE_THB = 300;
const WORKSPACE_CREDITS_PER_THB = 50;
const TEAM_BASE_CREDITS_PER_SEAT_MONTH =
  (TEAM_SEAT_PRICE_THB - TEAM_SEAT_PLATFORM_FEE_THB) * WORKSPACE_CREDITS_PER_THB;
const TEAM_PROMO_CREDITS_PER_SEAT_MONTH = 25_000;
const TEAM_CREDITS_PER_SEAT_MONTH =
  TEAM_BASE_CREDITS_PER_SEAT_MONTH + TEAM_PROMO_CREDITS_PER_SEAT_MONTH;
const TEAM_MIN_SEATS = 2;
const TEAM_MAX_SEATS = 500;
const TEAM_ANNUAL_DISCOUNT = 0.2;

type CheckoutPaymentMethod = "promptpay" | "card" | "auto";

function normalizePaymentMethod(value: unknown): CheckoutPaymentMethod {
  return value === "promptpay" || value === "card" ? value : "auto";
}

function paymentMethodTypes(method: CheckoutPaymentMethod): Array<"promptpay" | "card"> {
  if (method === "card") return ["card"];
  if (method === "auto") return ["promptpay", "card"];
  return ["promptpay"];
}

function promptPayQrPayload(intent: Stripe.PaymentIntent) {
  const qr = intent.next_action?.promptpay_display_qr_code;
  return {
    qrCodeSvgUrl: qr?.image_url_svg ?? null,
    qrCodePngUrl: qr?.image_url_png ?? null,
    expiresAt: qr?.expires_at ?? null,
  };
}

async function confirmPromptPayIntent(
  stripe: Stripe,
  paymentIntentId: string,
  email: string,
  returnUrl: string,
) {
  return await stripe.paymentIntents.confirm(paymentIntentId, {
    payment_method_data: {
      type: "promptpay",
      billing_details: { email },
    },
    return_url: returnUrl,
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid checkout request" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const checkoutType = typeof body.checkoutType === "string" ? body.checkoutType : "";
  const orgBlock = checkoutType === "team_seats" ? null : await rejectIfOrgUser(req);
  if (orgBlock) return orgBlock;

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

    const { packageId, billingInterval = "monthly", embedded = false, intent = false } = body as {
      packageId?: unknown;
      billingInterval?: unknown;
      embedded?: unknown;
      intent?: unknown;
    };
    const paymentMethod = normalizePaymentMethod((body as { paymentMethod?: unknown }).paymentMethod);
    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    if (checkoutType === "team_seats") {
      if (!["monthly", "annual"].includes(String(billingInterval))) throw new Error("Invalid billingInterval");

      const { data: activeMemberships, error: membershipError } = await supabaseAdmin
        .from("organization_memberships")
        .select("role,status,organizations!inner(type)")
        .eq("user_id", user.id)
        .eq("status", "active");
      if (membershipError) throw new Error(`Team checkout membership lookup failed: ${membershipError.message}`);
      const activeRows = (activeMemberships ?? []) as Array<{
        role?: string | null;
        organizations?: { type?: string | null } | Array<{ type?: string | null }> | null;
      }>;
      const hasSelfServeTeamAdmin = activeRows.some((row) => {
        const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
        return org?.type === "team" && row.role === "org_admin";
      });
      const hasNonTeamOrg = activeRows.some((row) => {
        const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
        return org?.type && org.type !== "team";
      });
      if (hasNonTeamOrg && !hasSelfServeTeamAdmin) {
        throw new Error("Team checkout is available for personal accounts or existing team admins");
      }

      const requestedSeats = Math.trunc(Number((body as { teamSeats?: unknown }).teamSeats));
      if (!Number.isFinite(requestedSeats) || requestedSeats < TEAM_MIN_SEATS || requestedSeats > TEAM_MAX_SEATS) {
        throw new Error(`Team checkout requires ${TEAM_MIN_SEATS}-${TEAM_MAX_SEATS} seats`);
      }

      const billingCycle = String(billingInterval) as "monthly" | "annual";
      const cycleMonths = billingCycle === "annual" ? 12 : 1;
      const grossThb = requestedSeats * TEAM_SEAT_PRICE_THB * cycleMonths;
      const amountThb = billingCycle === "annual"
        ? Math.round(grossThb * (1 - TEAM_ANNUAL_DISCOUNT))
        : grossThb;
      const amountSatang = amountThb * 100;
      const baseCredits = requestedSeats * TEAM_BASE_CREDITS_PER_SEAT_MONTH * cycleMonths;
      const promoCredits = requestedSeats * TEAM_PROMO_CREDITS_PER_SEAT_MONTH * cycleMonths;
      const totalCredits = baseCredits + promoCredits;

      const { data: profile } = await supabaseAdmin
        .from("profiles")
        .select("stripe_customer_id, display_name, full_name")
        .eq("user_id", user.id)
        .single();

      let customerId = profile?.stripe_customer_id ?? null;
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
            name: String(profile?.display_name ?? profile?.full_name ?? user.user_metadata?.full_name ?? ""),
            metadata: { supabase_user_id: user.id },
          });
          customerId = customer.id;
        }
        await supabaseAdmin.from("profiles").update({ stripe_customer_id: customerId }).eq("user_id", user.id);
      }

      const teamMetadata = {
        type: "team_seat_purchase",
        user_id: user.id,
        buyer_email: user.email,
        buyer_name: String(profile?.display_name ?? profile?.full_name ?? user.user_metadata?.full_name ?? ""),
        seat_count: String(requestedSeats),
        billing_cycle: billingCycle,
        cycle_months: String(cycleMonths),
        amount_thb: String(amountThb),
        seat_price_thb: String(TEAM_SEAT_PRICE_THB),
        seat_platform_fee_thb: String(TEAM_SEAT_PLATFORM_FEE_THB),
        base_credits_per_seat_month: String(TEAM_BASE_CREDITS_PER_SEAT_MONTH),
        promo_credits_per_seat_month: String(TEAM_PROMO_CREDITS_PER_SEAT_MONTH),
        credits_per_seat_month: String(TEAM_CREDITS_PER_SEAT_MONTH),
        base_credits: String(baseCredits),
        promo_credits: String(promoCredits),
        total_credits: String(totalCredits),
      };

      if (intent !== true) {
        const origin = req.headers.get("origin") || "https://workspace.mediaforge.co";
        const session = await stripe.checkout.sessions.create({
          customer: customerId,
          client_reference_id: user.id,
          line_items: [
            {
              price_data: {
                currency: "thb",
                product_data: {
                  name: `Workspace Team - ${requestedSeats} seats`,
                  description: `${totalCredits.toLocaleString()} shared credits (${billingCycle})`,
                },
                unit_amount: amountSatang,
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          payment_method_types: paymentMethodTypes(paymentMethod),
          metadata: teamMetadata,
          payment_intent_data: { metadata: teamMetadata },
          success_url: `${origin}/app/pricing?payment=success`,
          cancel_url: `${origin}/app/pricing?payment=cancelled`,
        });

        return new Response(JSON.stringify({ url: session.url }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const pi = await stripe.paymentIntents.create({
        amount: amountSatang,
        currency: "thb",
        customer: customerId,
        payment_method_types: paymentMethodTypes(paymentMethod),
        metadata: teamMetadata,
      });

      console.log(`[CREATE-CHECKOUT] Team seat PaymentIntent created ${pi.id}: seats=${requestedSeats}, cycle=${billingCycle}, credits=${totalCredits}`);

      if (paymentMethod === "promptpay") {
        const origin = req.headers.get("origin") || "https://workspace.mediaforge.co";
        const confirmed = await confirmPromptPayIntent(
          stripe,
          pi.id,
          user.email,
          `${origin}/app/pricing?payment=success`,
        );
        return new Response(
          JSON.stringify({
            clientSecret: confirmed.client_secret,
            paymentIntentId: confirmed.id,
            amount: amountSatang,
            currency: "thb",
            seats: requestedSeats,
            creditsTotal: totalCredits,
            paymentMethod: "promptpay",
            ...promptPayQrPayload(confirmed),
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          clientSecret: pi.client_secret,
          paymentIntentId: pi.id,
          amount: amountSatang,
          currency: "thb",
          seats: requestedSeats,
          creditsTotal: totalCredits,
          paymentMethod,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!packageId || typeof packageId !== "string") throw new Error("Missing packageId");
    const planBillingInterval = String(billingInterval) as "monthly" | "annual";
    if (!["monthly", "annual"].includes(planBillingInterval)) throw new Error("Invalid billingInterval");

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

    // Resolve price + credits per requested billingInterval. Workspace plans expose
    // separate stripe_price_id_monthly and stripe_price_id_annual columns; falling back
    // to the legacy single stripe_price_id keeps backwards compatibility with consumer fork rows.
    const priceId =
      planBillingInterval === "annual"
        ? (plan.stripe_price_id_annual ?? null)
        : (plan.stripe_price_id_monthly ?? plan.stripe_price_id ?? null);

    if (!priceId) {
      return new Response(
        JSON.stringify({ error: `No Stripe price configured for this plan (${planBillingInterval})` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // CRITICAL: validate credits BEFORE creating session — prevents zero-credit grant downstream
    const upfrontCredits = Number(
      planBillingInterval === "annual" && plan.annual_credits != null
        ? plan.annual_credits
        : plan.upfront_credits
    );
    if (!Number.isFinite(upfrontCredits) || upfrontCredits <= 0) {
      console.error("[CREATE-CHECKOUT] Invalid credits for plan:", plan.id, "cycle:", planBillingInterval);
      return new Response(JSON.stringify({ error: "Plan misconfigured (no credits)" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    console.log(`[CREATE-CHECKOUT] Plan: ${plan.name} (${plan.target}/${planBillingInterval}), Price: ${priceId}, Credits: ${upfrontCredits}`);

    // ── First-time subscriber 40% discount (Lite plan only) ──
    // "First-time SUBSCRIBER" = user has no completed payment_transactions row
    // whose package_id points to any row in subscription_plans. Top-ups
    // (which also live in payment_transactions but reference topup_packages)
    // do NOT disqualify a user from the Lite first-subscription discount.
    // Coupon `5NOgQ3VT` is a Stripe coupon (40% off, duration=once).
    const FIRST_TIME_COUPON = "5NOgQ3VT";
    const FIRST_TIME_DISCOUNT_PCT = 40;
    let applyFirstTimeDiscount = false;
    if (plan.name === "Lite") {
      const { data: subPlanIdRows } = await supabaseAdmin
        .from("subscription_plans")
        .select("id");
      const subPlanIds = (subPlanIdRows ?? []).map((r: { id: string }) => r.id);

      let priorSubs = 0;
      if (subPlanIds.length > 0) {
        const { count } = await supabaseAdmin
          .from("payment_transactions")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .eq("status", "completed")
          .in("package_id", subPlanIds);
        priorSubs = count ?? 0;
      }

      if (priorSubs === 0) {
        applyFirstTimeDiscount = true;
        console.log(`[CREATE-CHECKOUT] First-time Lite subscriber (no prior plan payment) — applying ${FIRST_TIME_DISCOUNT_PCT}% off`);
      } else {
        console.log(`[CREATE-CHECKOUT] User has ${priorSubs} prior subscription payment(s) — Lite discount skipped`);
      }
    }

    // Get or create Stripe customer
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("stripe_customer_id, current_plan_id, subscription_status")
      .eq("user_id", user.id)
      .single();

    // Block downgrade — but always allow Lite (entry tier; downgrade-to-Lite
    // beats churning out entirely).
    if (profile?.current_plan_id && plan.name !== "Lite") {
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

    // LOCKED metadata convention — webhook reads `upfront_credits` + `billing_cycle`
    const metadata: Record<string, string> = {
      user_id: user.id,
      plan_id: plan.id,
      plan_name: plan.name,
      plan_target: plan.target,
      // `billing_cycle` here reflects the user's chosen cadence (monthly|annual),
      // NOT plan.billing_cycle (which can be 'metered' for Team).
      billing_cycle: planBillingInterval,
      upfront_credits: upfrontCredits.toString(),
      type: "subscription_oneoff",
    };

    // ── In-app PaymentIntent flow (Stripe Elements, PromptPay + Card) ──
    if (intent) {
      // Annual support (from team's pricing redesign): use annual_price_thb
      // when the user picked annual billing, else fall back to monthly.
      const baseThb =
        planBillingInterval === "annual" && plan.annual_price_thb != null
          ? Number(plan.annual_price_thb)
          : Number(plan.price_thb);
      const baseAmountSatang = Math.round(baseThb * 100);
      if (!Number.isFinite(baseAmountSatang) || baseAmountSatang <= 0) {
        return new Response(JSON.stringify({ error: "Plan misconfigured (invalid price)" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // PaymentIntent doesn't natively support coupons — discount the amount inline.
      const amountSatang = applyFirstTimeDiscount
        ? Math.round(baseAmountSatang * (1 - FIRST_TIME_DISCOUNT_PCT / 100))
        : baseAmountSatang;

      const piMetadata = applyFirstTimeDiscount
        ? { ...metadata, first_time_discount_pct: String(FIRST_TIME_DISCOUNT_PCT), original_amount_satang: String(baseAmountSatang) }
        : metadata;

      const pi = await stripe.paymentIntents.create({
        amount: amountSatang,
        currency: "thb",
        customer: customerId,
        payment_method_types: paymentMethodTypes(paymentMethod),
        metadata: piMetadata,
      });

      console.log(`[CREATE-CHECKOUT] PaymentIntent created ${pi.id} for plan ${plan.name}`);

      if (paymentMethod === "promptpay") {
        const origin = req.headers.get("origin") || "https://workspace.mediaforge.co";
        const confirmed = await confirmPromptPayIntent(
          stripe,
          pi.id,
          user.email,
          `${origin}/app/pricing?payment=success`,
        );
        return new Response(
          JSON.stringify({
            clientSecret: confirmed.client_secret,
            paymentIntentId: confirmed.id,
            amount: amountSatang,
            currency: "thb",
            paymentMethod: "promptpay",
            ...promptPayQrPayload(confirmed),
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          clientSecret: pi.client_secret,
          paymentIntentId: pi.id,
          amount: amountSatang,
          currency: "thb",
          paymentMethod,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // mode=payment with PromptPay first, then card. One-off payment, not recurring subscription.
    const origin = req.headers.get("origin") || "https://workspace.mediaforge.co";
    const sessionBaseThb =
      planBillingInterval === "annual" && plan.annual_price_thb != null
        ? Number(plan.annual_price_thb)
        : Number(plan.price_thb);
    const sessionBaseAmountSatang = Math.round(sessionBaseThb * 100);
    if (!Number.isFinite(sessionBaseAmountSatang) || sessionBaseAmountSatang <= 0) {
      return new Response(JSON.stringify({ error: "Plan misconfigured (invalid price)" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const sessionAmountSatang = applyFirstTimeDiscount
      ? Math.max(100, Math.round(sessionBaseAmountSatang * (1 - FIRST_TIME_DISCOUNT_PCT / 100)))
      : sessionBaseAmountSatang;
    const sessionParams: any = {
      customer: customerId,
      client_reference_id: user.id,
      line_items: [
        {
          price_data: {
            currency: "thb",
            product_data: {
              name: `MediaForge ${plan.name}`,
              description: `${upfrontCredits.toLocaleString()} credits (${planBillingInterval})`,
            },
            unit_amount: sessionAmountSatang,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      payment_method_types: paymentMethodTypes(paymentMethod),
      metadata,
      payment_intent_data: {
        // Mirror metadata onto PaymentIntent so payment_intent.succeeded webhook works for async PromptPay
        metadata: applyFirstTimeDiscount
          ? { ...metadata, first_time_discount_pct: String(FIRST_TIME_DISCOUNT_PCT) }
          : metadata,
      },
    };

    if (embedded) {
      sessionParams.ui_mode = "embedded";
      sessionParams.return_url = `${origin}/app/pricing?payment=success`;
    } else {
      sessionParams.success_url = `${origin}/app/pricing?payment=success`;
      sessionParams.cancel_url = `${origin}/app/pricing?payment=cancelled`;
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
    const safeMessages = [
      "User not authenticated",
      "Missing packageId",
      "Invalid billingInterval",
      "Invalid checkout request",
      "Team checkout requires in-app payment",
      "Team checkout is available for personal accounts or existing team admins",
      `Team checkout requires ${TEAM_MIN_SEATS}-${TEAM_MAX_SEATS} seats`,
    ];
    const clientMsg = safeMessages.includes(msg) ? msg : "Checkout failed. Please try again.";
    return new Response(JSON.stringify({ error: clientMsg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
