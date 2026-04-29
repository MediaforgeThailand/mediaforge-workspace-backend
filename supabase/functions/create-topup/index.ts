import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { rejectIfOrgUser } from "../_shared/orgUserGuard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const orgBlock = await rejectIfOrgUser(req);
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

    const { packageId, embedded = false, intent = false } = await req.json();
    if (!packageId || typeof packageId !== "string") throw new Error("Missing packageId");

    // Fetch top-up package
    const { data: pkg, error: pkgError } = await supabaseAdmin
      .from("topup_packages")
      .select("id, name, credits, price_thb, stripe_price_id, is_active, one_time_per_user")
      .eq("id", packageId)
      .eq("is_active", true)
      .single();

    if (pkgError || !pkg) {
      return new Response(JSON.stringify({ error: "Package not found or inactive" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (!pkg.stripe_price_id) {
      return new Response(JSON.stringify({ error: "No Stripe price configured for this top-up" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Enforce one-time-per-user purchases (e.g. welcome promo)
    if (pkg.one_time_per_user) {
      const { count: redeemed } = await supabaseAdmin
        .from("topup_redemptions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("topup_package_id", pkg.id);
      if ((redeemed ?? 0) > 0) {
        return new Response(
          JSON.stringify({ error: "ALREADY_REDEEMED", message: "You have already redeemed this offer." }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    // Get or create Stripe customer
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .single();

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
        await supabaseAdmin.from("profiles").update({ stripe_customer_id: customerId }).eq("user_id", user.id);
      }
    }

    const metadata = {
      user_id: user.id,
      topup_package_id: pkg.id,
      credits: pkg.credits.toString(),
      type: "topup",
    };

    // ── In-app PaymentIntent flow (Stripe Elements) ──
    if (intent) {
      // Ensure we have a Stripe customer (required for PromptPay attachment in some flows)
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          metadata: { supabase_user_id: user.id },
        });
        customerId = customer.id;
        await supabaseAdmin.from("profiles").update({ stripe_customer_id: customerId }).eq("user_id", user.id);
      }

      const amountSatang = Math.round(Number(pkg.price_thb) * 100);
      const pi = await stripe.paymentIntents.create({
        amount: amountSatang,
        currency: "thb",
        customer: customerId,
        payment_method_types: ["promptpay", "card"],
        metadata,
      });

      console.log(`[CREATE-TOPUP] PaymentIntent created ${pi.id} for ${pkg.name}`);

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

    const sessionParams: any = {
      customer: customerId || undefined,
      customer_email: customerId ? undefined : user.email,
      line_items: [{ price: pkg.stripe_price_id, quantity: 1 }],
      mode: "payment",
      metadata,
    };

    if (embedded) {
      sessionParams.ui_mode = "embedded";
      sessionParams.return_url = `${req.headers.get("origin")}/app/pricing?topup=success`;
    } else {
      sessionParams.success_url = `${req.headers.get("origin")}/app/pricing?topup=success`;
      sessionParams.cancel_url = `${req.headers.get("origin")}/app/pricing?topup=cancelled`;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    console.log(`[CREATE-TOPUP] Session created for user ${user.id}, package ${pkg.name}, credits ${pkg.credits}`);

    const responseBody = embedded
      ? { clientSecret: session.client_secret }
      : { url: session.url };

    return new Response(JSON.stringify(responseBody), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[CREATE-TOPUP] Error:", error instanceof Error ? error.message : error);
    const msg = error instanceof Error ? error.message : "";
    const safeMessages = ["User not authenticated", "Missing packageId"];
    const clientMsg = safeMessages.includes(msg) ? msg : "Top-up checkout failed. Please try again.";
    return new Response(JSON.stringify({ error: clientMsg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
