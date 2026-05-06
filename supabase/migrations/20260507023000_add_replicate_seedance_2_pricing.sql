delete from public.credit_costs
where feature = 'generate_freepik_video'
  and model like 'replicate-seedance-2-0%';

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
  'replicate',
  row_price_key,
  row_resolution,
  'replicate_docs',
  'https://replicate.com/bytedance/seedance-2.0',
  'per second',
  row_notes
from (
  values
    ('replicate-seedance-2-0:480p', 'Seedance 2.0 Replicate 480p', 140, false, '480p', 'replicate-seedance-2-0:480p:non_video_in:silent', 'Replicate bytedance/seedance-2.0 non-video input 480p costs $0.08/sec.'),
    ('replicate-seedance-2-0:480p', 'Seedance 2.0 Replicate 480p + audio', 140, true, '480p', 'replicate-seedance-2-0:480p:non_video_in:audio', 'Replicate bytedance/seedance-2.0 audio toggle does not change provider price; keep a strict audio row for runtime lookup.'),
    ('replicate-seedance-2-0:720p', 'Seedance 2.0 Replicate 720p', 315, false, '720p', 'replicate-seedance-2-0:720p:non_video_in:silent', 'Replicate bytedance/seedance-2.0 non-video input 720p costs $0.18/sec.'),
    ('replicate-seedance-2-0:720p', 'Seedance 2.0 Replicate 720p + audio', 315, true, '720p', 'replicate-seedance-2-0:720p:non_video_in:audio', 'Replicate bytedance/seedance-2.0 audio toggle does not change provider price; keep a strict audio row for runtime lookup.'),
    ('replicate-seedance-2-0:1080p', 'Seedance 2.0 Replicate 1080p', 788, false, '1080p', 'replicate-seedance-2-0:1080p:non_video_in:silent', 'Replicate bytedance/seedance-2.0 non-video input 1080p costs $0.45/sec.'),
    ('replicate-seedance-2-0:1080p', 'Seedance 2.0 Replicate 1080p + audio', 788, true, '1080p', 'replicate-seedance-2-0:1080p:non_video_in:audio', 'Replicate bytedance/seedance-2.0 audio toggle does not change provider price; keep a strict audio row for runtime lookup.'),
    ('replicate-seedance-2-0', 'Seedance 2.0 Replicate fallback', 315, false, null, 'replicate-seedance-2-0:default:non_video_in:silent', 'Fallback when runtime receives no resolution; uses 720p non-video-input rate.'),
    ('replicate-seedance-2-0', 'Seedance 2.0 Replicate fallback + audio', 315, true, null, 'replicate-seedance-2-0:default:non_video_in:audio', 'Fallback when runtime receives no resolution; audio toggle does not change provider price.'),
    ('replicate-seedance-2-0-video-ref:480p', 'Seedance 2.0 Replicate 480p + video ref', 175, false, '480p', 'replicate-seedance-2-0-video-ref:480p:video_in:silent', 'Replicate bytedance/seedance-2.0 video input 480p costs $0.10/sec.'),
    ('replicate-seedance-2-0-video-ref:480p', 'Seedance 2.0 Replicate 480p + video ref + audio', 175, true, '480p', 'replicate-seedance-2-0-video-ref:480p:video_in:audio', 'Replicate bytedance/seedance-2.0 audio toggle does not change provider price; video input 480p costs $0.10/sec.'),
    ('replicate-seedance-2-0-video-ref:720p', 'Seedance 2.0 Replicate 720p + video ref', 385, false, '720p', 'replicate-seedance-2-0-video-ref:720p:video_in:silent', 'Replicate bytedance/seedance-2.0 video input 720p costs $0.22/sec.'),
    ('replicate-seedance-2-0-video-ref:720p', 'Seedance 2.0 Replicate 720p + video ref + audio', 385, true, '720p', 'replicate-seedance-2-0-video-ref:720p:video_in:audio', 'Replicate bytedance/seedance-2.0 audio toggle does not change provider price; video input 720p costs $0.22/sec.'),
    ('replicate-seedance-2-0-video-ref:1080p', 'Seedance 2.0 Replicate 1080p + video ref', 963, false, '1080p', 'replicate-seedance-2-0-video-ref:1080p:video_in:silent', 'Replicate bytedance/seedance-2.0 video input 1080p costs $0.55/sec.'),
    ('replicate-seedance-2-0-video-ref:1080p', 'Seedance 2.0 Replicate 1080p + video ref + audio', 963, true, '1080p', 'replicate-seedance-2-0-video-ref:1080p:video_in:audio', 'Replicate bytedance/seedance-2.0 audio toggle does not change provider price; video input 1080p costs $0.55/sec.'),
    ('replicate-seedance-2-0-video-ref', 'Seedance 2.0 Replicate video-ref fallback', 385, false, null, 'replicate-seedance-2-0-video-ref:default:video_in:silent', 'Fallback when runtime receives video input without resolution; uses 720p video-input rate.'),
    ('replicate-seedance-2-0-video-ref', 'Seedance 2.0 Replicate video-ref fallback + audio', 385, true, null, 'replicate-seedance-2-0-video-ref:default:video_in:audio', 'Fallback when runtime receives video input without resolution; audio toggle does not change provider price.')
) as v(row_model, row_label, row_cost, row_has_audio, row_resolution, row_price_key, row_notes);
