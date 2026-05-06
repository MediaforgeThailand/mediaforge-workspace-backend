delete from public.credit_costs
where feature = 'generate_openai_image'
  and (
    model like 'gpt-image-2:%'
    or model in ('gpt-image-2-low', 'gpt-image-2-medium', 'gpt-image-2-high')
  );

insert into public.credit_costs (
  id,
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
  source_ratio,
  provider_unit,
  notes
)
select
  gen_random_uuid(),
  'generate_openai_image',
  'gpt-image-2:' || tier || ':' || quality,
  'GPT Image 2 ' || upper(tier) || ' ' || initcap(quality),
  cost,
  'per_operation',
  null,
  false,
  'openai',
  'gpt-image-2:' || tier || ':' || quality,
  upper(tier),
  quality,
  'replicate_docs_minus_10_percent',
  'https://replicate.com/openai/gpt-image-2',
  0.9,
  'per image',
  'Replicate openai/gpt-image-2 charges by quality per output image; Workspace charges 90% of Replicate price and keeps resolution tier only for runtime matching.'
from (
  values
    ('1k', 'low', 19),
    ('1k', 'medium', 75),
    ('1k', 'high', 202),
    ('1k', 'auto', 202),
    ('2k', 'low', 19),
    ('2k', 'medium', 75),
    ('2k', 'high', 202),
    ('2k', 'auto', 202),
    ('4k', 'low', 19),
    ('4k', 'medium', 75),
    ('4k', 'high', 202),
    ('4k', 'auto', 202)
) as v(tier, quality, cost);

delete from public.credit_costs
where feature = 'generate_freepik_video'
  and (
    model like 'replicate-seedance-2-0%'
    or model in (
      'seedance-2-0-lite',
      'seedance-2-0-lite:480p',
      'seedance-2-0-lite:720p',
      'seedance-2-0-pro',
      'seedance-2-0-pro:480p',
      'seedance-2-0-pro:720p',
      'seedance-2-0-pro:1080p',
      'dreamina-seedance-2-0-fast-260128',
      'dreamina-seedance-2-0-260128'
    )
  );

insert into public.credit_costs (
  id,
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
  source,
  source_url,
  source_ratio,
  provider_unit,
  notes
)
select
  gen_random_uuid(),
  'generate_freepik_video',
  row_model,
  row_label,
  row_cost,
  'per_second',
  null,
  row_has_audio,
  row_provider,
  row_price_key,
  row_resolution,
  'replicate_docs_minus_10_percent',
  'https://replicate.com/bytedance/seedance-2.0',
  0.9,
  'per second',
  row_notes
