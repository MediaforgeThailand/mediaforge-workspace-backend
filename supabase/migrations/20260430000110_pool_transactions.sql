-- public.pool_transactions — org/class credit-pool ledger.
--
-- ⚠️  RENAMED from `credit_transactions` to avoid collision with the
-- existing per-user wallet ledger (created in 20260213, used by
-- consume_credits / refund_credits). That table stays as the per-user
-- transaction log; pool_transactions tracks ONLY money movement at
-- the org/class pool level + visibility into per-user grants from a
-- pool perspective.
--
-- Polymorphic owner: exactly ONE of (user_id, class_id, organization_id)
-- is non-NULL on each row. Enforced by CHECK constraint.
--
-- Reasons taxonomy:
--
--   user_id rows  (visibility into "this user got/spent class credits")
--     member_grant         — class teacher granted credits via RPC
--     cycle_reset          — monthly_reset cron set balance to credit_amount
--     cycle_drip           — weekly_drip cron added credit_amount to balance
--     class_revoke         — admin removed credits back to class pool
--
--   class_id rows  (per-class pool movement)
--     class_pool_allocation  — org admin moved credits org→class (positive)
--     class_pool_consumed    — student spent (or teacher granted out) (negative)
--     class_pool_revoked     — admin removed credits from class pool
--
--   organization_id rows  (per-org pool movement)
--     org_pool_topup            — sales added credits to org pool
--     org_pool_allocation       — moved out to a class (negative on org)
--     org_pool_revoked          — manual cleanup
--
-- Why polymorphic and not three sister tables: reporting joins are
-- simpler ("show all credit movement related to org X") and one INSERT
-- path keeps the audit story uniform.

BEGIN;

CREATE TABLE IF NOT EXISTS public.pool_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Polymorphic owner (exactly one set; CHECK below)
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  class_id UUID REFERENCES public.classes(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Who initiated this transaction (NULL for system / cron jobs)
  triggered_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Which workspace artifact (if any) the action came from
  workspace_id TEXT,
  canvas_id TEXT,

  -- Negative = deduction, positive = grant/refund
  amount INT NOT NULL,

  reason TEXT NOT NULL CHECK (reason IN (
    -- user_id rows
    'member_grant',
    'cycle_reset',
    'cycle_drip',
    'class_revoke',
    -- class_id rows
    'class_pool_allocation',
    'class_pool_consumed',
    'class_pool_revoked',
    -- organization_id rows
    'org_pool_topup',
    'org_pool_allocation',
    'org_pool_revoked'
  )),
  description TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Exactly ONE owner column non-NULL
  CONSTRAINT pool_transactions_one_owner CHECK (
    (user_id IS NOT NULL)::int +
    (class_id IS NOT NULL)::int +
    (organization_id IS NOT NULL)::int = 1
  )
);

CREATE INDEX IF NOT EXISTS idx_pool_tx_user_time
  ON public.pool_transactions(user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pool_tx_class_time
  ON public.pool_transactions(class_id, created_at DESC) WHERE class_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pool_tx_org_time
  ON public.pool_transactions(organization_id, created_at DESC) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pool_tx_workspace
  ON public.pool_transactions(workspace_id, created_at DESC) WHERE workspace_id IS NOT NULL;

-- ── RLS ──────────────────────────────────────────────────────────────
ALTER TABLE public.pool_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pool_tx_super_admin_all ON public.pool_transactions;
CREATE POLICY pool_tx_super_admin_all ON public.pool_transactions
  FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

-- Users read their own pool-side transactions (grants from class, etc.)
DROP POLICY IF EXISTS pool_tx_user_read_own ON public.pool_transactions;
CREATE POLICY pool_tx_user_read_own ON public.pool_transactions
  FOR SELECT
  USING (user_id = auth.uid());

-- Class teachers read their class's transactions
DROP POLICY IF EXISTS pool_tx_teacher_read ON public.pool_transactions;
CREATE POLICY pool_tx_teacher_read ON public.pool_transactions
  FOR SELECT
  USING (
    class_id IN (
      SELECT cm.class_id FROM public.class_members cm
       WHERE cm.user_id = auth.uid() AND cm.role = 'teacher' AND cm.status = 'active'
    )
  );

-- Org admins read their org's transactions (org-pool + classes inside)
DROP POLICY IF EXISTS pool_tx_org_admin_read ON public.pool_transactions;
CREATE POLICY pool_tx_org_admin_read ON public.pool_transactions
  FOR SELECT
  USING (
    organization_id IN (
      SELECT om.organization_id FROM public.organization_memberships om
       WHERE om.user_id = auth.uid() AND om.role = 'org_admin' AND om.status = 'active'
    )
    OR class_id IN (
      SELECT c.id FROM public.classes c
       JOIN public.organization_memberships om
         ON om.organization_id = c.organization_id
       WHERE om.user_id = auth.uid() AND om.role = 'org_admin' AND om.status = 'active'
    )
  );

-- INSERT only via service-role (no INSERT policy granted to authenticated).
-- Movement happens through the RPCs in 14_credit_rpcs.sql.

COMMENT ON TABLE public.pool_transactions IS
  'Org/class pool ledger. Distinct from per-user credit_transactions (existing). Polymorphic: user OR class OR org.';

COMMIT;
