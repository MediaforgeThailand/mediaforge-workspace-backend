import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

/**
 * stripe-list-invoices
 *
 * GET-style RPC. Returns the calling user's recent Stripe invoices
 * (both subscription invoices and one-off topup receipts/charges).
 * Powers the "Billing history" dialog on Plan & billing.
 *
 * Behaviour:
 *   - User must be authenticated; we resolve their stripe_customer_id
 *     from `profiles`. No customer ⇒ return an empty list (free user
 *     with no card on file).
 *   - We pull invoices first (limit 24) and merge in succeeded
 *     PaymentIntents for one-off payments (Topup / PromptPay) that
 *     don't always materialize as a Stripe Invoice. The combined list
 *     is sorted newest-first.
 *   - Each row exposes a stable shape so the UI doesn't need to know
 *     whether the source was an Invoice or a PaymentIntent.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface BillingRow {
  id: string;
  type: "invoice" | "payment_intent";
  description: string;
  amount_thb: number;
  currency: string;
  status: string;
  created_at: string;
  invoice_pdf_url: string | null;
  hosted_invoice_url: string | null;
  receipt_url: string | null;
}

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
    if (!user) throw new Error("User not authenticated");

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();

    const customerId = profile?.stripe_customer_id;
    if (!customerId) {
      // Free user with no card on file → empty history. This is a
      // perfectly normal state, not an error.
      return new Response(JSON.stringify({ rows: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    // Run both lookups in parallel — invoice list + PaymentIntent list.
    // Topups and PromptPay charges show up as PIs without a parent
    // invoice (they're not subscription-driven), so the merged view is
    // strictly more complete than either source alone.
    const [invoicesRes, intentsRes] = await Promise.all([
      stripe.invoices.list({ customer: customerId, limit: 24 }),
      stripe.paymentIntents.list({ customer: customerId, limit: 24 }),
    ]);

    const rows: BillingRow[] = [];

    for (const inv of invoicesRes.data) {
      // Skip drafts/voided that have nothing to show. `paid` and
      // `open` (open = sent but unpaid) are both meaningful states.
      if (inv.status === "draft" || inv.status === "void") continue;
      rows.push({
        id: inv.id ?? `inv_${inv.created}`,
        type: "invoice",
        description: inv.description || inv.lines?.data?.[0]?.description || "Subscription",
        amount_thb: (inv.amount_paid || inv.amount_due) / 100,
        currency: (inv.currency || "thb").toUpperCase(),
        status: inv.status || "unknown",
        created_at: new Date(inv.created * 1000).toISOString(),
        invoice_pdf_url: inv.invoice_pdf ?? null,
        hosted_invoice_url: inv.hosted_invoice_url ?? null,
        receipt_url: null,
      });
    }

    // Track invoice-linked PIs so we don't double-count them.
    const invoicePiIds = new Set(
      invoicesRes.data
        .map((i: any) => (typeof i.payment_intent === "string" ? i.payment_intent : i.payment_intent?.id))
        .filter(Boolean) as string[],
    );

    for (const pi of intentsRes.data) {
      if (pi.status !== "succeeded") continue;
      if (invoicePiIds.has(pi.id)) continue;
      const meta = pi.metadata || {};
      const desc = meta.package_name
        ? `Top-up — ${meta.package_name}`
        : meta.plan_name
        ? `${meta.plan_name} (${meta.billing_cycle ?? "monthly"})`
        : meta.type === "promptpay_topup"
        ? "PromptPay top-up"
        : meta.type === "subscription_oneoff"
        ? "Subscription"
        : "Payment";
      // Latest charge → receipt URL (used by the UI as "View receipt").
      let receiptUrl: string | null = null;
      const lastChargeId = (pi as any).latest_charge as string | null;
      if (lastChargeId) {
        try {
          const charge = await stripe.charges.retrieve(lastChargeId);
          receiptUrl = charge.receipt_url ?? null;
        } catch (_) { /* swallow — receipt is best-effort */ }
      }
      rows.push({
        id: pi.id,
        type: "payment_intent",
        description: desc,
        amount_thb: pi.amount_received / 100,
        currency: pi.currency.toUpperCase(),
        status: pi.status,
        created_at: new Date(pi.created * 1000).toISOString(),
        invoice_pdf_url: null,
        hosted_invoice_url: null,
        receipt_url: receiptUrl,
      });
    }

    rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

    return new Response(JSON.stringify({ rows }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[STRIPE-LIST-INVOICES] Error:", error instanceof Error ? error.message : error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    // Auth failures bubble user-friendly; everything else is generic.
    const status = msg.includes("authenticated") || msg.includes("Authorization") ? 401 : 500;
    return new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
