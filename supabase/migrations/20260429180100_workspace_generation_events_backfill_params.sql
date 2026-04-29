-- Backfill params jsonb for historical workspace_generation_events.
--
-- Strategy
-- --------
-- Walk every canvas, match its (canvas_id, node_id) tuple back to the
-- analytics row(s) we already inserted in 20260429170000, and write a
-- whitelisted slice of node.data.params into the new params column.
--
-- Whitelist
-- ---------
--   quality, size, image_size, resolution, aspect_ratio,
--   duration_seconds, has_audio, format, output_format
-- Anything else (prompt, image URLs, internal flags) stays out.
--
-- Idempotency
-- -----------
-- Only updates rows where params is null AND the canvas slot still has
-- at least one whitelisted key. Re-running is a no-op.

with whitelisted as (
  select
    wc.id::text as canvas_id,
    n->>'id'    as node_id,
    -- jsonb_strip_nulls drops keys whose value is JSON null. We then
    -- additionally drop empty-string and "false-y" zero entries by
    -- rebuilding only over keys that survived the projection below.
    jsonb_strip_nulls(jsonb_build_object(
      'quality',          nullif(n->'data'->'params'->>'quality', ''),
      'size',             nullif(n->'data'->'params'->>'size', ''),
      'image_size',       nullif(n->'data'->'params'->>'image_size', ''),
      'resolution',       nullif(n->'data'->'params'->>'resolution', ''),
      'aspect_ratio',     nullif(n->'data'->'params'->>'aspect_ratio', ''),
      'duration_seconds', case
        when (n->'data'->'params'->>'duration_seconds') ~ '^[0-9.]+$'
          then (n->'data'->'params'->>'duration_seconds')::numeric
        when (n->'data'->'params'->>'duration') ~ '^[0-9.]+$'
          then (n->'data'->'params'->>'duration')::numeric
        else null
      end,
      'has_audio',        case
        when (n->'data'->'params'->>'has_audio') in ('true','True','TRUE','1') then true
        when (n->'data'->'params'->>'has_audio') in ('false','False','FALSE','0') then false
        else null
      end,
      'format',           nullif(n->'data'->'params'->>'format', ''),
      'output_format',    nullif(n->'data'->'params'->>'output_format', '')
    )) as p
  from public.workspace_canvases wc
  left join lateral jsonb_array_elements(coalesce(wc.nodes, '[]'::jsonb)) n on true
  where n is not null
)
update public.workspace_generation_events e
set params = w.p
from whitelisted w
where e.canvas_id = w.canvas_id
  and e.node_id   = w.node_id
  and e.params is null
  and w.p <> '{}'::jsonb;
