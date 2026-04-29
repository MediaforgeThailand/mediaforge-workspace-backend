-- Helper functions for org / class lookups + RLS authorization.
--
-- These are SECURITY DEFINER so RLS policies that call them aren't blocked
-- by row-level checks on the helper's internal SELECTs (the helper itself
-- decides what to return). All set search_path = public to defuse the
-- search-path-injection class of vulnerability.
--
-- Functions defined here:
--   org_from_email(email)        — domain → org_id (NULL if no match)
--   is_org_admin(user, org)      — boolean (super-admin OR org_admin role)
--   is_class_teacher(user, class) — boolean (super-admin / org-admin /
--                                   primary instructor / class teacher role)
--
-- Naming: dropped the `mf_um_v3_` prefix from the v3 staging files. This
-- DB is workspace-only — there's no second namespace to disambiguate from.

BEGIN;

-- ─── 1. org_from_email ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.org_from_email(p_email TEXT)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_domain TEXT;
  v_org UUID;
BEGIN
  IF p_email IS NULL OR p_email = '' THEN RETURN NULL; END IF;

  v_domain := lower(split_part(p_email, '@', 2));
  IF v_domain = '' THEN RETURN NULL; END IF;

  SELECT organization_id INTO v_org
    FROM public.organization_domains
    WHERE domain = v_domain
      AND verified_at IS NOT NULL
    LIMIT 1;

  RETURN v_org;
END;
$$;

GRANT EXECUTE ON FUNCTION public.org_from_email(TEXT)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.org_from_email(TEXT) IS
  'Resolve email domain → organization_id. NULL if no verified domain match.';

-- ─── 2. is_org_admin ─────────────────────────────────────────────────
-- LANGUAGE plpgsql (not sql) so the body's reference to
-- public.organization_memberships resolves LAZILY at call time, not
-- function-creation time. Lets this helper exist BEFORE the table
-- (organization_memberships is created in 005). Calls before 005
-- would fail at runtime; nothing in the migration sequence triggers
-- such a call.
CREATE OR REPLACE FUNCTION public.is_org_admin(p_user_id UUID, p_org_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_yes BOOLEAN;
BEGIN
  SELECT
    EXISTS (
      SELECT 1 FROM public.user_roles
       WHERE user_id = p_user_id AND role = 'admin'::public.app_role
    )
    OR
    EXISTS (
      SELECT 1 FROM public.organization_memberships
       WHERE organization_id = p_org_id
         AND user_id = p_user_id
         AND role = 'org_admin'
         AND status = 'active'
    )
  INTO v_yes;
  RETURN v_yes;
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_org_admin(UUID, UUID)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.is_org_admin(UUID, UUID) IS
  'Returns TRUE if user is super-admin (user_roles) or active org_admin in the given org.';

-- ─── 3. is_class_teacher ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_class_teacher(p_user_id UUID, p_class_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_yes BOOLEAN;
BEGIN
  SELECT
    -- super admin
    EXISTS (
      SELECT 1 FROM public.user_roles
       WHERE user_id = p_user_id AND role = 'admin'::public.app_role
    )
    OR
    -- primary instructor
    EXISTS (
      SELECT 1 FROM public.classes
       WHERE id = p_class_id AND primary_instructor_id = p_user_id
    )
    OR
    -- class_members.role = 'teacher'
    EXISTS (
      SELECT 1 FROM public.class_members
       WHERE class_id = p_class_id
         AND user_id = p_user_id
         AND role = 'teacher'
         AND status = 'active'
    )
    OR
    -- org admin of the class's org
    EXISTS (
      SELECT 1 FROM public.classes c
       WHERE c.id = p_class_id
         AND public.is_org_admin(p_user_id, c.organization_id)
    )
  INTO v_yes;
  RETURN v_yes;
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_class_teacher(UUID, UUID)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.is_class_teacher(UUID, UUID) IS
  'Returns TRUE if user is super-admin / org-admin / primary-instructor / class-teacher of the given class.';

-- ─── 4. generate_class_code helper (used by class auto-code on insert) ─
CREATE OR REPLACE FUNCTION public.generate_class_code()
RETURNS TEXT
LANGUAGE sql
VOLATILE
AS $$
  -- 4-3 format e.g. "DM26-K8X9". Avoids ambiguous characters (0/O, 1/I/L).
  -- Uniqueness scoped to org by the table's UNIQUE(organization_id, code)
  -- constraint. On collision retry at the application layer.
  SELECT
    upper(substring(encode(gen_random_bytes(3), 'hex') for 4)) || '-' ||
    upper(substring(encode(gen_random_bytes(3), 'hex') for 4));
$$;

GRANT EXECUTE ON FUNCTION public.generate_class_code()
  TO authenticated, service_role;

-- ─── 5. generate_enrollment_code (for class_enrollment_codes.code) ───
CREATE OR REPLACE FUNCTION public.generate_enrollment_code()
RETURNS TEXT
LANGUAGE sql
VOLATILE
AS $$
  -- 8-char alphanumeric, intentionally short for QR readability.
  SELECT upper(substring(encode(gen_random_bytes(6), 'base64') for 8));
$$;

GRANT EXECUTE ON FUNCTION public.generate_enrollment_code()
  TO authenticated, service_role;

COMMIT;
