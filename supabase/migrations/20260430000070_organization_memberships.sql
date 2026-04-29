-- public.organization_memberships — user ↔ organization (M:N, with role).
--
-- Distinct from class_members (next migration). An org_user is a member
-- of exactly ONE org (UNIQUE per org_id, user_id) but typically inside
-- one or more classes within that org.
--
-- Roles:
--   org_admin
--     Manages org-level settings: domains, SSO, members, classes,
--     credit pool allocation. NOT a Stripe billing role — that's
--     super-admin only for now.
--
--   member
--     Default for everyone joining via SSO domain match. May or may not
--     be a teacher of any class — class-teacher status is tracked in
--     class_members.role separately.

BEGIN;

CREATE TABLE IF NOT EXISTS public.organization_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('org_admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended')),

  invited_by UUID REFERENCES auth.users(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  suspended_at TIMESTAMPTZ,
  suspended_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_memberships_user
  ON public.organization_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_org_memberships_org_role
  ON public.organization_memberships(organization_id, role);

-- ── Touch trigger ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.org_memberships_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS org_memberships_touch_trg ON public.organization_memberships;
CREATE TRIGGER org_memberships_touch_trg
  BEFORE UPDATE ON public.organization_memberships
  FOR EACH ROW EXECUTE FUNCTION public.org_memberships_touch();

-- ── RLS ──────────────────────────────────────────────────────────────
ALTER TABLE public.organization_memberships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_memberships_super_admin_all ON public.organization_memberships;
CREATE POLICY org_memberships_super_admin_all ON public.organization_memberships
  FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS org_memberships_user_read_own ON public.organization_memberships;
CREATE POLICY org_memberships_user_read_own ON public.organization_memberships
  FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS org_memberships_org_admin_manage ON public.organization_memberships;
CREATE POLICY org_memberships_org_admin_manage ON public.organization_memberships
  FOR ALL
  USING (public.is_org_admin(auth.uid(), organization_id))
  WITH CHECK (public.is_org_admin(auth.uid(), organization_id));

COMMENT ON TABLE public.organization_memberships IS
  'User ↔ org direct membership. Source of truth for "what org does this user belong to".';

COMMIT;
