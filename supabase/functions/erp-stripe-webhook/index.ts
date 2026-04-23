import Stripe from "https://esm.sh/stripe@14.21.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, stripe-signature",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "MF-";
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) code += "-";
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ── Bridge helper ──────────────────────────────────────────────
const BRIDGE_URL = Deno.env.get("MAIN_BRIDGE_URL");
if (!BRIDGE_URL) throw new Error("MAIN_BRIDGE_URL is not configured");

async function callBridge(action: string, payload?: Record<string, unknown>) {
  const secret = Deno.env.get("ERP_BRIDGE_SECRET");
  if (!secret) throw new Error("ERP_BRIDGE_SECRET not configured");

  const res = await fetch(BRIDGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, secret, payload: payload ?? {} }),
  });

  const data = await res.json();
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || `Bridge error ${res.status}`);
  }
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    const webhookSecret = Deno.env.get("ERP_STRIPE_WEBHOOK_SECRET") || Deno.env.get("STRIPE_WEBHOOK_SECRET");

    if (!stripeKey) {
      return jsonResp(500, { error: "Stripe not configured" });
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });
    const body = await req.text();

    let event: Stripe.Event;

    if (webhookSecret) {
      const signature = req.headers.get("stripe-signature");
      if (!signature) {
        return jsonResp(400, { error: "Missing stripe-signature" });
      }
      event = await stripe.webhooks.constructEventAsync(
        body,
        signature,
        webhookSecret
      );
    } else {
      event = JSON.parse(body);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as any;
      const metadata = session.metadata || {};

      if (metadata.direct_sales !== "true") {
        return jsonResp(200, { received: true, skipped: "not direct sales" });
      }

      // Check if code already exists for this session via bridge
      try {
        const existing = await callBridge("get_code_by_stripe_session", {
          stripe_session_id: session.id,
        });
        if (existing?.data) {
          console.log(
            `[stripe-webhook] Code already exists for session ${session.id}: ${existing.data.code}`
          );
          return jsonResp(200, { received: true, code: existing.data.code });
        }
      } catch (_) {
        // Not found or bridge action not supported — proceed to create
      }

      // Generate unique code
      const code = generateCode();

      const totalCredits =
        parseInt(metadata.total_credits || "0", 10) ||
        parseInt(metadata.credits || "0", 10) *
          parseInt(metadata.months || "1", 10);

      // Insert redemption code via bridge to Main DB
      const insertPayload = {
        code,
        plan_id: metadata.plan_id || null,
        plan_name: metadata.plan_name || "Unknown",
        billing_cycle: metadata.billing_cycle || "unknown",
        customer_email: metadata.customer_email || session.customer_email,
        stripe_session_id: session.id,
        price_thb: parseFloat(metadata.price_thb || "0"),
        credits: totalCredits,
      };

      try {
        await callBridge("insert_redemption_code", insertPayload);
      } catch (err: any) {
        console.error(
          "[stripe-webhook] Bridge insert_redemption_code failed:",
          err.message
        );
        return jsonResp(500, { error: "Failed to create code via bridge" });
      }

      console.log(
        `[stripe-webhook] Redemption code created via bridge: ${code} for ${metadata.customer_email}`
      );

      // Audit log via bridge
      try {
        await callBridge("insert_audit_log", {
          admin_email: "stripe-webhook@system",
          action_type: "create_redemption_code",
          target_email: metadata.customer_email || session.customer_email,
          details: {
            code,
            plan_name: metadata.plan_name,
            credits: totalCredits,
            source: "stripe_webhook",
          },
        });
      } catch (_) {
        // Non-blocking
      }

      return jsonResp(200, { received: true, code });
    }

    return jsonResp(200, { received: true });
  } catch (error: any) {
    console.error("[stripe-webhook] Error:", error);
    return jsonResp(500, { error: error.message || "Internal server error" });
  }
});
