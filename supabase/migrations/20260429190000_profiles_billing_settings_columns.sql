-- Settings → Plan & billing surface additions.
--
-- subscription_auto_refill drives the Auto-refill <Switch> on the
-- Credits card. Default true mirrors the screenshot reference where
-- new subscribers opt in unless they untick it.
--
-- billing_address is a jsonb blob populated from the "Change billing
-- information" dialog. Schema is intentionally loose so we can iterate
-- on the form (line1/city/postal/country/tax_id, etc.) without DDL.
alter table public.profiles
  add column if not exists subscription_auto_refill boolean not null default true;

alter table public.profiles
  add column if not exists billing_address jsonb;

comment on column public.profiles.subscription_auto_refill is 'When true, attempt to auto-refill credits on subscription renewal. UI toggle on Plan & billing.';
comment on column public.profiles.billing_address is 'Optional billing details (name, email, line1, city, postal, country, tax_id). Edited from Plan & billing.';
