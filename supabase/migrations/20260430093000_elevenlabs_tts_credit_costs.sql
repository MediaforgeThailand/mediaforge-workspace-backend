-- ElevenLabs TTS pricing rows for Workspace audio generation.
--
-- Workspace convention: 35 THB/USD and 50 credits/THB.
-- Multilingual v2: estimated at 0.10 USD / 1K chars => 175 credits.
-- Turbo v2.5: estimated at 0.05 USD / 1K chars => 88 credits.

insert into public.credit_costs
  (feature, model, label, cost, pricing_type, duration_seconds, has_audio, provider, price_key, resolution, quality, source, source_url, provider_unit, notes)
values
  (
    'text_to_speech',
    'elevenlabs-multilingual-v2',
    'ElevenLabs Multilingual v2 / 1K chars',
    175,
    'per_1k_chars',
    null,
    false,
    'elevenlabs',
    'eleven_multilingual_v2',
    'text',
    'multilingual-v2',
    'official_docs_estimate',
    'https://elevenlabs.io/docs/models',
    'per 1K chars',
    'Estimated from ElevenLabs 1 credit per character for Multilingual v2; normalized through Workspace 50 credits/THB.'
  ),
  (
    'text_to_speech',
    'eleven_multilingual_v2',
    'ElevenLabs Multilingual v2 API alias / 1K chars',
    175,
    'per_1k_chars',
    null,
    false,
    'elevenlabs',
    'eleven_multilingual_v2',
    'text',
    'multilingual-v2',
    'official_docs_estimate',
    'https://elevenlabs.io/docs/models',
    'per 1K chars',
    'Runtime alias for callers that pass the official ElevenLabs model_id.'
  ),
  (
    'text_to_speech',
    'elevenlabs-turbo-v2-5',
    'ElevenLabs Turbo v2.5 / 1K chars',
    88,
    'per_1k_chars',
    null,
    false,
    'elevenlabs',
    'eleven_turbo_v2_5',
    'text',
    'turbo-v2.5',
    'official_docs_estimate',
    'https://elevenlabs.io/docs/models',
    'per 1K chars',
    'Estimated from ElevenLabs 0.5 credit per character for Turbo v2.5; normalized through Workspace 50 credits/THB.'
  ),
  (
    'text_to_speech',
    'eleven_turbo_v2_5',
    'ElevenLabs Turbo v2.5 API alias / 1K chars',
    88,
    'per_1k_chars',
    null,
    false,
    'elevenlabs',
    'eleven_turbo_v2_5',
    'text',
    'turbo-v2.5',
    'official_docs_estimate',
    'https://elevenlabs.io/docs/models',
    'per 1K chars',
    'Runtime alias for callers that pass the official ElevenLabs model_id.'
  )
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
  provider_unit = excluded.provider_unit,
  notes = excluded.notes,
  updated_at = now();
