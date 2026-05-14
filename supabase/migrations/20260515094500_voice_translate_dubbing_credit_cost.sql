-- Workspace Voice Translate / Dubbing pricing.
--
-- Conservative Creator-plan estimate for ElevenLabs Dubbing voice clone:
-- 0.92 USD / media minute -> 0.92 * 35 THB/USD * 50 credits/THB = 1610 credits/min.

insert into public.credit_costs
  (feature, model, label, cost, pricing_type, duration_seconds, has_audio, provider, price_key, resolution, quality, source, source_url, provider_unit, notes)
values
  (
    'voice_translate',
    'elevenlabs-dubbing-voice-clone',
    'ElevenLabs Dubbing Voice Clone / min',
    1610,
    'per_minute',
    null,
    false,
    'elevenlabs',
    'dubbing:voice-clone',
    'media',
    'voice-clone',
    'official_docs_estimate',
    'https://help.elevenlabs.io/hc/en-us/articles/23338815703697-How-much-does-Dubbing-cost',
    'per media minute',
    'Conservative Creator-plan estimate from ElevenLabs credit-based dubbing guidance; runtime bills by source media duration and auto-returns MP3/MP4 based on input.'
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
