#!/usr/bin/env node
/**
 * Audit Stripe webhook endpoint subscriptions vs what the code handles.
 *
 * Why this exists: 2026-05-20 dispute test on a preview branch fired
 * charge.dispute.created in Stripe, but the webhook endpoint on preview
 * did not have that event subscribed — the dispute reached the customer
 * and the merchant's balance but never triggered handleDisputeCreated.
 * Same gap on prod would mean disputes silently DON'T clawback partner
 * commissions: real money loss.
 *
 * Run:
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/audit-stripe-webhook.mjs
 *
 * Exit codes:
 *   0  every endpoint subscribes the full EXPECTED set
 *   1  one or more endpoints missing events (printed per endpoint)
 *   2  configuration error (missing key, API failure)
 *
 * Tip: run for BOTH test and live mode by swapping STRIPE_SECRET_KEY
 *      (sk_test_... for test, sk_live_... for prod). Each call only
 *      sees endpoints in the mode that matches the key.
 */

// Keep this list in sync with `event.type === "..."` branches in
// supabase/functions/stripe-webhook/index.ts. Each event the code
// branches on MUST be in the endpoint's enabled_events list, or Stripe
// will never deliver it and the handler will never run.
const EXPECTED_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.refunded",
  "refund.created",
  "refund.updated",
  "refund.failed",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
];

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_KEY) {
  console.error("ERROR: STRIPE_SECRET_KEY env var required");
  console.error("Run: STRIPE_SECRET_KEY=sk_test_... node scripts/audit-stripe-webhook.mjs");
  process.exit(2);
}

const mode = STRIPE_KEY.startsWith("sk_test_") ? "TEST" : STRIPE_KEY.startsWith("sk_live_") ? "LIVE" : "UNKNOWN";

async function listEndpoints() {
  const endpoints = [];
  let starting_after = null;
  do {
    const url = new URL("https://api.stripe.com/v1/webhook_endpoints");
    url.searchParams.set("limit", "100");
    if (starting_after) url.searchParams.set("starting_after", starting_after);
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${Buffer.from(STRIPE_KEY + ":").toString("base64")}` },
    });
    if (!res.ok) {
      console.error(`ERROR: Stripe API ${res.status} — ${await res.text()}`);
      process.exit(2);
    }
    const body = await res.json();
    endpoints.push(...body.data);
    starting_after = body.has_more ? body.data[body.data.length - 1].id : null;
  } while (starting_after);
  return endpoints;
}

function audit(endpoint) {
  const enabled = new Set(endpoint.enabled_events ?? []);
  const wildcardAll = enabled.has("*");
  const wildcardCharge = enabled.has("charge.*");
  const wildcardDispute = enabled.has("charge.dispute.*");
  const wildcardRefund = enabled.has("refund.*");
  const wildcardInvoice = enabled.has("invoice.*");
  const wildcardPI = enabled.has("payment_intent.*");
  const wildcardSub = enabled.has("customer.subscription.*");
  const wildcardCheckout = enabled.has("checkout.session.*");

  const missing = [];
  for (const e of EXPECTED_EVENTS) {
    if (wildcardAll) continue;
    if (enabled.has(e)) continue;
    if (e.startsWith("charge.dispute.") && wildcardDispute) continue;
    if (e.startsWith("charge.") && wildcardCharge) continue;
    if (e.startsWith("refund.") && wildcardRefund) continue;
    if (e.startsWith("invoice.") && wildcardInvoice) continue;
    if (e.startsWith("payment_intent.") && wildcardPI) continue;
    if (e.startsWith("customer.subscription.") && wildcardSub) continue;
    if (e.startsWith("checkout.session.") && wildcardCheckout) continue;
    missing.push(e);
  }
  return missing;
}

const endpoints = await listEndpoints();
console.log(`[${mode}] Found ${endpoints.length} webhook endpoint(s)`);

let anyMissing = false;
for (const ep of endpoints) {
  const missing = audit(ep);
  const status = missing.length === 0 ? "✓" : "✗";
  console.log(`\n${status} ${ep.url}`);
  console.log(`  id=${ep.id}  status=${ep.status}  enabled=${ep.enabled_events?.length ?? 0} events`);
  if (missing.length > 0) {
    anyMissing = true;
    console.log(`  MISSING (${missing.length}):`);
    for (const e of missing) console.log(`    - ${e}`);
    console.log(`  Fix: Stripe Dashboard → Developers → Webhooks → ${ep.id} → Update endpoint → tick missing events`);
  }
}

if (anyMissing) {
  console.log(`\n[${mode}] ✗ FAIL — one or more endpoints missing expected events`);
  process.exit(1);
}
console.log(`\n[${mode}] ✓ PASS — all endpoints subscribe the full EXPECTED set`);
