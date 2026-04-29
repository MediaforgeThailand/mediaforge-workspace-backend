-- Phase 1a: schema additions for plans
-- Adds the columns the redesigned pricing page reads: separate monthly/annual price ids,
-- annual price + credit totals, runtime credit discount %, generator-quota labels, and
-- the is_featured flag that drives the "BEST VALUE" highlight on Pro.
alter table public.subscription_plans
  add column if not exists stripe_price_id_monthly text,
  add column if not exists stripe_price_id_annual  text,
  add column if not exists annual_price_thb integer,
  add column if not exists annual_credits int,
  add column if not exists credit_discount_percent int default 0,
  add column if not exists generator_quota int,
  add column if not exists generator_quota_label text,
  add column if not exists is_featured boolean default false;

comment on column public.subscription_plans.credit_discount_percent is
  'Runtime discount applied to consume_credits/consume_credits_for. Pro=10, Team=20, others=0.';
comment on column public.subscription_plans.stripe_price_id_monthly is
  'Stripe price id for monthly billing (THB recurring/month).';
comment on column public.subscription_plans.stripe_price_id_annual is
  'Stripe price id for annual billing (THB recurring/year, ~20% off monthly equivalent).';
comment on column public.subscription_plans.annual_price_thb is
  'Annual total price in THB (~monthly*12*0.8).';
comment on column public.subscription_plans.annual_credits is
  'Total credits granted per annual subscription (typically upfront_credits*12).';
comment on column public.subscription_plans.generator_quota is
  'Number of concurrent generator engines a user can run; null = no quota.';
comment on column public.subscription_plans.is_featured is
  'Drives the "BEST VALUE" highlight on the pricing page (true for Pro).';
