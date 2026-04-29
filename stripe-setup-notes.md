# Stripe setup notes — Workspace pricing

This document captures the Stripe-side state created during the Phase 2 rollout and any
manual follow-ups needed to complete the integration.

## What was created via Stripe MCP (LIVE mode)

Stripe account: `acct_1T0BBi97qpzc2aQt` (MediaForge).

### Products

| Plan name | Stripe product id |
| --- | --- |
| MediaForge Workspace — Starter | `prod_UQKkTVDEQCGJpp` |
| MediaForge Workspace — Creator | `prod_UQKkrZbBIPvJX1` |
| MediaForge Workspace — Pro     | `prod_UQKkxl5IxUfbcs` |
| MediaForge Workspace — Team    | `prod_UQKkouRF8Xjh9F` |

### Prices

All prices are recurring, currency `THB`, `unit_amount` is in *satang* (1 THB = 100 satang).

| Plan | Cycle | Price (THB) | Stripe price id |
| --- | --- | --- | --- |
| Starter | Monthly |   190 | `price_1TRU4m97qpzc2aQt5KAb4LLG` |
| Starter | Annual  | 1,824 | `price_1TRU4o97qpzc2aQtJMwkbFuB` |
| Creator | Monthly |   440 | `price_1TRU4q97qpzc2aQtHzFhOOAb` |
| Creator | Annual  | 4,224 | `price_1TRU4t97qpzc2aQtt2KBhGAQ` |
| Pro     | Monthly |   880 | `price_1TRU4v97qpzc2aQt5oRhoMWE` |
| Pro     | Annual  | 8,448 | `price_1TRU4y97qpzc2aQtQ7nwZBdl` |

These ids are stored in `subscription_plans.stripe_price_id_monthly` /
`stripe_price_id_annual` on the workspace project (id `fymncypboeubdikpbmqc`).

The Team plan is **contact-sales / metered**. Its Stripe product exists for visibility but
no recurring price is attached.

## Edge function secrets

The `create-checkout`, `customer-portal`, and `stripe-webhook` edge functions all read the
following env vars:

- `STRIPE_SECRET_KEY` — Stripe restricted key with `customers:write`, `prices:read`,
  `products:read`, `checkout.sessions:write`, `payment_intents:write`,
  `subscriptions:read`, `billing_portal.sessions:write`, `webhooks:read`.
- `STRIPE_WEBHOOK_SECRET` — signing secret from the webhook endpoint dashboard. The
  webhook endpoint should point at:
  `https://fymncypboeubdikpbmqc.supabase.co/functions/v1/stripe-webhook`
  and subscribe to: `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
  `payment_intent.succeeded`, `refund.created`, `refund.updated`, `refund.failed`,
  `charge.refunded`.

If these are not yet set, do so via the Supabase dashboard (Settings → Edge Functions →
Secrets) or `supabase secrets set ...`.

## Frontend env

Frontend reads the publishable key from `import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY` for
the embedded checkout (legacy path). The redirect flow used in the rewritten pricing page
does not require this — it just navigates to the Stripe-hosted checkout URL.

## Testing checklist

1. Sign in as a free-tier user, visit `/app/pricing`.
2. Toggle Annual — Pro card should show striked-through `฿880` and discounted
   `฿704/month`, "Billed annually".
3. Click Subscribe on Creator monthly. Should redirect to Stripe-hosted checkout for
   price `price_1TRU4q97qpzc2aQtHzFhOOAb`. After payment, return to
   `/app/pricing?payment=success`, toast appears, balance refreshes.
4. After subscribing, the Pro card shows "Your current plan" pill on the user's actual
   card; CTA disabled.
5. Manage subscription button (top of page when subscribed) opens the Stripe customer
   portal. Cancel from there → webhook clears `subscription_*` fields on the profile.
6. Verify ledger: each `consume_credits` call now writes a row with `effective_amount`
   smaller than `amount` for users on Pro / Team.
