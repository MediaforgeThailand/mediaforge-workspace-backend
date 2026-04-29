import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

/**
 * stripe-payment-methods
 *
 * Combined RPC for the "Payment details" section on Plan & billing.
 *
 * Operations are dispatched via the `op` field in the request body.
 * Keeping them in one function (instead of three deploys) cuts cold-
 * start cost on a screen that fires "list" on mount and "set_default"
 * /"detach" on user actions.
 *
 *   { op: "list" }
 *     → { payment_methods, default_payment_method_id, customer_id }
 *   { op: "set_default", payment_method_id }
 *     → { ok: true }
 *   { op: "detach", payment_method_id }
 *     → { ok: true }
 *   { op: "setup_intent" }
 *     → { client_secret } — used by the Card add-form (Stripe Elements
 *         confirmCardSetup) to attach a new card without an immediate
 *         charge.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
  );
  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing Authorization header");
    const token = authHeader.replace("Bearer ", "");
    const { data: userData } = await supabaseClient.auth.getUser(token);
    const user = userData.user;
    if (!user?.email) throw new Error("User not authenticated");

    const body = await req.json().catch(() => ({}));
    const op = String(body.op || "list");

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    // Resolve or create the customer. We mirror the create-checkout
    // logic so a user without prior payment activity can still attach
    // a card from this surface.
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();

    let customerId: string | null = profile?.stripe_customer_id ?? null;
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
      await supabaseAdmin
        .from("profiles")
        .update({ stripe_customer_id: customerId })
        .eq("user_id", user.id);
    }

    if (op === "list") {
      // Fetch card + promptpay PMs in parallel — Stripe doesn't return
      // both via a single `type` query, so two calls are unavoidable.
      const [cardRes, promptpayRes, customer] = await Promise.all([
        stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 20 }),
        stripe.paymentMethods.list({ customer: customerId, type: "promptpay", limit: 5 }),
        stripe.customers.retrieve(customerId),
      ]);

      const allMethods = [...cardRes.data, ...promptpayRes.data].map((pm) => ({
        id: pm.id,
        type: pm.type,
        // Card fields — null for promptpay rows.
        brand: pm.card?.brand ?? null,
        last4: pm.card?.last4 ?? null,
        exp_month: pm.card?.exp_month ?? null,
        exp_year: pm.card?.exp_year ?? null,
        // Funding helps the UI label "credit" vs "debit" if we want.
        funding: pm.card?.funding ?? null,
      }));

      const defaultPmId =
        (customer as Stripe.Customer).invoice_settings?.default_payment_method ?? null;
      const defaultId = typeof defaultPmId === "string" ? defaultPmId : (defaultPmId as any)?.id ?? null;

      return new Response(
        JSON.stringify({
          customer_id: customerId,
          default_payment_method_id: defaultId,
          payment_methods: allMethods,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (op === "set_default") {
      const pmId = String(body.payment_method_id || "");
      if (!pmId) throw new Error("Missing payment_method_id");
      // Verify the PM actually belongs to this customer before
      // mutating — prevents a malicious caller from attaching another
      // user's PM to themselves.
      const pm = await stripe.paymentMethods.retrieve(pmId);
      if (pm.customer !== customerId) throw new Error("Payment method does not belong to this customer");
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: pmId },
      });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (op === "detach") {
      const pmId = String(body.payment_method_id || "");
      if (!pmId) throw new Error("Missing payment_method_id");
      const pm = await stripe.paymentMethods.retrieve(pmId);
      if (pm.customer !== customerId) throw new Error("Payment method does not belong to this customer");
      await stripe.paymentMethods.detach(pmId);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (op === "setup_intent") {
      // Create a SetupIntent so the frontend can confirm a card via
      // Stripe Elements without charging anything. usage='off_session'
      // marks the resulting PM as reusable for future automatic
      // top-ups / subscription renewals.
      const intent = await stripe.setupIntents.create({
        customer: customerId,
        payment_method_types: ["card"],
        usage: "off_session",
      });
      return new Response(
        JSON.stringify({ client_secret: intent.client_secret, customer_id: customerId }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ error: `Unknown op: ${op}` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[STRIPE-PAYMENT-METHODS] Error:", error instanceof Error ? error.message : error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    const status = msg.includes("authenticated") || msg.includes("Authorization") ? 401 : 500;
    return new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
