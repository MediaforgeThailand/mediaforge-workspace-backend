-- Workspace Free plan + Auto Subtitle pricing.
--
-- Free gets 1,000 credits/month but runtime gates image/video/upscale to
-- Starter or higher. The gate lives in workspace-run-node and the frontend
-- dialog; this row makes the plan visible in Pricing and admin surfaces.

insert into public.subscription_plans (
  name,
  target,
  billing_cycle,
  price_thb,
  upfront_credits,
  flow_quota,
  discount_official,
  discount_community,
  is_active,
  sort_order,
  stripe_price_id,
  stripe_price_id_monthly,
  stripe_price_id_annual,
  annual_price_thb,
  annual_credits,
  credit_discount_percent,
  generator_quota,
  generator_quota_label,
  is_featured
)
select
  'Free',
  'user',
  'monthly',
  0,
  1000,
  null,
  0,
  0,
  true,
  0,
  null,
  null,
  null,
  0,
  12000,
  0,
  1,
  '1 generator engine',
  false
where not exists (
  select 1
  from public.subscription_plans
  where name = 'Free'
    and target = 'user'
    and billing_cycle = 'monthly'
);

update public.subscription_plans
   set price_thb = 0,
       upfront_credits = 1000,
       is_active = true,
       sort_order = 0,
       annual_price_thb = 0,
       annual_credits = 12000,
       credit_discount_percent = 0,
       generator_quota = 1,
       generator_quota_label = '1 generator engine',
       is_featured = false,
       stripe_price_id = null,
       stripe_price_id_monthly = null,
       stripe_price_id_annual = null
 where name = 'Free'
   and target = 'user'
   and billing_cycle = 'monthly';

delete from public.credit_costs
 where feature = 'auto_subtitle'
   and model = 'auto-suptitle-whisper';

insert into public.credit_costs (
  feature,
  model,
  label,
  cost,
  pricing_type,
  duration_seconds,
  has_audio,
  provider,
  price_key,
  resolution,
  quality,
  source,
  source_url,
  provider_unit,
  notes,
  discount_percent
) values (
  'auto_subtitle',
  'auto-suptitle-whisper',
  'Auto Subtitle (OpenAI transcription + render) / min',
  70,
  'per_minute',
  null,
  false,
  'openai',
  'gpt-4o-transcribe+whisper-1+gpt-normalize',
  'media',
  'word-timestamps',
  'official_docs_estimate',
  'https://openai.com/api/pricing/',
  'per source minute',
  'Conservative per-minute floor for Auto Subtitle: captions-transcribe calls gpt-4o-transcribe for text, whisper-1 for timing, and a short GPT normalizer. Runtime bills by source media duration.',
  0
);
