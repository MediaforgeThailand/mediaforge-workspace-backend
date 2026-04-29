-- public.workspace_activity — append-only event stream for analytics.
--
-- Powers the org-admin dashboard's "who used what" view + future per-user
-- usage reports. Distinct from credit_transactions:
--   - credit_transactions = MONEY movement (signed amount, must balance)
--   - workspace_activity  = PRODUCT usage (didn't necessarily cost credits)
--
-- A node_run that costs credits writes BOTH: one credit_transactions row
-- (for the wallet) and one workspace_activity row (for analytics).
-- Free-tier nodes write only the activity row.
--
-- INSERT only via service-role from edge functions (no client INSERT
-- policy). RLS is read-only for tenants.

BEGIN;

CREATE TABLE IF NOT EXISTS public.workspace_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  class_id UUID REFERENCES public.classes(id) ON DELETE SET NULL,

  activity_type TEXT NOT NULL CHECK (activity_type IN (
    'login',
    'model_use',          -- workspace node ran an AI model
    'enrollment',         -- joined org or class
    'credits_granted',    -- got credits (from teacher / cycle / topup)
    'credits_revoked',
    'workspace_created',
    'workspace_deleted'
  )),

  -- Loose model identifier (no FK — model catalog lives in nodeApiSchema.ts)
  model_id TEXT,

  -- Credits debited by this activity (0 for non-spending events)
  credits_used INT NOT NULL DEFAULT 0,

  -- Free-form context. Examples:
  --   { duration_ms, output_size, success }    for model_use
  --   { code_id, via: 'qr' }                   for enrollment
  --   { actor_id, reason }                     for credits_granted
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_user_time
  ON public.workspace_activity(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_org_time
  ON public.workspace_activity(organization_id, created_at DESC)
  WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_class_time
  ON public.workspace_activity(class_id, created_at DESC)
  WHERE class_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_model
  ON public.workspace_activity(organization_id, model_id, created_at DESC)
  WHERE activity_type = 'model_use' AND organization_id IS NOT NULL;

-- ── RLS ──────────────────────────────────────────────────────────────
ALTER TABLE public.workspace_activity ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_activity_super_admin_all ON public.workspace_activity;
CREATE POLICY workspace_activity_super_admin_all ON public.workspace_activity
  FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

-- Users read their own activity
DROP POLICY IF EXISTS workspace_activity_user_read_own ON public.workspace_activity;
CREATE POLICY workspace_activity_user_read_own ON public.workspace_activity
  FOR SELECT USING (user_id = auth.uid());

-- Class teachers read activity for their classes
DROP POLICY IF EXISTS workspace_activity_teacher_read ON public.workspace_activity;
CREATE POLICY workspace_activity_teacher_read ON public.workspace_activity
  FOR SELECT
  USING (
    class_id IN (
      SELECT cm.class_id FROM public.class_members cm
       WHERE cm.user_id = auth.uid() AND cm.role = 'teacher' AND cm.status = 'active'
    )
  );

-- Org admins read activity across their org
DROP POLICY IF EXISTS workspace_activity_org_admin_read ON public.workspace_activity;
CREATE POLICY workspace_activity_org_admin_read ON public.workspace_activity
  FOR SELECT
  USING (
    organization_id IN (
      SELECT om.organization_id FROM public.organization_memberships om
       WHERE om.user_id = auth.uid() AND om.role = 'org_admin' AND om.status = 'active'
    )
  );

COMMENT ON TABLE public.workspace_activity IS
  'Append-only event stream. Powers org-admin analytics + per-user usage reports.';

COMMIT;
