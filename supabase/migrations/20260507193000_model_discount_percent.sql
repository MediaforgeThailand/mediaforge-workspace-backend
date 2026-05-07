-- Model-level runtime discounts.
--
-- credit_costs.cost remains the base provider-derived credit amount. Runtime
-- charges add the workspace infrastructure buffer first, then apply this
-- per-model discount percent to the buffered customer price.

alter table public.credit_costs
  add column if not exists discount_percent numeric(5,2) not null default 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'credit_costs_discount_percent_range'
      and conrelid = 'public.credit_costs'::regclass
  ) then
    alter table public.credit_costs
      add constraint credit_costs_discount_percent_range
      check (discount_percent >= 0 and discount_percent <= 100);
  end if;
end $$;

comment on column public.credit_costs.discount_percent is
  'Per-model customer discount percent applied after workspace infrastructure buffer.';

update public.credit_costs
set
  discount_percent = 20,
  updated_at = now()
where feature = 'generate_freepik_video'
  and (
    lower(coalesce(provider, '')) = 'kling'
    or lower(coalesce(model, '')) like '%kling%'
    or lower(coalesce(label, '')) like '%kling%'
    or lower(coalesce(price_key, '')) like '%kling%'
  );
