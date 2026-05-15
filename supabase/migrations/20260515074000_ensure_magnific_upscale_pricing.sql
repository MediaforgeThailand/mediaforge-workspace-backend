insert into public.credit_costs (
  feature,
  model,
  label,
  cost,
  pricing_type,
  provider,
  price_key,
  source,
  source_url,
  provider_unit,
  notes
)
select
  'upscale_image',
  'magnific-upscale-precision-v2',
  'Upscale Image (Magnific Precision V2)',
  5,
  'per_operation',
  'magnific',
  'magnific-upscale-precision-v2',
  'legacy_workspace_pricing',
  'https://docs.magnific.com/api-reference/image-upscaler-precision-v2/post-image-upscaler-precision-v2',
  'per image',
  'Keeps the legacy workspace upscale_image baseline (5 credits/op) while routing runtime to Magnific Precision V2. Update after provider invoice/SKU review.'
where not exists (
  select 1
  from public.credit_costs
  where feature = 'upscale_image'
    and model = 'magnific-upscale-precision-v2'
    and duration_seconds is null
    and coalesce(has_audio, false) = false
);

insert into public.credit_costs (
  feature,
  model,
  label,
  cost,
  pricing_type,
  provider,
  price_key,
  resolution,
  quality,
  source,
  source_url,
  provider_unit,
  notes
)
select
  rows.feature,
  rows.model,
  rows.label,
  rows.cost,
  'per_operation',
  'openai',
  rows.model,
  rows.resolution,
  rows.quality,
  'official_docs',
  'https://developers.openai.com/api/docs/guides/image-generation',
  'per image edit',
  'OpenAI gpt-image-2 enhancement uses the image edits endpoint. Base credits estimate image output tokens for the selected resolution and quality; input image/text tokens are not yet metered separately in Workspace.'
from (
  values
    ('upscale_image', 'gpt-image-2-enhance:1k:low',    'GPT Image 2 Enhance 1K Low',    11,  '1K', 'low'),
    ('upscale_image', 'gpt-image-2-enhance:1k:medium', 'GPT Image 2 Enhance 1K Medium', 93,  '1K', 'medium'),
    ('upscale_image', 'gpt-image-2-enhance:1k:high',   'GPT Image 2 Enhance 1K High',   369, '1K', 'high'),
    ('upscale_image', 'gpt-image-2-enhance:1k:auto',   'GPT Image 2 Enhance 1K Auto',   369, '1K', 'auto'),
    ('upscale_image', 'gpt-image-2-enhance:2k:low',    'GPT Image 2 Enhance 2K Low',    21,  '2K', 'low'),
    ('upscale_image', 'gpt-image-2-enhance:2k:medium', 'GPT Image 2 Enhance 2K Medium', 188, '2K', 'medium'),
    ('upscale_image', 'gpt-image-2-enhance:2k:high',   'GPT Image 2 Enhance 2K High',   750, '2K', 'high'),
    ('upscale_image', 'gpt-image-2-enhance:2k:auto',   'GPT Image 2 Enhance 2K Auto',   750, '2K', 'auto'),
    ('upscale_image', 'gpt-image-2-enhance:4k:low',    'GPT Image 2 Enhance 4K Low',    20,  '4K', 'low'),
    ('upscale_image', 'gpt-image-2-enhance:4k:medium', 'GPT Image 2 Enhance 4K Medium', 176, '4K', 'medium'),
    ('upscale_image', 'gpt-image-2-enhance:4k:high',   'GPT Image 2 Enhance 4K High',   701, '4K', 'high'),
    ('upscale_image', 'gpt-image-2-enhance:4k:auto',   'GPT Image 2 Enhance 4K Auto',   701, '4K', 'auto')
) as rows(feature, model, label, cost, resolution, quality)
where not exists (
  select 1
  from public.credit_costs cc
  where cc.feature = rows.feature
    and cc.model = rows.model
    and cc.duration_seconds is null
    and coalesce(cc.has_audio, false) = false
);
