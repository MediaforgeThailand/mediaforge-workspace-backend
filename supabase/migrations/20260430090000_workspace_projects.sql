-- Account > project > space/workspace > asset hierarchy for Workspace.
--
-- Existing `workspaces` rows are spaces. This migration introduces an
-- explicit project layer above them and denormalises project_id onto
-- canvases, generation jobs/events, and assets for fast scoping.

BEGIN;

CREATE TABLE IF NOT EXISTS public.workspace_projects (
  id          text        primary key,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  name        text        not null default 'Untitled project',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

CREATE INDEX IF NOT EXISTS workspace_projects_user_updated_idx
  ON public.workspace_projects (user_id, updated_at desc);

CREATE OR REPLACE FUNCTION public.workspace_projects_touch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_projects_touch_trg ON public.workspace_projects;
CREATE TRIGGER workspace_projects_touch_trg
  BEFORE UPDATE ON public.workspace_projects
  FOR EACH ROW
  EXECUTE FUNCTION public.workspace_projects_touch();

ALTER TABLE public.workspace_projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workspace_projects own select" ON public.workspace_projects;
CREATE POLICY "workspace_projects own select"
  ON public.workspace_projects FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "workspace_projects own insert" ON public.workspace_projects;
CREATE POLICY "workspace_projects own insert"
  ON public.workspace_projects FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "workspace_projects own update" ON public.workspace_projects;
CREATE POLICY "workspace_projects own update"
  ON public.workspace_projects FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "workspace_projects own delete" ON public.workspace_projects;
CREATE POLICY "workspace_projects own delete"
  ON public.workspace_projects FOR DELETE
  USING (auth.uid() = user_id);

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS project_id text
    REFERENCES public.workspace_projects(id) ON DELETE SET NULL;

ALTER TABLE public.workspace_canvases
  ADD COLUMN IF NOT EXISTS project_id text
    REFERENCES public.workspace_projects(id) ON DELETE SET NULL;

ALTER TABLE public.workspace_generation_jobs
  ADD COLUMN IF NOT EXISTS project_id text
    REFERENCES public.workspace_projects(id) ON DELETE SET NULL;

ALTER TABLE public.workspace_generation_events
  ADD COLUMN IF NOT EXISTS project_id text
    REFERENCES public.workspace_projects(id) ON DELETE SET NULL;

ALTER TABLE public.user_assets
  ADD COLUMN IF NOT EXISTS project_id text
    REFERENCES public.workspace_projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS workspace_id text,
  ADD COLUMN IF NOT EXISTS canvas_id text;

CREATE INDEX IF NOT EXISTS workspaces_user_project_updated_idx
  ON public.workspaces (user_id, project_id, updated_at desc);
CREATE INDEX IF NOT EXISTS workspace_canvases_user_project_updated_idx
  ON public.workspace_canvases (user_id, project_id, updated_at desc);
CREATE INDEX IF NOT EXISTS workspace_generation_jobs_user_project_created_idx
  ON public.workspace_generation_jobs (user_id, project_id, created_at desc);
CREATE INDEX IF NOT EXISTS workspace_generation_events_user_project_created_idx
  ON public.workspace_generation_events (user_id, project_id, created_at desc);
CREATE INDEX IF NOT EXISTS user_assets_user_project_created_idx
  ON public.user_assets (user_id, project_id, created_at desc);

-- One default project per existing user with spaces/canvases/jobs/assets.
WITH owners AS (
  SELECT DISTINCT user_id FROM public.workspaces WHERE user_id IS NOT NULL
  UNION
  SELECT DISTINCT user_id FROM public.workspace_canvases WHERE user_id IS NOT NULL
  UNION
  SELECT DISTINCT user_id FROM public.workspace_generation_jobs WHERE user_id IS NOT NULL
  UNION
  SELECT DISTINCT user_id FROM public.user_assets WHERE user_id IS NOT NULL
),
missing AS (
  SELECT o.user_id
  FROM owners o
  WHERE NOT EXISTS (
    SELECT 1 FROM public.workspace_projects p WHERE p.user_id = o.user_id
  )
)
INSERT INTO public.workspace_projects (id, user_id, name)
SELECT gen_random_uuid()::text, user_id, 'Default project'
FROM missing;

UPDATE public.workspaces w
SET project_id = (
  SELECT id
  FROM public.workspace_projects p
  WHERE p.user_id = w.user_id
  ORDER BY created_at ASC
  LIMIT 1
)
WHERE w.project_id IS NULL;

UPDATE public.workspace_canvases c
SET project_id = w.project_id
FROM public.workspaces w
WHERE c.workspace_id = w.id
  AND c.project_id IS NULL;

UPDATE public.workspace_generation_jobs j
SET project_id = w.project_id
FROM public.workspaces w
WHERE j.workspace_id = w.id
  AND j.project_id IS NULL;

UPDATE public.workspace_generation_events e
SET project_id = w.project_id
FROM public.workspaces w
WHERE e.workspace_id = w.id
  AND e.project_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.workspace_projects;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON TABLE public.workspace_projects IS
  'Account-level projects. Projects own spaces/workspaces, canvases, generation jobs/events, and project-level assets.';
COMMENT ON COLUMN public.workspaces.project_id IS
  'Project that owns this space/workspace.';
COMMENT ON COLUMN public.user_assets.project_id IS
  'Optional project-level asset pool scope. NULL keeps legacy account-wide assets.';

COMMIT;
