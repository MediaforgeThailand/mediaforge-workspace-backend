-- Extend workspaces + workspace_canvases with class_id.
--
-- Why: a workspace can belong to a class. When a student creates a
-- workspace inside a class context, we tag it with the class_id so:
--   - the dispatcher knows which credit pool fuels its node runs (the
--     class pool via the in-class user balance — see 14_credit_rpcs)
--   - teachers can list workspaces by class for analytics
--   - org-admin search can filter by org → class → workspaces
--
-- Personal workspaces (consumer or org_user-without-class context) keep
-- class_id = NULL. The dispatcher falls through to the user_credits
-- consume path, exactly as today.
--
-- workspace_canvases gets the same column denormalised for query
-- speed — listing canvases by class doesn't need to join through
-- workspaces. The workspace's class_id is the source of truth; canvases
-- inherit on insert (handled by application code, not enforced here).

BEGIN;

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS class_id UUID
    REFERENCES public.classes(id) ON DELETE SET NULL;

ALTER TABLE public.workspace_canvases
  ADD COLUMN IF NOT EXISTS class_id UUID
    REFERENCES public.classes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_workspaces_class
  ON public.workspaces(class_id) WHERE class_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workspace_canvases_class
  ON public.workspace_canvases(class_id) WHERE class_id IS NOT NULL;

COMMENT ON COLUMN public.workspaces.class_id IS
  'Optional class affiliation. NULL = personal workspace; set = workspace tied to a class context.';

COMMIT;
