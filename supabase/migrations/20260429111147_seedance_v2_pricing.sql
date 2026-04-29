-- ════════════════════════════════════════════════════════════════
--  Seedance (Bytedance / Volcengine Ark) video pricing
--  ──────────────────────────────────────────────────────────────
--  Adds credit_costs rows for the Seedance models the workspace V2
--  videoGenNode supports. Feature key reuses 'generate_freepik_video'
--  for analytics aggregation parity with Kling rows (see migration
--  20260407032430).
--
--  Pricing scheme: per_second @ tier-specific credit rate, mirroring
--  Kling 3.0 Pro's structure (per_second 500 credits / 750 with audio).
--
--  TODO(taksin): confirm rates with Volcengine Ark price list once
--  Seedance 2.0 GA pricing is published. Numbers below are estimated
--  from the legacy 1.x freepik aggregator rates (Pro=1000, Lite=600,
--  1.5-Pro=1200) re-tiered to per-second so durations 2-12s scale.
-- ════════════════════════════════════════════════════════════════

INSERT INTO public.credit_costs
  (feature, model, label, cost, pricing_type, duration_seconds, has_audio)
VALUES
  -- Seedance 1.x — kept for parity with the legacy schema
  ('generate_freepik_video', 'seedance-1-0-pro-250528',
    'SeedDance 1.0 Pro /s',           200, 'per_second', NULL, false),
  ('generate_freepik_video', 'seedance-1-0-pro-fast-251015',
    'SeedDance 1.0 Pro Fast /s',       80, 'per_second', NULL, false),
  ('generate_freepik_video', 'seedance-1-5-pro-251215',
    'SeedDance 1.5 Pro /s',           240, 'per_second', NULL, false),
  ('generate_freepik_video', 'seedance-1-5-pro-251215',
    'SeedDance 1.5 Pro /s +Audio',    320, 'per_second', NULL, true),
  -- Seedance 2.0 family — TODO confirm exact pricing once GA
  ('generate_freepik_video', 'seedance-2-0-lite',
    'SeedDance 2.0 Lite /s',          120, 'per_second', NULL, false),
  ('generate_freepik_video', 'seedance-2-0-lite',
    'SeedDance 2.0 Lite /s +Audio',   180, 'per_second', NULL, true),
  ('generate_freepik_video', 'seedance-2-0-pro',
    'SeedDance 2.0 Pro /s',           260, 'per_second', NULL, false),
  ('generate_freepik_video', 'seedance-2-0-pro',
    'SeedDance 2.0 Pro /s +Audio',    340, 'per_second', NULL, true)
ON CONFLICT (feature, COALESCE(model, '__default__'), COALESCE(duration_seconds, 0), COALESCE(has_audio, false))
DO UPDATE SET
  label = EXCLUDED.label,
  cost  = EXCLUDED.cost,
  pricing_type = EXCLUDED.pricing_type;
