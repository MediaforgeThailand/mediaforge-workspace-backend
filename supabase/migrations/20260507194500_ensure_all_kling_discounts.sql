-- Ensure newly added Kling and Replicate Kling SKUs inherit the launch discount.

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
  )
  and discount_percent is distinct from 20;
