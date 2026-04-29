-- public.class_members — student / co-teacher roster for a class.
--
-- Roles:
--   teacher  — primary instructor or co-teacher. Can:
--              * see the class roster
--              * manage member list (add/remove/suspend)
--              * grant credits to members from the class pool
--              * view per-student analytics
--   student  — default for everyone enrolled. Can:
--              * see only their own row + class metadata
--              * spend their credits_balance on workspace runs
--
-- Per-member credit tracking:
--   credits_balance              spendable now (decremented on node_run)
--   credits_lifetime_received    cumulative (analytics: how much teacher gave)
--   credits_lifetime_used        cumulative (analytics: how much student spent)
--   credit_cap                   optional individual cap (NULL = no cap)
--
-- Note: this `credits_balance` is the IN-CLASS allocation. It mirrors
-- public.user_credits.balance (the SOURCE OF TRUTH used by consume_credits)
-- — see migration 14 for the sync trigger that keeps them aligned. We keep
-- both because:
--   (a) class-scoped queries are easier off this column ("show me top
--       spenders in class X")
--   (b) user_credits doesn't know about classes; a future cycle_reset
--       run might allocate to multiple classes, each reflected here

BEGIN;

CREATE TABLE IF NOT EXISTS public.class_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  role TEXT NOT NULL DEFAULT 'student'
    CHECK (role IN ('teacher', 'student')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'left')),

  -- Credit tracking (mirrors user_credits.balance; see 14_credit_rpcs)
  credit_cap INT CHECK (credit_cap IS NULL OR credit_cap >= 0),
  credits_balance INT NOT NULL DEFAULT 0 CHECK (credits_balance >= 0),
  credits_lifetime_received INT NOT NULL DEFAULT 0 CHECK (credits_lifetime_received >= 0),
  credits_lifetime_used INT NOT NULL DEFAULT 0 CHECK (credits_lifetime_used >= 0),

  invited_by UUID REFERENCES auth.users(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (class_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_class_members_user
  ON public.class_members(user_id);
CREATE INDEX IF NOT EXISTS idx_class_members_class_role
  ON public.class_members(class_id, role);
CREATE INDEX IF NOT EXISTS idx_class_members_active
  ON public.class_members(class_id) WHERE status = 'active';

-- ── Touch trigger ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.class_members_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS class_members_touch_trg ON public.class_members;
CREATE TRIGGER class_members_touch_trg
  BEFORE UPDATE ON public.class_members
  FOR EACH ROW EXECUTE FUNCTION public.class_members_touch();

-- ── RLS ──────────────────────────────────────────────────────────────
ALTER TABLE public.class_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS class_members_super_admin_all ON public.class_members;
CREATE POLICY class_members_super_admin_all ON public.class_members
  FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

-- Org admins manage members in any class within their org
DROP POLICY IF EXISTS class_members_org_admin_manage ON public.class_members;
CREATE POLICY class_members_org_admin_manage ON public.class_members
  FOR ALL
  USING (
    class_id IN (
      SELECT c.id FROM public.classes c
       WHERE public.is_org_admin(auth.uid(), c.organization_id)
    )
  )
  WITH CHECK (
    class_id IN (
      SELECT c.id FROM public.classes c
       WHERE public.is_org_admin(auth.uid(), c.organization_id)
    )
  );

-- Class teachers manage members in their own class
DROP POLICY IF EXISTS class_members_teacher_manage ON public.class_members;
CREATE POLICY class_members_teacher_manage ON public.class_members
  FOR ALL
  USING (
    class_id IN (
      SELECT cm.class_id FROM public.class_members cm
       WHERE cm.user_id = auth.uid() AND cm.role = 'teacher' AND cm.status = 'active'
    )
  )
  WITH CHECK (
    class_id IN (
      SELECT cm.class_id FROM public.class_members cm
       WHERE cm.user_id = auth.uid() AND cm.role = 'teacher' AND cm.status = 'active'
    )
  );

-- Students read their own row only
DROP POLICY IF EXISTS class_members_self_read ON public.class_members;
CREATE POLICY class_members_self_read ON public.class_members
  FOR SELECT
  USING (user_id = auth.uid());

-- ── Co-teacher visibility on classes (couldn't define in 006 because
--    class_members didn't exist yet) ─────────────────────────────────
DROP POLICY IF EXISTS classes_teacher_read ON public.classes;
CREATE POLICY classes_teacher_read ON public.classes
  FOR SELECT
  USING (
    id IN (
      SELECT class_id FROM public.class_members
       WHERE user_id = auth.uid() AND role = 'teacher' AND status = 'active'
    )
  );

-- Students of the class can read the class metadata (name, dates, etc.)
DROP POLICY IF EXISTS classes_student_read ON public.classes;
CREATE POLICY classes_student_read ON public.classes
  FOR SELECT
  USING (
    id IN (
      SELECT class_id FROM public.class_members
       WHERE user_id = auth.uid() AND role = 'student' AND status = 'active'
    )
  );

COMMENT ON TABLE public.class_members IS
  'Roster: students + teachers per class. credits_balance mirrors user_credits.balance for the in-class allocation.';

COMMIT;
