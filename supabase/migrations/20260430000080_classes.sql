-- public.classes — sub-grouping under an organization.
--
-- An org has many classes; each class has its own roster of members
-- (students + co-teachers) and its own credit_pool allocated from the
-- org's credit_pool.
--
-- Class lifecycle:
--   scheduled  → start_date in future
--   active     → between start_date and end_date (or open-ended)
--   ended      → past end_date
--   archived   → admin manually hides
--
-- Credit policy (drives the daily cron):
--   manual         — teacher grants credits ad-hoc; no auto-refill
--   monthly_reset  — on reset_day_of_month, set every member's balance to credit_amount
--   weekly_drip    — on reset_day_of_week, ADD credit_amount to every member's balance

BEGIN;

CREATE TABLE IF NOT EXISTS public.classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  -- Short code displayed alongside the QR (e.g. "DM-2026-X8K9").
  -- Auto-generated at insert if not supplied — see helpers migration.
  code TEXT NOT NULL,
  description TEXT,

  -- Term metadata (Thai academic structure)
  term TEXT,        -- '1' | '2' | 'summer' | free-form
  year INT,         -- พ.ศ. or ค.ศ., caller decides

  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'scheduled', 'ended', 'archived')),

  start_date DATE,
  end_date DATE,
  max_students INT CHECK (max_students IS NULL OR max_students > 0),

  primary_instructor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Credit policy (overrides org default)
  credit_policy TEXT NOT NULL DEFAULT 'manual'
    CHECK (credit_policy IN ('manual', 'monthly_reset', 'weekly_drip')),
  credit_amount INT NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),

  -- Cron anchor day. 1-28 to dodge Feb edge cases on monthly_reset.
  reset_day_of_month INT NOT NULL DEFAULT 1
    CHECK (reset_day_of_month BETWEEN 1 AND 28),
  reset_day_of_week INT NOT NULL DEFAULT 1
    CHECK (reset_day_of_week BETWEEN 0 AND 6),    -- 0=Sun 1=Mon

  -- Class budget allocated from org pool + lifetime consumption tracker.
  -- Replenishment rule: org_admin INSERTs a credit_transactions row of
  -- reason='class_pool_allocation', which atomically debits org pool and
  -- credits this column.
  credit_pool INT NOT NULL DEFAULT 0 CHECK (credit_pool >= 0),
  credit_pool_consumed INT NOT NULL DEFAULT 0 CHECK (credit_pool_consumed >= 0),

  settings JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  -- Class code uniqueness scoped to org. Different orgs can both have
  -- "DM-2026" without collision; same org can't.
  UNIQUE (organization_id, code)
);

CREATE INDEX IF NOT EXISTS idx_classes_org
  ON public.classes(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_classes_status
  ON public.classes(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_classes_instructor
  ON public.classes(primary_instructor_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_classes_dates
  ON public.classes(start_date, end_date) WHERE status IN ('active', 'scheduled');

-- Cron driver indexes — daily job filters by policy + reset day.
CREATE INDEX IF NOT EXISTS idx_classes_monthly_reset
  ON public.classes(reset_day_of_month, status)
  WHERE credit_policy = 'monthly_reset' AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_classes_weekly_drip
  ON public.classes(reset_day_of_week, status)
  WHERE credit_policy = 'weekly_drip' AND status = 'active';

-- ── Touch trigger ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.classes_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS classes_touch_trg ON public.classes;
CREATE TRIGGER classes_touch_trg
  BEFORE UPDATE ON public.classes
  FOR EACH ROW EXECUTE FUNCTION public.classes_touch();

-- ── RLS ──────────────────────────────────────────────────────────────
ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS classes_super_admin_all ON public.classes;
CREATE POLICY classes_super_admin_all ON public.classes
  FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS classes_org_admin_manage ON public.classes;
CREATE POLICY classes_org_admin_manage ON public.classes
  FOR ALL
  USING (public.is_org_admin(auth.uid(), organization_id))
  WITH CHECK (public.is_org_admin(auth.uid(), organization_id));

-- Primary instructor reads their own classes. Co-teacher visibility
-- policy is added in the next migration after class_members exists.
DROP POLICY IF EXISTS classes_instructor_read ON public.classes;
CREATE POLICY classes_instructor_read ON public.classes
  FOR SELECT
  USING (primary_instructor_id = auth.uid());

COMMENT ON TABLE public.classes IS
  'A class within an org. Owns credit_pool, policy, students. Credits flow: org → class → student.';
COMMENT ON COLUMN public.classes.credit_policy IS
  'manual = teacher grants ad-hoc. monthly_reset = balance set to credit_amount each cycle. weekly_drip = balance += credit_amount each cycle.';

COMMIT;
