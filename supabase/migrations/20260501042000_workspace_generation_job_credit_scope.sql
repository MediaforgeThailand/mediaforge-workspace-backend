-- Workspace generation job credit ownership metadata.
--
-- workspace-run-node records where a precharged background job drew credits
-- from so later worker failures can refund the same pool. The edge function
-- started writing these columns with the durable job flow, but the schema
-- migration only added user/team charge totals. Missing columns make the
-- enqueue insert fail with a PostgREST schema-cache error and surface as a
-- 500 from workspace-run-node.

ALTER TABLE public.workspace_generation_jobs
  ADD COLUMN IF NOT EXISTS credit_organization_id uuid
    REFERENCES public.organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS credit_class_id uuid
    REFERENCES public.classes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS credit_scope text NOT NULL DEFAULT 'user';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'workspace_generation_jobs_credit_scope_check'
  ) THEN
    ALTER TABLE public.workspace_generation_jobs
      ADD CONSTRAINT workspace_generation_jobs_credit_scope_check
      CHECK (credit_scope IN ('user', 'team', 'organization'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS workspace_generation_jobs_credit_org_idx
  ON public.workspace_generation_jobs (credit_organization_id, created_at DESC)
  WHERE credit_organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS workspace_generation_jobs_credit_class_idx
  ON public.workspace_generation_jobs (credit_class_id, created_at DESC)
  WHERE credit_class_id IS NOT NULL;

COMMENT ON COLUMN public.workspace_generation_jobs.credit_scope IS
  'Credit owner used for the precharged workspace generation job: user, team, or organization.';
COMMENT ON COLUMN public.workspace_generation_jobs.credit_organization_id IS
  'Organization credit pool charged for this generation job, when applicable.';
COMMENT ON COLUMN public.workspace_generation_jobs.credit_class_id IS
  'Education class context captured when a student/teacher generation is charged.';
