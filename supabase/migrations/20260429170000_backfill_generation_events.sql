-- Backfill historical generations into workspace_generation_events.
--
-- Why this exists
-- ---------------
-- The workspace_generation_events table (20260429160000) only sees
-- FUTURE runs because the dispatcher writes one row per successful run
-- going forward. Every existing generation lives inside
-- public.workspace_canvases.nodes (jsonb) as
-- nodes[].data.generations[], invisible to the analytics query.
--
-- Without this backfill the admin /workspace/analytics dashboard shows
-- zeros even though there are 90+ real generations on disk.
--
-- What it does
-- ------------
-- Walks every canvas, flattens every generations[] entry, classifies
-- it (image/video/model_3d) and inserts one analytics row per
-- generation. Idempotent — re-running adds zero rows because of the
-- NOT EXISTS guard on (canvas_id, node_id, created_at).
--
-- Field-derivation notes
-- ----------------------
--   feature     ← g.type ('image'|'video') + node-type fallback for 3D.
--   model       ← g.model || params.model_name || params.model || 'unknown'.
--   output_tier ← pixel-derived if g has width/height (rare in old rows),
--                 else null. Old generations stored only id/url/createdAt
--                 and the dispatcher's tier classifier needs width — we
--                 leave tier null rather than guess wrong.
--   width/height/duration_seconds — best-effort from gen object first,
--                 then from params (`size`="1024x1024", `duration`,
--                 `duration_seconds`).
--   credits_spent — from g.credit_cost if present, else null. The legacy
--                 V2 sandbox didn't write back per-gen costs into the
--                 jsonb so this is mostly null in old rows.
--   created_at  ← g.createdAt (epoch ms) || canvas.updated_at fallback.
--
-- Edge cases
-- ----------
--   - canvas with nodes = null / empty array → naturally skipped
--   - generations missing url → filtered out
--   - generations missing createdAt → fall back to canvas.updated_at
--   - generations missing model name → 'unknown'
--   - workspace_canvases.user_id is NOT NULL → no orphan-canvas worry

insert into public.workspace_generation_events
  (user_id, workspace_id, canvas_id, node_id,
   feature, model, output_tier, output_count,
   width, height, duration_seconds, aspect_ratio,
   credits_spent, status, created_at)
select
  wc.user_id,
  wc.workspace_id,
  wc.id::text,
  n->>'id',
  -- feature: node-type wins for special cases (3D / video / chat).
  -- imageTo3dNode emits gen.type='image' (preview frame), but we want
  -- to bucket those as model_3d for analytics. Otherwise fall back to
  -- the gen.type field.
  case
    when n->>'type' = 'imageTo3dNode' then 'model_3d'
    when n->>'type' ilike '%3d%' or n->>'type' ilike '%tripo%' then 'model_3d'
    when n->>'type' ilike '%audio%' then 'audio'
    when (g->>'type') in ('image','video','audio','text') then g->>'type'
    when n->>'type' = 'videoGenNode' then 'video'
    when n->>'type' = 'imageGenNode' then 'image'
    when n->>'type' = 'chatAiNode' then 'text'
    when n->>'type' = 'videoToPromptNode' then 'text'
    else 'image'
  end as feature,
  -- model: gen first, then params.model_name, then params.model, else 'unknown'
  coalesce(
    nullif(g->>'model', ''),
    nullif(n->'data'->'params'->>'model_name', ''),
    nullif(n->'data'->'params'->>'model', ''),
    'unknown'
  ) as model,
  -- output_tier: bucket on the bigger of (width, height) when known.
  -- Old generations rarely stored width/height, so most rows land null.
  case
    when greatest(
      coalesce((g->>'width')::int, 0),
      coalesce((g->>'height')::int, 0)
    ) >= 1920 then '2k'
    when greatest(
      coalesce((g->>'width')::int, 0),
      coalesce((g->>'height')::int, 0)
    ) >= 1280 then 'high'
    when greatest(
      coalesce((g->>'width')::int, 0),
      coalesce((g->>'height')::int, 0)
    ) >= 768  then 'medium'
    when greatest(
      coalesce((g->>'width')::int, 0),
      coalesce((g->>'height')::int, 0)
    ) > 0 then 'low'
    else null
  end as output_tier,
  1 as output_count,
  -- width / height: gen first, else parse params.size like "1024x1024"
  coalesce(
    nullif(g->>'width', '')::int,
    case when (n->'data'->'params'->>'size') ~ '^\d+x\d+$'
         then split_part(n->'data'->'params'->>'size', 'x', 1)::int
         else null
    end
  ) as width,
  coalesce(
    nullif(g->>'height', '')::int,
    case when (n->'data'->'params'->>'size') ~ '^\d+x\d+$'
         then split_part(n->'data'->'params'->>'size', 'x', 2)::int
         else null
    end
  ) as height,
  -- duration_seconds: gen first, else params.duration_seconds, else params.duration
  coalesce(
    nullif(g->>'duration_seconds', '')::numeric,
    nullif(n->'data'->'params'->>'duration_seconds', '')::numeric,
    nullif(n->'data'->'params'->>'duration', '')::numeric
  ) as duration_seconds,
  nullif(n->'data'->'params'->>'aspect_ratio', '') as aspect_ratio,
  nullif(g->>'credit_cost', '')::int as credits_spent,
  'completed' as status,
  -- createdAt is epoch ms in the canvas jsonb. Fall back to wc.updated_at
  -- so old rows still sort somewhere reasonable.
  coalesce(
    case when (g->>'createdAt') ~ '^\d+$'
         then to_timestamp((g->>'createdAt')::bigint / 1000.0)
         else null
    end,
    wc.updated_at
  ) as created_at
from public.workspace_canvases wc
left join lateral jsonb_array_elements(coalesce(wc.nodes, '[]'::jsonb)) n on true
left join lateral jsonb_array_elements(coalesce(n->'data'->'generations', '[]'::jsonb)) g on true
where (g->>'url') is not null
  and not exists (
    select 1
    from public.workspace_generation_events e
    where e.canvas_id = wc.id::text
      and e.node_id   = (n->>'id')
      and e.created_at = coalesce(
        case when (g->>'createdAt') ~ '^\d+$'
             then to_timestamp((g->>'createdAt')::bigint / 1000.0)
             else null
        end,
        wc.updated_at
      )
  );