from (
  values
    ('seedance-2-0-lite:480p', 'Seedance 2.0 Fast 480p', 126, false, 'seedance', 'seedance-2-0-lite:480p:non_video_in:silent', '480p', 'Replicate non-video input 480p is $0.08/sec; Workspace charges 90% of Replicate price.'),
    ('seedance-2-0-lite:720p', 'Seedance 2.0 Fast 720p', 284, false, 'seedance', 'seedance-2-0-lite:720p:non_video_in:silent', '720p', 'Replicate non-video input 720p is $0.18/sec; Workspace charges 90% of Replicate price.'),
    ('seedance-2-0-lite', 'Seedance 2.0 Fast fallback', 284, false, 'seedance', 'seedance-2-0-lite:default:non_video_in:silent', null, 'Fallback uses discounted Replicate 720p non-video-input rate.'),
    ('dreamina-seedance-2-0-fast-260128', 'Seedance 2.0 Fast direct-id fallback', 284, false, 'seedance', 'dreamina-seedance-2-0-fast-260128:default:non_video_in:silent', null, 'Direct BytePlus alias uses discounted Replicate 720p non-video-input rate.'),
    ('seedance-2-0-pro:480p', 'Seedance 2.0 Pro 480p', 126, false, 'seedance', 'seedance-2-0-pro:480p:non_video_in:silent', '480p', 'Replicate non-video input 480p is $0.08/sec; Workspace charges 90% of Replicate price.'),
    ('seedance-2-0-pro:720p', 'Seedance 2.0 Pro 720p', 284, false, 'seedance', 'seedance-2-0-pro:720p:non_video_in:silent', '720p', 'Replicate non-video input 720p is $0.18/sec; Workspace charges 90% of Replicate price.'),
    ('seedance-2-0-pro:1080p', 'Seedance 2.0 Pro 1080p', 709, false, 'seedance', 'seedance-2-0-pro:1080p:non_video_in:silent', '1080p', 'Replicate non-video input 1080p is $0.45/sec; Workspace charges 90% of Replicate price.'),
    ('seedance-2-0-pro', 'Seedance 2.0 Pro fallback', 284, false, 'seedance', 'seedance-2-0-pro:default:non_video_in:silent', null, 'Fallback uses discounted Replicate 720p non-video-input rate.'),
    ('dreamina-seedance-2-0-260128', 'Seedance 2.0 Pro direct-id fallback', 284, false, 'seedance', 'dreamina-seedance-2-0-260128:default:non_video_in:silent', null, 'Direct BytePlus alias uses discounted Replicate 720p non-video-input rate.'),
    ('replicate-seedance-2-0:480p', 'Seedance 2.0 Replicate 480p', 126, false, 'replicate', 'replicate-seedance-2-0:480p:non_video_in:silent', '480p', 'Replicate non-video input 480p is $0.08/sec; Workspace charges 90% of Replicate price.'),
    ('replicate-seedance-2-0:480p', 'Seedance 2.0 Replicate 480p + audio', 126, true, 'replicate', 'replicate-seedance-2-0:480p:non_video_in:audio', '480p', 'Audio toggle does not change Replicate pricing; duplicate row keeps runtime lookup strict.'),
    ('replicate-seedance-2-0:720p', 'Seedance 2.0 Replicate 720p', 284, false, 'replicate', 'replicate-seedance-2-0:720p:non_video_in:silent', '720p', 'Replicate non-video input 720p is $0.18/sec; Workspace charges 90% of Replicate price.'),
    ('replicate-seedance-2-0:720p', 'Seedance 2.0 Replicate 720p + audio', 284, true, 'replicate', 'replicate-seedance-2-0:720p:non_video_in:audio', '720p', 'Audio toggle does not change Replicate pricing; duplicate row keeps runtime lookup strict.'),
    ('replicate-seedance-2-0:1080p', 'Seedance 2.0 Replicate 1080p', 709, false, 'replicate', 'replicate-seedance-2-0:1080p:non_video_in:silent', '1080p', 'Replicate non-video input 1080p is $0.45/sec; Workspace charges 90% of Replicate price.'),
    ('replicate-seedance-2-0:1080p', 'Seedance 2.0 Replicate 1080p + audio', 709, true, 'replicate', 'replicate-seedance-2-0:1080p:non_video_in:audio', '1080p', 'Audio toggle does not change Replicate pricing; duplicate row keeps runtime lookup strict.'),
    ('replicate-seedance-2-0', 'Seedance 2.0 Replicate fallback', 284, false, 'replicate', 'replicate-seedance-2-0:default:non_video_in:silent', null, 'Fallback uses discounted Replicate 720p non-video-input rate.'),
    ('replicate-seedance-2-0', 'Seedance 2.0 Replicate fallback + audio', 284, true, 'replicate', 'replicate-seedance-2-0:default:non_video_in:audio', null, 'Audio toggle does not change Replicate pricing; duplicate row keeps runtime lookup strict.'),
    ('replicate-seedance-2-0-video-ref:480p', 'Seedance 2.0 Replicate 480p + video ref', 158, false, 'replicate', 'replicate-seedance-2-0-video-ref:480p:video_in:silent', '480p', 'Replicate video input 480p is $0.10/sec; Workspace charges 90% of Replicate price.'),
    ('replicate-seedance-2-0-video-ref:480p', 'Seedance 2.0 Replicate 480p + video ref + audio', 158, true, 'replicate', 'replicate-seedance-2-0-video-ref:480p:video_in:audio', '480p', 'Audio toggle does not change Replicate pricing; duplicate row keeps runtime lookup strict.'),
    ('replicate-seedance-2-0-video-ref:720p', 'Seedance 2.0 Replicate 720p + video ref', 347, false, 'replicate', 'replicate-seedance-2-0-video-ref:720p:video_in:silent', '720p', 'Replicate video input 720p is $0.22/sec; Workspace charges 90% of Replicate price.'),
    ('replicate-seedance-2-0-video-ref:720p', 'Seedance 2.0 Replicate 720p + video ref + audio', 347, true, 'replicate', 'replicate-seedance-2-0-video-ref:720p:video_in:audio', '720p', 'Audio toggle does not change Replicate pricing; duplicate row keeps runtime lookup strict.'),
    ('replicate-seedance-2-0-video-ref:1080p', 'Seedance 2.0 Replicate 1080p + video ref', 867, false, 'replicate', 'replicate-seedance-2-0-video-ref:1080p:video_in:silent', '1080p', 'Replicate video input 1080p is $0.55/sec; Workspace charges 90% of Replicate price.'),
    ('replicate-seedance-2-0-video-ref:1080p', 'Seedance 2.0 Replicate 1080p + video ref + audio', 867, true, 'replicate', 'replicate-seedance-2-0-video-ref:1080p:video_in:audio', '1080p', 'Audio toggle does not change Replicate pricing; duplicate row keeps runtime lookup strict.'),
    ('replicate-seedance-2-0-video-ref', 'Seedance 2.0 Replicate video-ref fallback', 347, false, 'replicate', 'replicate-seedance-2-0-video-ref:default:video_in:silent', null, 'Fallback uses discounted Replicate 720p video-input rate.'),
    ('replicate-seedance-2-0-video-ref', 'Seedance 2.0 Replicate video-ref fallback + audio', 347, true, 'replicate', 'replicate-seedance-2-0-video-ref:default:video_in:audio', null, 'Audio toggle does not change Replicate pricing; duplicate row keeps runtime lookup strict.')
) as v(row_model, row_label, row_cost, row_has_audio, row_provider, row_price_key, row_resolution, row_notes);
