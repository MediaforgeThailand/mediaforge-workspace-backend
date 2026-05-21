-- Allow Stripe renewal failures to mark a profile as past_due.
-- stripe-webhook already writes this state on invoice.payment_failed; without
-- the enum value Postgres rejects the update and the customer can keep seeing
-- an active paid status after a failed renewal.
ALTER TYPE public.subscription_status ADD VALUE IF NOT EXISTS 'past_due';
