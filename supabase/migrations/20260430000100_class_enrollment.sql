-- public.class_enrollment_codes — QR-friendly join codes.
-- public.class_enrollment_requests — pending student joins awaiting approval.
--
-- Enrollment paths supported:
--   1. Auto-enroll via SSO domain match (org auto-assigns at signup;
--      class assignment is manual after — no code needed).
--   2. Code-based: teacher generates a code, prints/projects the QR;
--      students scan → app calls mf-um-class-enroll edge fn → if the code
--      is valid + auto_approve, INSERT into class_members directly;
--      otherwise INSERT a pending request row for teacher to approve.
--
-- Codes vs requests:
--   - codes are reusable (max_uses) and time-bound (expires_at)
--   - requests are 1:1 with a pending join attempt
--
-- Anti-abuse: code uses_count is incremented atomically inside the edge fn.

BEGIN;

-- ─── 1. Enrollment codes ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.class_enrollment_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,

  -- The actual code (8-12 chars, URL-safe). Generator in helpers migration.
  code TEXT UNIQUE NOT NULL,

  -- 'auto_approve' = student joins immediately on valid scan.
  -- 'request'      = scan creates a pending request row.
  flow TEXT NOT NULL DEFAULT 'auto_approve'
    CHECK (flow IN ('auto_approve', 'request')),

  expires_at TIMESTAMPTZ,           -- NULL = never expires
  max_uses INT,                     -- NULL = unlimited
  uses_count INT NOT NULL DEFAULT 0 CHECK (uses_count >= 0),

  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ            -- NULL = active
);

CREATE INDEX IF NOT EXISTS idx_class_enrollment_codes_class
  ON public.class_enrollment_codes(class_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_class_enrollment_codes_active
  ON public.class_enrollment_codes(code) WHERE revoked_at IS NULL;

ALTER TABLE public.class_enrollment_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS class_enrollment_codes_super_admin_all ON public.class_enrollment_codes;
CREATE POLICY class_enrollment_codes_super_admin_all ON public.class_enrollment_codes
  FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

-- Teachers (and org admins) of the class manage codes for their class
DROP POLICY IF EXISTS class_enrollment_codes_teacher_manage ON public.class_enrollment_codes;
CREATE POLICY class_enrollment_codes_teacher_manage ON public.class_enrollment_codes
  FOR ALL
  USING (
    class_id IN (
      SELECT cm.class_id FROM public.class_members cm
       WHERE cm.user_id = auth.uid() AND cm.role = 'teacher' AND cm.status = 'active'
      UNION
      SELECT c.id FROM public.classes c
       WHERE public.is_org_admin(auth.uid(), c.organization_id)
    )
  )
  WITH CHECK (
    class_id IN (
      SELECT cm.class_id FROM public.class_members cm
       WHERE cm.user_id = auth.uid() AND cm.role = 'teacher' AND cm.status = 'active'
      UNION
      SELECT c.id FROM public.classes c
       WHERE public.is_org_admin(auth.uid(), c.organization_id)
    )
  );

-- ⚠️ Anon SELECT is INTENTIONALLY ABSENT. Code redemption goes through
-- mf-um-class-enroll edge fn (service-role) so we don't expose the codes
-- table to enumeration.

-- ─── 2. Enrollment requests ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.class_enrollment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),

  -- Which code (if any) the student used. NULL for org-admin-initiated.
  via_code UUID REFERENCES public.class_enrollment_codes(id) ON DELETE SET NULL,
  message TEXT,                      -- optional student note

  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A user can have at most one pending request per class
  UNIQUE (class_id, user_id, status) DEFERRABLE
);

CREATE INDEX IF NOT EXISTS idx_class_enrollment_requests_class_pending
  ON public.class_enrollment_requests(class_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_class_enrollment_requests_user
  ON public.class_enrollment_requests(user_id, status);

CREATE OR REPLACE FUNCTION public.class_enrollment_requests_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS class_enrollment_requests_touch_trg ON public.class_enrollment_requests;
CREATE TRIGGER class_enrollment_requests_touch_trg
  BEFORE UPDATE ON public.class_enrollment_requests
  FOR EACH ROW EXECUTE FUNCTION public.class_enrollment_requests_touch();

ALTER TABLE public.class_enrollment_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS class_enrollment_requests_super_admin_all ON public.class_enrollment_requests;
CREATE POLICY class_enrollment_requests_super_admin_all ON public.class_enrollment_requests
  FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

-- Teachers + org admins see/manage requests for their class
DROP POLICY IF EXISTS class_enrollment_requests_teacher_manage ON public.class_enrollment_requests;
CREATE POLICY class_enrollment_requests_teacher_manage ON public.class_enrollment_requests
  FOR ALL
  USING (
    class_id IN (
      SELECT cm.class_id FROM public.class_members cm
       WHERE cm.user_id = auth.uid() AND cm.role = 'teacher' AND cm.status = 'active'
      UNION
      SELECT c.id FROM public.classes c
       WHERE public.is_org_admin(auth.uid(), c.organization_id)
    )
  )
  WITH CHECK (
    class_id IN (
      SELECT cm.class_id FROM public.class_members cm
       WHERE cm.user_id = auth.uid() AND cm.role = 'teacher' AND cm.status = 'active'
      UNION
      SELECT c.id FROM public.classes c
       WHERE public.is_org_admin(auth.uid(), c.organization_id)
    )
  );

-- Students see their own requests (read + cancel)
DROP POLICY IF EXISTS class_enrollment_requests_self_read ON public.class_enrollment_requests;
CREATE POLICY class_enrollment_requests_self_read ON public.class_enrollment_requests
  FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS class_enrollment_requests_self_cancel ON public.class_enrollment_requests;
CREATE POLICY class_enrollment_requests_self_cancel ON public.class_enrollment_requests
  FOR UPDATE
  USING (user_id = auth.uid() AND status = 'pending')
  WITH CHECK (user_id = auth.uid() AND status IN ('pending', 'cancelled'));

COMMIT;
