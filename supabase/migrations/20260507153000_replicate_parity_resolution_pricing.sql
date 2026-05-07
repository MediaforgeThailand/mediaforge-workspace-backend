delete from public.credit_costs
where (
    feature = 'generate_openai_image'
    and model like 'gpt-image-2:%'
  )
  or (
    feature = 'generate_freepik_image'
    and model like 'replicate-nano-banana%'
  )
  or (
    feature = 'generate_freepik_video'
    and (
      model like 'seedance-2-0-lite%'
      or model like 'seedance-2-0-pro%'
      or model like 'dreamina-seedance-2-0%'
      or model like 'replicate-seedance-2-0%'
      or model like 'replicate-kling-v3%'
      or model = 'replicate-veo-3-1'
      or model in (
        'kling-v3-pro:720p',
        'kling-v3-pro:1080p',
        'kling-v3-omni:720p',
        'kling-v3-omni:1080p',
        'kling-v3-motion-pro:720p',
        'kling-v3-motion-pro:1080p'
      )
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
  'replicate_docs',
  'https://replicate.com/openai/gpt-image-2',
  1,
  'per image',
  'Replicate openai/gpt-image-2 bills by quality per output image; resolution is kept only for runtime matching.'
from (
  values
    ('1k', 'low', 21),
    ('1k', 'medium', 83),
    ('1k', 'high', 224),
    ('1k', 'auto', 224),
    ('2k', 'low', 21),
    ('2k', 'medium', 83),
    ('2k', 'high', 224),
    ('2k', 'auto', 224),
    ('4k', 'low', 21),
    ('4k', 'medium', 83),
    ('4k', 'high', 224),
    ('4k', 'auto', 224)
) as v(tier, quality, cost);

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
  'generate_freepik_image',
  row_model,
  row_label,
  row_cost,
  'per_operation',
  null,
  false,
  'replicate',
  row_model,
  row_resolution,
  null,
  'replicate_docs',
  row_source_url,
  1,
  'per image',
  row_notes
from (
  values
    ('replicate-nano-banana-2', 'Replicate Nano Banana 2', 69, null, 'https://replicate.com/google/nano-banana', 'Replicate google/nano-banana is $0.039/image and has no resolution parameter.'),
    ('replicate-nano-banana-2:1k', 'Replicate Nano Banana 2 legacy 1K', 69, '1K', 'https://replicate.com/google/nano-banana', 'Legacy saved-node alias; Replicate google/nano-banana is fixed $0.039/image.'),
    ('replicate-nano-banana-2:2k', 'Replicate Nano Banana 2 legacy 2K', 69, '2K', 'https://replicate.com/google/nano-banana', 'Legacy saved-node alias; Replicate google/nano-banana is fixed $0.039/image.'),
    ('replicate-nano-banana-pro', 'Replicate Nano Banana Pro fallback', 263, '2K', 'https://replicate.com/google/nano-banana-pro', 'Replicate google/nano-banana-pro 1K/2K is $0.15/image.'),
    ('replicate-nano-banana-pro:1k', 'Replicate Nano Banana Pro 1K', 263, '1K', 'https://replicate.com/google/nano-banana-pro', 'Replicate google/nano-banana-pro 1K is $0.15/image.'),
    ('replicate-nano-banana-pro:2k', 'Replicate Nano Banana Pro 2K', 263, '2K', 'https://replicate.com/google/nano-banana-pro', 'Replicate google/nano-banana-pro 2K is $0.15/image.'),
    ('replicate-nano-banana-pro:4k', 'Replicate Nano Banana Pro 4K', 525, '4K', 'https://replicate.com/google/nano-banana-pro', 'Replicate google/nano-banana-pro 4K is $0.30/image.')
) as v(row_model, row_label, row_cost, row_resolution, row_source_url, row_notes);

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
  null,
  'replicate_docs',
  row_source_url,
  1,
  'per second',
  row_notes
from (
  values
    ('seedance-2-0-lite:480p', 'Seedance 2.0 Fast 480p', 140, false, 'seedance', 'seedance-2-0-lite:480p:non_video_in:silent', '480p', 'https://replicate.com/bytedance/seedance-2.0', 'Replicate non-video input 480p is $0.08/sec.'),
    ('seedance-2-0-lite:720p', 'Seedance 2.0 Fast 720p', 315, false, 'seedance', 'seedance-2-0-lite:720p:non_video_in:silent', '720p', 'https://replicate.com/bytedance/seedance-2.0', 'Replicate non-video input 720p is $0.18/sec.'),
    ('seedance-2-0-lite', 'Seedance 2.0 Fast fallback', 315, false, 'seedance', 'seedance-2-0-lite:default:non_video_in:silent', null, 'https://replicate.com/bytedance/seedance-2.0', 'Fallback uses Replicate 720p non-video-input rate.'),
    ('dreamina-seedance-2-0-fast-260128', 'Seedance 2.0 Fast direct-id fallback', 315, false, 'seedance', 'dreamina-seedance-2-0-fast-260128:default:non_video_in:silent', null, 'https://replicate.com/bytedance/seedance-2.0', 'Direct BytePlus alias uses Replicate 720p non-video-input rate.'),
    ('seedance-2-0-pro:480p', 'Seedance 2.0 Pro 480p', 140, false, 'seedance', 'seedance-2-0-pro:480p:non_video_in:silent', '480p', 'https://replicate.com/bytedance/seedance-2.0', 'Replicate non-video input 480p is $0.08/sec.'),
    ('seedance-2-0-pro:720p', 'Seedance 2.0 Pro 720p', 315, false, 'seedance', 'seedance-2-0-pro:720p:non_video_in:silent', '720p', 'https://replicate.com/bytedance/seedance-2.0', 'Replicate non-video input 720p is $0.18/sec.'),
    ('seedance-2-0-pro:1080p', 'Seedance 2.0 Pro 1080p', 788, false, 'seedance', 'seedance-2-0-pro:1080p:non_video_in:silent', '1080p', 'https://replicate.com/bytedance/seedance-2.0', 'Replicate non-video input 1080p is $0.45/sec.'),
    ('seedance-2-0-pro', 'Seedance 2.0 Pro fallback', 315, false, 'seedance', 'seedance-2-0-pro:default:non_video_in:silent', null, 'https://replicate.com/bytedance/seedance-2.0', 'Fallback uses Replicate 720p non-video-input rate.'),
    ('dreamina-seedance-2-0-260128', 'Seedance 2.0 Pro direct-id fallback', 315, false, 'seedance', 'dreamina-seedance-2-0-260128:default:non_video_in:silent', null, 'https://replicate.com/bytedance/seedance-2.0', 'Direct BytePlus alias uses Replicate 720p non-video-input rate.'),
    ('replicate-seedance-2-0:480p', 'Seedance 2.0 Replicate 480p', 140, false, 'replicate', 'replicate-seedance-2-0:480p:non_video_in:silent', '480p', 'https://replicate.com/bytedance/seedance-2.0', 'Replicate non-video input 480p is $0.08/sec.'),
    ('replicate-seedance-2-0:480p', 'Seedance 2.0 Replicate 480p + audio', 140, true, 'replicate', 'replicate-seedance-2-0:480p:non_video_in:audio', '480p', 'https://replicate.com/bytedance/seedance-2.0', 'Audio toggle does not change Replicate Seedance pricing.'),
    ('replicate-seedance-2-0:720p', 'Seedance 2.0 Replicate 720p', 315, false, 'replicate', 'replicate-seedance-2-0:720p:non_video_in:silent', '720p', 'https://replicate.com/bytedance/seedance-2.0', 'Replicate non-video input 720p is $0.18/sec.'),
    ('replicate-seedance-2-0:720p', 'Seedance 2.0 Replicate 720p + audio', 315, true, 'replicate', 'replicate-seedance-2-0:720p:non_video_in:audio', '720p', 'https://replicate.com/bytedance/seedance-2.0', 'Audio toggle does not change Replicate Seedance pricing.'),
    ('replicate-seedance-2-0:1080p', 'Seedance 2.0 Replicate 1080p', 788, false, 'replicate', 'replicate-seedance-2-0:1080p:non_video_in:silent', '1080p', 'https://replicate.com/bytedance/seedance-2.0', 'Replicate non-video input 1080p is $0.45/sec.'),
    ('replicate-seedance-2-0:1080p', 'Seedance 2.0 Replicate 1080p + audio', 788, true, 'replicate', 'replicate-seedance-2-0:1080p:non_video_in:audio', '1080p', 'https://replicate.com/bytedance/seedance-2.0', 'Audio toggle does not change Replicate Seedance pricing.'),
    ('replicate-seedance-2-0', 'Seedance 2.0 Replicate fallback', 315, false, 'replicate', 'replicate-seedance-2-0:default:non_video_in:silent', null, 'https://replicate.com/bytedance/seedance-2.0', 'Fallback uses Replicate 720p non-video-input rate.'),
    ('replicate-seedance-2-0', 'Seedance 2.0 Replicate fallback + audio', 315, true, 'replicate', 'replicate-seedance-2-0:default:non_video_in:audio', null, 'https://replicate.com/bytedance/seedance-2.0', 'Audio toggle does not change Replicate Seedance pricing.'),
    ('replicate-seedance-2-0-video-ref:480p', 'Seedance 2.0 Replicate 480p + video ref', 175, false, 'replicate', 'replicate-seedance-2-0-video-ref:480p:video_in:silent', '480p', 'https://replicate.com/bytedance/seedance-2.0', 'Replicate video input 480p is $0.10/sec.'),
    ('replicate-seedance-2-0-video-ref:480p', 'Seedance 2.0 Replicate 480p + video ref + audio', 175, true, 'replicate', 'replicate-seedance-2-0-video-ref:480p:video_in:audio', '480p', 'https://replicate.com/bytedance/seedance-2.0', 'Audio toggle does not change Replicate Seedance pricing.'),
    ('replicate-seedance-2-0-video-ref:720p', 'Seedance 2.0 Replicate 720p + video ref', 385, false, 'replicate', 'replicate-seedance-2-0-video-ref:720p:video_in:silent', '720p', 'https://replicate.com/bytedance/seedance-2.0', 'Replicate video input 720p is $0.22/sec.'),
    ('replicate-seedance-2-0-video-ref:720p', 'Seedance 2.0 Replicate 720p + video ref + audio', 385, true, 'replicate', 'replicate-seedance-2-0-video-ref:720p:video_in:audio', '720p', 'https://replicate.com/bytedance/seedance-2.0', 'Audio toggle does not change Replicate Seedance pricing.'),
    ('replicate-seedance-2-0-video-ref:1080p', 'Seedance 2.0 Replicate 1080p + video ref', 963, false, 'replicate', 'replicate-seedance-2-0-video-ref:1080p:video_in:silent', '1080p', 'https://replicate.com/bytedance/seedance-2.0', 'Replicate video input 1080p is $0.55/sec.'),
    ('replicate-seedance-2-0-video-ref:1080p', 'Seedance 2.0 Replicate 1080p + video ref + audio', 963, true, 'replicate', 'replicate-seedance-2-0-video-ref:1080p:video_in:audio', '1080p', 'https://replicate.com/bytedance/seedance-2.0', 'Audio toggle does not change Replicate Seedance pricing.'),
    ('replicate-seedance-2-0-video-ref', 'Seedance 2.0 Replicate video-ref fallback', 385, false, 'replicate', 'replicate-seedance-2-0-video-ref:default:video_in:silent', null, 'https://replicate.com/bytedance/seedance-2.0', 'Fallback uses Replicate 720p video-input rate.'),
    ('replicate-seedance-2-0-video-ref', 'Seedance 2.0 Replicate video-ref fallback + audio', 385, true, 'replicate', 'replicate-seedance-2-0-video-ref:default:video_in:audio', null, 'https://replicate.com/bytedance/seedance-2.0', 'Audio toggle does not change Replicate Seedance pricing.'),
    ('replicate-veo-3-1', 'Replicate Veo 3.1 no audio', 350, false, 'replicate', 'replicate-veo-3-1:without_audio', null, 'https://replicate.com/google/veo-3.1', 'Replicate google/veo-3.1 without_audio is $0.20/sec.'),
    ('replicate-veo-3-1', 'Replicate Veo 3.1 with audio', 700, true, 'replicate', 'replicate-veo-3-1:with_audio', null, 'https://replicate.com/google/veo-3.1', 'Replicate google/veo-3.1 with_audio is $0.40/sec.'),
    ('kling-v3-pro:720p', 'Kling 3 Pro 720p', 294, false, 'kling', 'kling-v3-pro:720p:silent', '720p', 'https://replicate.com/kwaivgi/kling-v3-video', 'Replicate parity: standard without audio is $0.168/sec.'),
    ('kling-v3-pro:720p', 'Kling 3 Pro 720p + audio', 441, true, 'kling', 'kling-v3-pro:720p:audio', '720p', 'https://replicate.com/kwaivgi/kling-v3-video', 'Replicate parity: standard with audio is $0.252/sec.'),
    ('kling-v3-pro:1080p', 'Kling 3 Pro 1080p', 392, false, 'kling', 'kling-v3-pro:1080p:silent', '1080p', 'https://replicate.com/kwaivgi/kling-v3-video', 'Replicate parity: pro without audio is $0.224/sec.'),
    ('kling-v3-pro:1080p', 'Kling 3 Pro 1080p + audio', 588, true, 'kling', 'kling-v3-pro:1080p:audio', '1080p', 'https://replicate.com/kwaivgi/kling-v3-video', 'Replicate parity: pro with audio is $0.336/sec.'),
    ('kling-v3-omni:720p', 'Kling 3 Omni 720p', 294, false, 'kling', 'kling-v3-omni:720p:silent', '720p', 'https://replicate.com/kwaivgi/kling-v3-omni-video', 'Replicate parity: standard without audio is $0.168/sec.'),
    ('kling-v3-omni:720p', 'Kling 3 Omni 720p + audio', 392, true, 'kling', 'kling-v3-omni:720p:audio', '720p', 'https://replicate.com/kwaivgi/kling-v3-omni-video', 'Replicate parity: standard with audio is $0.224/sec.'),
    ('kling-v3-omni:1080p', 'Kling 3 Omni 1080p', 392, false, 'kling', 'kling-v3-omni:1080p:silent', '1080p', 'https://replicate.com/kwaivgi/kling-v3-omni-video', 'Replicate parity: pro without audio is $0.224/sec.'),
    ('kling-v3-omni:1080p', 'Kling 3 Omni 1080p + audio', 490, true, 'kling', 'kling-v3-omni:1080p:audio', '1080p', 'https://replicate.com/kwaivgi/kling-v3-omni-video', 'Replicate parity: pro with audio is $0.28/sec.'),
    ('kling-v3-motion-pro:720p', 'Kling 3 Motion 720p', 123, false, 'kling', 'kling-v3-motion-pro:720p:silent', '720p', 'https://replicate.com/kwaivgi/kling-v3-motion-control', 'Replicate parity: std is $0.07/sec.'),
    ('kling-v3-motion-pro:1080p', 'Kling 3 Motion 1080p', 210, false, 'kling', 'kling-v3-motion-pro:1080p:silent', '1080p', 'https://replicate.com/kwaivgi/kling-v3-motion-control', 'Replicate parity: pro is $0.12/sec.'),
    ('replicate-kling-v3-pro:standard', 'Replicate Kling 3 Pro 720p', 294, false, 'replicate', 'replicate-kling-v3-pro:standard:silent', '720p', 'https://replicate.com/kwaivgi/kling-v3-video', 'Replicate standard without audio is $0.168/sec.'),
    ('replicate-kling-v3-pro:standard', 'Replicate Kling 3 Pro 720p + audio', 441, true, 'replicate', 'replicate-kling-v3-pro:standard:audio', '720p', 'https://replicate.com/kwaivgi/kling-v3-video', 'Replicate standard with audio is $0.252/sec.'),
    ('replicate-kling-v3-pro:pro', 'Replicate Kling 3 Pro 1080p', 392, false, 'replicate', 'replicate-kling-v3-pro:pro:silent', '1080p', 'https://replicate.com/kwaivgi/kling-v3-video', 'Replicate pro without audio is $0.224/sec.'),
    ('replicate-kling-v3-pro:pro', 'Replicate Kling 3 Pro 1080p + audio', 588, true, 'replicate', 'replicate-kling-v3-pro:pro:audio', '1080p', 'https://replicate.com/kwaivgi/kling-v3-video', 'Replicate pro with audio is $0.336/sec.'),
    ('replicate-kling-v3-pro:4k', 'Replicate Kling 3 Pro 4K', 735, false, 'replicate', 'replicate-kling-v3-pro:4k:silent', '4K', 'https://replicate.com/kwaivgi/kling-v3-video', 'Replicate 4K is $0.42/sec.'),
    ('replicate-kling-v3-pro:4k', 'Replicate Kling 3 Pro 4K + audio', 735, true, 'replicate', 'replicate-kling-v3-pro:4k:audio', '4K', 'https://replicate.com/kwaivgi/kling-v3-video', 'Replicate 4K is $0.42/sec.'),
    ('replicate-kling-v3-omni:standard', 'Replicate Kling 3 Omni 720p', 294, false, 'replicate', 'replicate-kling-v3-omni:standard:silent', '720p', 'https://replicate.com/kwaivgi/kling-v3-omni-video', 'Replicate standard without audio is $0.168/sec.'),
    ('replicate-kling-v3-omni:standard', 'Replicate Kling 3 Omni 720p + audio', 392, true, 'replicate', 'replicate-kling-v3-omni:standard:audio', '720p', 'https://replicate.com/kwaivgi/kling-v3-omni-video', 'Replicate standard with audio is $0.224/sec.'),
    ('replicate-kling-v3-omni:pro', 'Replicate Kling 3 Omni 1080p', 392, false, 'replicate', 'replicate-kling-v3-omni:pro:silent', '1080p', 'https://replicate.com/kwaivgi/kling-v3-omni-video', 'Replicate pro without audio is $0.224/sec.'),
    ('replicate-kling-v3-omni:pro', 'Replicate Kling 3 Omni 1080p + audio', 490, true, 'replicate', 'replicate-kling-v3-omni:pro:audio', '1080p', 'https://replicate.com/kwaivgi/kling-v3-omni-video', 'Replicate pro with audio is $0.28/sec.'),
    ('replicate-kling-v3-omni:4k', 'Replicate Kling 3 Omni 4K', 735, false, 'replicate', 'replicate-kling-v3-omni:4k:silent', '4K', 'https://replicate.com/kwaivgi/kling-v3-omni-video', 'Replicate 4K is $0.42/sec.'),
    ('replicate-kling-v3-omni:4k', 'Replicate Kling 3 Omni 4K + audio', 735, true, 'replicate', 'replicate-kling-v3-omni:4k:audio', '4K', 'https://replicate.com/kwaivgi/kling-v3-omni-video', 'Replicate 4K is $0.42/sec.'),
    ('replicate-kling-v3-motion-pro:std', 'Replicate Kling 3 Motion 720p', 123, false, 'replicate', 'replicate-kling-v3-motion-pro:std:silent', '720p', 'https://replicate.com/kwaivgi/kling-v3-motion-control', 'Replicate std is $0.07/sec.'),
    ('replicate-kling-v3-motion-pro:pro', 'Replicate Kling 3 Motion 1080p', 210, false, 'replicate', 'replicate-kling-v3-motion-pro:pro:silent', '1080p', 'https://replicate.com/kwaivgi/kling-v3-motion-control', 'Replicate pro is $0.12/sec.')
) as v(row_model, row_label, row_cost, row_has_audio, row_provider, row_price_key, row_resolution, row_source_url, row_notes);
