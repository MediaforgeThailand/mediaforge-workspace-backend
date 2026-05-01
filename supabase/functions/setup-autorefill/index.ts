/// <reference lib="deno.ns" />
/// <reference lib="dom" />
/**
 * setup-autorefill — issue a SetupIntent for the auto-refill card-binding flow.
 *
 * Two actions:
 *   - `create_setup_intent` — returns { client_secret, customer_id }
 *     for Stripe Elements to confirmSetup() on the client. The
 *     SetupIntent is `usage: "off_session"` so we can later charge
 *     the saved card without the user being present (the cron path).
 *
 *   - `verify_and_enable` — called AFTER the client confirms the
 *     SetupIntent. Re-checks server-side that the SI succeeded and
 *     yielded a usable payment_method, then:
 *       1. saves payment_method_id to profiles.auto_refill_payment_method_id
 *       2. (optional) does a small ฿20 verification charge + immediate refund
 *          to PROVE the card actually charges through (the user's
 *          "ตัดผ่านแล้ว" requirement)
 *       3. flips subscription_auto_refill = true
 *       4. stamps auto_refill_verified_at = now()
 *
 * Card binding inherits 3DS / OTP from Stripe's SCA pipeline — Stripe
 * Elements + bank challenge handle the OTP flow without us touching it.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@18.5.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

/** Resolve the calling user from their JWT. Returns null if invalid. */
async function getCallerUser(req: Request) {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

/** Find or create the Stripe customer for this user. */
async function ensureStripeCustomer(
  stripe: Stripe,
  admin: ReturnType<typeof createClient>,
  user: { id: string; email?: string },
): Promise<string> {
  const { data: profile } = await admin
    .from("profiles")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();

  let customerId = (profile as { stripe_customer_id?: string } | null)?.stripe_customer_id;
  if (customerId) return customerId;

  // Look up by email first to avoid duplicate customers when the
  // user has paid before but the linkage was somehow lost.
  if (user.email) {
    const list = await stripe.customers.list({ email: user.email, limit: 1 });
    if (list.data.length > 0) {
      customerId = list.data[0].id;
    }
  }
  if (!customerId) {
    const created = await stripe.customers.create({
      email: user.email,
      metadata: { supabase_user_id: user.id },
    });
    customerId = created.id;
  }
  await admin
    .from("profiles")
    .update({ stripe_customer_id: customerId })
    .eq("user_id", user.id);

  return customerId;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  if (!STRIPE_SECRET_KEY) {
    return json({ error: "stripe_not_configured" }, 500);
  }

  const user = await getCallerUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { action?: string; setup_intent_id?: string; threshold?: number; amount_thb?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const action = String(body.action ?? "");

  const stripe = new Stripe(STRIPE_SECRET_KEY, {
    apiVersion: "2025-08-27.basil" as Stripe.LatestApiVersion,
  });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── Action 1: create_setup_intent ──────────────────────────────
  if (action === "create_setup_intent") {
    try {
      const customerId = await ensureStripeCustomer(stripe, admin, user);

      const setupIntent = await stripe.setupIntents.create({
        customer: customerId,
        payment_method_types: ["card"],
        usage: "off_session",
        metadata: {
          supabase_user_id: user.id,
          purpose: "autorefill_binding",
        },
      });

      return json({
        client_secret: setupIntent.client_secret,
        customer_id: customerId,
        setup_intent_id: setupIntent.id,
      });
    } catch (e) {
      console.error("[setup-autorefill] create_setup_intent error:", e);
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  // ── Action 2: verify_and_enable ────────────────────────────────
  if (action === "verify_and_enable") {
    const setupIntentId = String(body.setup_intent_id ?? "");
    if (!setupIntentId) return json({ error: "setup_intent_id required" }, 400);

    try {
      const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
      if (setupIntent.status !== "succeeded") {
        return json(
          { error: `setup_intent_not_succeeded:${setupIntent.status}` },
          400,
        );
      }
      // Cross-check that THIS user owns the SetupIntent. Without this,
      // a malicious caller could pass another user's SI id and bind
      // someone else's card.
      if (setupIntent.metadata?.supabase_user_id !== user.id) {
        return json({ error: "setup_intent_user_mismatch" }, 403);
      }
      const pmId =
        typeof setupIntent.payment_method === "string"
          ? setupIntent.payment_method
          : setupIntent.payment_method?.id;
      if (!pmId) {
        return json({ error: "no_payment_method_on_setup_intent" }, 400);
      }
      const customerId =
        typeof setupIntent.customer === "string"
          ? setupIntent.customer
          : setupIntent.customer?.id;

      // Optional verification charge: ฿20 (Stripe Thailand min) +
      // immediate refund. Confirms the card actually charges off-session
      // (per user request "ตัดผ่านแล้ว"). On 3DS-required cards this
      // would have already happened during SetupIntent confirm — but
      // a Stripe success there only proves the card EXISTS, not that
      // it can settle a real charge. The verify charge is the proof.
      let verifyChargeId: string | null = null;
      let verifyRefundId: string | null = null;
      try {
        const verifyIntent = await stripe.paymentIntents.create({
          amount: 2000, // 20.00 THB in satang
          currency: "thb",
          customer: customerId,
          payment_method: pmId,
          off_session: true,
          confirm: true,
          metadata: {
            supabase_user_id: user.id,
            purpose: "autorefill_card_verification",
          },
          description: "Auto-refill card verification (refunded immediately)",
        });
        if (verifyIntent.status === "succeeded") {
          verifyChargeId = String(verifyIntent.latest_charge ?? "");
          // Immediately refund the verification charge.
          if (verifyChargeId) {
            const refund = await stripe.refunds.create({
              charge: verifyChargeId,
              reason: "requested_by_customer",
              metadata: {
                supabase_user_id: user.id,
                purpose: "autorefill_verification_refund",
              },
            });
            verifyRefundId = refund.id;
          }
        } else {
          // 3DS challenge needed for verify charge — rare since the
          // SetupIntent already passed SCA, but possible for some
          // banks. We tell the caller to retry the binding flow.
          return json(
            {
              error: "verify_charge_requires_action",
              status: verifyIntent.status,
            },
            400,
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[setup-autorefill] verify charge failed:", msg);
        // Treat any failure as "this card won't charge" — better to
        // reject the auto-refill setup now than to discover it later
        // when the cron tries to top up and silently fails.
        return json(
          { error: "verify_charge_failed", details: msg },
          400,
        );
      }

      // Sanitize threshold + amount inputs.
      const threshold = Math.max(
        50,
        Math.min(10000, Number(body.threshold ?? 100)),
      );
      const amountThb = Math.max(
        100,
        Math.min(10000, Number(body.amount_thb ?? 500)),
      );

      // Persist + flip the toggle on. The cron watches this column
      // set and `subscription_auto_refill = true` to trigger refills.
      const { error: updErr } = await admin
        .from("profiles")
        .update({
          auto_refill_payment_method_id: pmId,
          auto_refill_threshold: threshold,
          auto_refill_amount_thb: amountThb,
          auto_refill_verified_at: new Date().toISOString(),
          auto_refill_failure_count: 0,
          subscription_auto_refill: true,
        })
        .eq("user_id", user.id);
      if (updErr) {
        return json({ error: "save_failed", details: updErr.message }, 500);
      }

      return json({
        success: true,
        payment_method_id: pmId,
        verify_charge_id: verifyChargeId,
        verify_refund_id: verifyRefundId,
        threshold,
        amount_thb: amountThb,
      });
    } catch (e) {
      console.error("[setup-autorefill] verify_and_enable error:", e);
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  // ── Action 3: disable ────────────────────────────────────────
  if (action === "disable") {
    try {
      const { error: updErr } = await admin
        .from("profiles")
        .update({
          subscription_auto_refill: false,
          auto_refill_payment_method_id: null,
          auto_refill_verified_at: null,
        })
        .eq("user_id", user.id);
      if (updErr) {
        return json({ error: "save_failed", details: updErr.message }, 500);
      }
      return json({ success: true });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  return json({ error: `unknown_action:${action}` }, 400);
});
