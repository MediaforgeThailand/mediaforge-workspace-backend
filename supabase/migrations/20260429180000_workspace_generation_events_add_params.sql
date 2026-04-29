-- Add params jsonb column to workspace_generation_events.
--
-- Why this exists
-- ---------------
-- The generation log already stores feature/model/output_tier, but each
-- model has its own cost-driving knobs that aren't captured: GPT-Image's
-- `quality`, Banana's `image_size`, Kling's `duration_seconds` &
-- `has_audio`, etc. Surfacing these on the admin Recent Generations
-- table makes credit-cost spot-checks possible without diving into the
-- canvas jsonb.
--
-- Whitelist (set at the dispatcher / backfill site, NOT enforced here)
--   { quality, size, image_size, resolution, aspect_ratio,
--     duration_seconds, has_audio, format, output_format }
-- Empty / null values are dropped before insert. We do NOT store the
-- raw params bag — that would leak prompts and uploaded image URLs.

alter table public.workspace_generation_events
  add column if not exists params jsonb;

comment on column public.workspace_generation_events.params is
  'Whitelisted cost-driving settings (quality, size, image_size, resolution, aspect_ratio, duration_seconds, has_audio, format, output_format). Set by workspace-run-node dispatcher; null for older rows until the backfill walks workspace_canvases.';
