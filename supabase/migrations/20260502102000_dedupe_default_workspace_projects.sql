-- Deduplicate runaway "Default project" rows and prevent new default duplicates.
--
-- Root cause:
-- Older frontend sync could upsert a freshly generated local default project id
-- on each session before/around server merge. Those rows were real
-- workspace_projects owned by the user, not team-shared projects.

BEGIN;

WITH default_projects AS (
  SELECT
    p.id,
    p.user_id,
    p.created_at,
    p.updated_at,
    COUNT(DISTINCT w.id) AS workspace_count,
    COUNT(DISTINCT c.id) AS canvas_count
  FROM public.workspace_projects p
  LEFT JOIN public.workspaces w
    ON w.project_id = p.id
  LEFT JOIN public.workspace_canvases c
    ON c.project_id = p.id
  WHERE p.name = 'Default project'
  GROUP BY p.id, p.user_id, p.created_at, p.updated_at
),
ranked AS (
  SELECT
    *,
    FIRST_VALUE(id) OVER (
      PARTITION BY user_id
      ORDER BY workspace_count DESC, canvas_count DESC, updated_at DESC, created_at ASC, id ASC
    ) AS keep_id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY workspace_count DESC, canvas_count DESC, updated_at DESC, created_at ASC, id ASC
    ) AS rn
  FROM default_projects
),
dupes AS (
  SELECT id, keep_id
  FROM ranked
  WHERE rn > 1
)
UPDATE public.workspaces w
SET project_id = d.keep_id
FROM dupes d
WHERE w.project_id = d.id;

WITH default_projects AS (
  SELECT
    p.id,
    p.user_id,
    p.created_at,
    p.updated_at,
    COUNT(DISTINCT w.id) AS workspace_count,
    COUNT(DISTINCT c.id) AS canvas_count
  FROM public.workspace_projects p
  LEFT JOIN public.workspaces w
    ON w.project_id = p.id
  LEFT JOIN public.workspace_canvases c
    ON c.project_id = p.id
  WHERE p.name = 'Default project'
  GROUP BY p.id, p.user_id, p.created_at, p.updated_at
),
ranked AS (
  SELECT
    *,
    FIRST_VALUE(id) OVER (
      PARTITION BY user_id
      ORDER BY workspace_count DESC, canvas_count DESC, updated_at DESC, created_at ASC, id ASC
    ) AS keep_id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY workspace_count DESC, canvas_count DESC, updated_at DESC, created_at ASC, id ASC
    ) AS rn
  FROM default_projects
),
dupes AS (
  SELECT id, keep_id
  FROM ranked
  WHERE rn > 1
)
UPDATE public.workspace_canvases c
SET project_id = d.keep_id
FROM dupes d
WHERE c.project_id = d.id;

WITH default_projects AS (
  SELECT
    p.id,
    p.user_id,
    p.created_at,
    p.updated_at,
    COUNT(DISTINCT w.id) AS workspace_count,
    COUNT(DISTINCT c.id) AS canvas_count
  FROM public.workspace_projects p
  LEFT JOIN public.workspaces w
    ON w.project_id = p.id
  LEFT JOIN public.workspace_canvases c
    ON c.project_id = p.id
  WHERE p.name = 'Default project'
  GROUP BY p.id, p.user_id, p.created_at, p.updated_at
),
ranked AS (
  SELECT
    *,
    FIRST_VALUE(id) OVER (
      PARTITION BY user_id
      ORDER BY workspace_count DESC, canvas_count DESC, updated_at DESC, created_at ASC, id ASC
    ) AS keep_id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY workspace_count DESC, canvas_count DESC, updated_at DESC, created_at ASC, id ASC
    ) AS rn
  FROM default_projects
),
dupes AS (
  SELECT id, keep_id
  FROM ranked
  WHERE rn > 1
)
UPDATE public.workspace_generation_jobs j
SET project_id = d.keep_id
FROM dupes d
WHERE j.project_id = d.id;

WITH default_projects AS (
  SELECT
    p.id,
    p.user_id,
    p.created_at,
    p.updated_at,
    COUNT(DISTINCT w.id) AS workspace_count,
    COUNT(DISTINCT c.id) AS canvas_count
  FROM public.workspace_projects p
  LEFT JOIN public.workspaces w
    ON w.project_id = p.id
  LEFT JOIN public.workspace_canvases c
    ON c.project_id = p.id
  WHERE p.name = 'Default project'
  GROUP BY p.id, p.user_id, p.created_at, p.updated_at
),
ranked AS (
  SELECT
    *,
    FIRST_VALUE(id) OVER (
      PARTITION BY user_id
      ORDER BY workspace_count DESC, canvas_count DESC, updated_at DESC, created_at ASC, id ASC
    ) AS keep_id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY workspace_count DESC, canvas_count DESC, updated_at DESC, created_at ASC, id ASC
    ) AS rn
  FROM default_projects
),
dupes AS (
  SELECT id, keep_id
  FROM ranked
  WHERE rn > 1
)
UPDATE public.workspace_generation_events e
SET project_id = d.keep_id
FROM dupes d
WHERE e.project_id = d.id;

WITH default_projects AS (
  SELECT
    p.id,
    p.user_id,
    p.created_at,
    p.updated_at,
    COUNT(DISTINCT w.id) AS workspace_count,
    COUNT(DISTINCT c.id) AS canvas_count
  FROM public.workspace_projects p
  LEFT JOIN public.workspaces w
    ON w.project_id = p.id
  LEFT JOIN public.workspace_canvases c
    ON c.project_id = p.id
  WHERE p.name = 'Default project'
  GROUP BY p.id, p.user_id, p.created_at, p.updated_at
),
ranked AS (
  SELECT
    *,
    FIRST_VALUE(id) OVER (
      PARTITION BY user_id
      ORDER BY workspace_count DESC, canvas_count DESC, updated_at DESC, created_at ASC, id ASC
    ) AS keep_id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY workspace_count DESC, canvas_count DESC, updated_at DESC, created_at ASC, id ASC
    ) AS rn
  FROM default_projects
),
dupes AS (
  SELECT id, keep_id
  FROM ranked
  WHERE rn > 1
)
UPDATE public.user_assets a
SET project_id = d.keep_id
FROM dupes d
WHERE a.project_id = d.id;

WITH default_projects AS (
  SELECT
    p.id,
    p.user_id,
    p.created_at,
    p.updated_at,
    COUNT(DISTINCT w.id) AS workspace_count,
    COUNT(DISTINCT c.id) AS canvas_count
  FROM public.workspace_projects p
  LEFT JOIN public.workspaces w
    ON w.project_id = p.id
  LEFT JOIN public.workspace_canvases c
    ON c.project_id = p.id
  WHERE p.name = 'Default project'
  GROUP BY p.id, p.user_id, p.created_at, p.updated_at
),
ranked AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY workspace_count DESC, canvas_count DESC, updated_at DESC, created_at ASC, id ASC
    ) AS rn
  FROM default_projects
)
DELETE FROM public.workspace_projects p
USING ranked r
WHERE p.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_projects_one_default_per_user_idx
  ON public.workspace_projects (user_id)
  WHERE name = 'Default project';

COMMIT;
