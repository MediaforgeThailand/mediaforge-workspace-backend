-- Phase 1b: profiles additions for Stripe + plan tracking.
-- Note: subscription_status (enum free/professional/agency), subscription_plan_id,
-- current_period_end, and stripe_customer_id all already exist on this project.
-- We only add the truly new columns + ensure the index.
alter table public.profiles
  add column if not exists subscription_billing_cycle text,
  add column if not exists current_period_start timestamptz;

create index if not exists profiles_stripe_customer_idx
  on public.profiles (stripe_customer_id) where stripe_customer_id is not null;

comment on column public.profiles.subscription_billing_cycle is
  'monthly | annual — drives renewal credit grants and pricing-page CTA copy.';
comment on column public.profiles.current_period_start is
  'Start of the current Stripe billing period; mirrors customer.subscription.current_period_start.';
