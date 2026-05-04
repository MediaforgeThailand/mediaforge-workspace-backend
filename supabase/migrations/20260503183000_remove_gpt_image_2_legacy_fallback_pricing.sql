-- GPT Image 2 must be priced by exact resolution + quality SKU.
-- Remove old quality-only fallback rows so they cannot occupy the 1K cells
-- in the admin pricing matrix or be used silently by runtime lookup.

delete from public.credit_costs
where feature = 'generate_openai_image'
  and model in ('gpt-image-2-low', 'gpt-image-2-medium', 'gpt-image-2-high');

with rows(feature, model, label, cost, pricing_type, provider, price_key, resolution, quality, source, source_url, source_ratio, provider_unit, notes) as (
  values
    ('generate_openai_image','gpt-image-2:1k:low','GPT Image 2 1K Low',11,'per_operation','openai','gpt-image-2:1k:low','1K','low','official_docs','https://developers.openai.com/api/docs/guides/image-generation#calculating-costs',null::numeric,'per image','Calculated from official gpt-image-2 output-token calculator at 1024x1024, then USD -> THB and Workspace credits.'),
    ('generate_openai_image','gpt-image-2:1k:medium','GPT Image 2 1K Medium',93,'per_operation','openai','gpt-image-2:1k:medium','1K','medium','official_docs','https://developers.openai.com/api/docs/guides/image-generation#calculating-costs',null::numeric,'per image','Calculated from official gpt-image-2 output-token calculator at 1024x1024, then USD -> THB and Workspace credits.'),
    ('generate_openai_image','gpt-image-2:1k:high','GPT Image 2 1K High',369,'per_operation','openai','gpt-image-2:1k:high','1K','high','official_docs','https://developers.openai.com/api/docs/guides/image-generation#calculating-costs',null::numeric,'per image','Calculated from official gpt-image-2 output-token calculator at 1024x1024, then USD -> THB and Workspace credits.')
)
insert into public.credit_costs
  (feature, model, label, cost, pricing_type, provider, price_key, resolution, quality, source, source_url, source_ratio, provider_unit, notes)
select * from rows
on conflict (feature, COALESCE(model, '__default__'), COALESCE(duration_seconds, 0), COALESCE(has_audio, false))
do update set
  label = excluded.label,
  cost = excluded.cost,
  pricing_type = excluded.pricing_type,
  provider = excluded.provider,
  price_key = excluded.price_key,
  resolution = excluded.resolution,
  quality = excluded.quality,
  source = excluded.source,
  source_url = excluded.source_url,
  source_ratio = excluded.source_ratio,
  provider_unit = excluded.provider_unit,
  notes = excluded.notes,
  updated_at = now();
