import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { rejectIfOrgUser } from "../_shared/orgUserGuard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response(null, { headers: corsHeaders });

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
    // Auth
    const authHeader = req.headers.get("Authorization")!;
    const token = authHeader.replace("Bearer ", "");
    const { data } = await supabaseClient.auth.getUser(token);
    const user = data.user;
    if (!user?.email) throw new Error("User not authenticated");

    /* Accept either:
     *   { packageId }  — legacy preset path (looks up topup_packages)
     *   { amountThb }  — custom-amount path (no DB lookup, fixed
     *                    1 THB = 25 credits ratio, min 500 THB)
     *
     * Both paths converge on a single PaymentIntent with PromptPay
     * as the only payment_method_type. Metadata.credits is always
     * populated so the webhook (`intentType === "promptpay_topup"`)
     * grants the correct amount regardless of which path was taken.
     */
    const { packageId, amountThb: rawAmountThb } = await req.json();

    let pkgName: string;
    let pkgCredits: number;
    let pkgPriceThb: number;
    let topupPackageId: string | null = null;

    if (packageId && typeof packageId === "string") {
      const { data: pkg, error: pkgError } = await supabaseAdmin
        .from("topup_packages")
        .select("id, name, credits, price_thb, is_active")
        .eq("id", packageId)
        .eq("is_active", true)
        .single();
      if (pkgError || !pkg) {
        return new Response(
          JSON.stringify({ error: "Package not found or inactive" }),
          {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
      pkgName = pkg.name;
      pkgCredits = pkg.credits;
      pkgPriceThb = pkg.price_thb;
      topupPackageId = pkg.id;
    } else {
      // Custom-amount path. Strict server-side validation: integer
      // THB, minimum 500, maximum 100,000. Conversion is fixed at
      // 1 THB → 25 credits to match the published rate. Any client
      // tampering (smaller amounts / different ratios) is rejected
      // here before we touch Stripe.
      const amountThb = Math.floor(Number(rawAmountThb));
      const MIN_TOPUP_THB = 500;
      const MAX_TOPUP_THB = 100_000;
      const RATIO_THB_TO_CREDITS = 25;
      if (
        !Number.isFinite(amountThb) ||
        amountThb < MIN_TOPUP_THB ||
        amountThb > MAX_TOPUP_THB
      ) {
        return new Response(
          JSON.stringify({
            error: `amountThb must be an integer between ${MIN_TOPUP_THB} and ${MAX_TOPUP_THB}`,
          }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
      pkgPriceThb = amountThb;
      pkgCredits = amountThb * RATIO_THB_TO_CREDITS;
      pkgName = `Top-up ฿${amountThb.toLocaleString()}`;
    }

    // Synthesise a `pkg`-shaped object so the rest of the function
    // doesn't have to branch — both paths reach the PaymentIntent
    // creation with identical state.
    const pkg = {
      id: topupPackageId,
      name: pkgName,
      credits: pkgCredits,
      price_thb: pkgPriceThb,
    };

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
    if (!customerId) {
      const customers = await stripe.customers.list({
        email: user.email,
        limit: 1,
      });
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

    // Amount in satang (THB smallest unit = 1 satang = 0.01 THB)
    const amountSatang = Math.round(pkg.price_thb * 100);

    // Create PaymentIntent with PromptPay. The webhook downstream
    // keys off `metadata.type === "promptpay_topup"` — keep that
    // contract regardless of preset vs custom path.
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountSatang,
      currency: "thb",
      customer: customerId,
      payment_method_types: ["promptpay"],
      metadata: {
        user_id: user.id,
        ...(pkg.id ? { topup_package_id: pkg.id } : {}),
        credits: pkg.credits.toString(),
        type: "promptpay_topup",
        package_name: pkg.name,
        amount_thb: pkg.price_thb.toString(),
      },
    });

    // Confirm immediately to get the QR code
    const origin = req.headers.get("origin") || "https://mediaforge.lovable.app";

    const confirmed = await stripe.paymentIntents.confirm(paymentIntent.id, {
      payment_method_data: {
        type: "promptpay",
        billing_details: { email: user.email },
      },
      return_url: `${origin}/app/pricing?topup=success`,
    });

    const qrData =
      confirmed.next_action?.promptpay_display_qr_code?.image_url_svg ||
      confirmed.next_action?.promptpay_display_qr_code?.image_url_png;
    const expiresAt =
      confirmed.next_action?.promptpay_display_qr_code?.expires_at;

    console.log(
      `[PROMPTPAY] Intent ${confirmed.id} created for user ${user.id}, pkg ${pkg.name}, ฿${pkg.price_thb}`
    );

    return new Response(
      JSON.stringify({
        paymentIntentId: confirmed.id,
        clientSecret: confirmed.client_secret,
        qrCodeSvgUrl: confirmed.next_action?.promptpay_display_qr_code?.image_url_svg || null,
        qrCodePngUrl: confirmed.next_action?.promptpay_display_qr_code?.image_url_png || null,
        expiresAt: expiresAt || null,
        amount: pkg.price_thb,
        credits: pkg.credits,
        packageName: pkg.name,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error(
      "[PROMPTPAY] Error:",
      error instanceof Error ? error.message : error
    );
    const msg = error instanceof Error ? error.message : "";
    const safeMessages = [
      "User not authenticated",
      "Missing packageId",
      "Missing amountThb",
    ];
    const clientMsg = safeMessages.includes(msg)
      ? msg
      : "PromptPay checkout failed. Please try again.";
    return new Response(JSON.stringify({ error: clientMsg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
