import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

/**
 * stripe-attach-payment-method
 *
 * Server confirmation hook called by the Plan & billing UI after the
 * Stripe Elements card form has confirmed a SetupIntent client-side.
 *
 * Why this function exists:
 *   - Stripe attaches the new PM to the customer automatically when
 *     the SetupIntent succeeds (we set customer + usage='off_session'
 *     in `stripe-payment-methods` op='setup_intent'), so an explicit
 *     attach is usually a no-op.
 *   - But we ALSO want to set the new PM as the customer's default
 *     for future invoices. Doing that on the client would require
 *     elevated keys; this server function uses the secret key.
 *   - We re-verify ownership server-side before mutating, so a
 *     stale/wrong client payload can't redirect billing away from a
 *     legitimate card.
 *
 * Body: { payment_method_id: string, set_default?: boolean }
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
    const pmId = String(body.payment_method_id || "");
    const setDefault = body.set_default !== false; // default to true
    if (!pmId) throw new Error("Missing payment_method_id");

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();

    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      // Cold path: SetupIntent creation already creates a customer,
      // so this branch is mostly defensive. Fall back to email lookup
      // / create.
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

    const pm = await stripe.paymentMethods.retrieve(pmId);

    // If the PM isn't on this customer yet (e.g. setup_intent flow
    // somehow skipped attachment), explicitly attach it. Idempotent
    // when already attached to the same customer; throws if attached
    // elsewhere — that throw is the protection we want.
    if (pm.customer !== customerId) {
      try {
        await stripe.paymentMethods.attach(pmId, { customer: customerId });
      } catch (err) {
        // Most common reason: PM already attached to a different
        // customer (e.g. someone reused a token). Don't leak the
        // upstream message to the client.
        console.error("[STRIPE-ATTACH-PM] attach failed:", err);
        throw new Error("Could not attach payment method to your account");
      }
    }

    if (setDefault) {
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: pmId },
      });
    }

    return new Response(
      JSON.stringify({ ok: true, payment_method_id: pmId, set_default: setDefault }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[STRIPE-ATTACH-PM] Error:", error instanceof Error ? error.message : error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    const status = msg.includes("authenticated") || msg.includes("Authorization") ? 401 : 500;
    return new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
