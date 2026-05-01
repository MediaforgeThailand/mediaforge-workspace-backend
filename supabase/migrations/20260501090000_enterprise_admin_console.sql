-- Enterprise Admin Console foundations.
--
-- Direction:
--   - Enterprise only for now; agency is not a sales motion yet.
--   - Domain-matched users can sign in normally, but they are not active
--     org members until an org admin approves them.
--   - Org admins manage their own members, teams, and team credit pools from
--     the customer Admin Console. MediaForge ERP is support/debug only.

BEGIN;

ALTER TABLE public.organization_memberships
  DROP CONSTRAINT IF EXISTS organization_memberships_status_check;

ALTER TABLE public.organization_memberships
  ADD CONSTRAINT organization_memberships_status_check
  CHECK (status IN ('active', 'pending', 'invited', 'rejected', 'suspended'));

ALTER TABLE public.organization_memberships
  ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'domain_login', 'invite', 'admin_console')),
  ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES public.classes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_org_memberships_org_status
  ON public.organization_memberships(organization_id, status);

CREATE TABLE IF NOT EXISTS public.organization_member_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('org_admin', 'member')),
  team_id UUID REFERENCES public.classes(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by UUID REFERENCES auth.users(id),
  accepted_by UUID REFERENCES auth.users(id),
  accepted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, email)
);

CREATE INDEX IF NOT EXISTS idx_org_invites_org_status
  ON public.organization_member_invites(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_org_invites_email
  ON public.organization_member_invites(lower(email));

ALTER TABLE public.payment_transactions
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_scope TEXT NOT NULL DEFAULT 'user'
    CHECK (payment_scope IN ('user', 'organization'));

CREATE INDEX IF NOT EXISTS idx_payment_transactions_org
  ON public.payment_transactions(organization_id, created_at DESC);

DROP POLICY IF EXISTS "Org admins can view organization payments" ON public.payment_transactions;
CREATE POLICY "Org admins can view organization payments" ON public.payment_transactions
  FOR SELECT
  USING (
    organization_id IS NOT NULL
    AND public.is_org_admin(auth.uid(), organization_id)
  );

CREATE OR REPLACE FUNCTION public.organization_member_invites_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS organization_member_invites_touch_trg ON public.organization_member_invites;
CREATE TRIGGER organization_member_invites_touch_trg
  BEFORE UPDATE ON public.organization_member_invites
  FOR EACH ROW EXECUTE FUNCTION public.organization_member_invites_touch();

ALTER TABLE public.organization_member_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_invites_super_admin_all ON public.organization_member_invites;
CREATE POLICY org_invites_super_admin_all ON public.organization_member_invites
  FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS org_invites_org_admin_manage ON public.organization_member_invites;
CREATE POLICY org_invites_org_admin_manage ON public.organization_member_invites
  FOR ALL
  USING (public.is_org_admin(auth.uid(), organization_id))
  WITH CHECK (public.is_org_admin(auth.uid(), organization_id));

DROP POLICY IF EXISTS org_invites_invitee_read_own ON public.organization_member_invites;
CREATE POLICY org_invites_invitee_read_own ON public.organization_member_invites
  FOR SELECT
  USING (lower(email) = lower((auth.jwt() ->> 'email')));

-- Pending users must not spend from the org pool. The active membership is
-- now the source of truth; profiles.organization_id is only denormalized for
-- approved members and routing.
CREATE OR REPLACE FUNCTION public.workspace_org_credit_scope(p_user_id UUID)
RETURNS TABLE (
  organization_id UUID,
  organization_name TEXT,
  organization_type TEXT,
  primary_domain TEXT,
  credit_balance INT,
  credit_allocated INT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH candidate AS (
    SELECT om.organization_id
    FROM public.organization_memberships om
    JOIN public.organizations o ON o.id = om.organization_id
    WHERE om.user_id = p_user_id
      AND om.status = 'active'
      AND o.status = 'active'
      AND o.deleted_at IS NULL
    ORDER BY om.role = 'org_admin' DESC, om.joined_at ASC
    LIMIT 1
  )
  SELECT
    o.id,
    COALESCE(o.display_name, o.name) AS organization_name,
    o.type AS organization_type,
    (
      SELECT od.domain
      FROM public.organization_domains od
      WHERE od.organization_id = o.id
        AND od.verified_at IS NOT NULL
      ORDER BY od.is_primary DESC, od.created_at ASC
      LIMIT 1
    ) AS primary_domain,
    GREATEST(o.credit_pool - o.credit_pool_allocated, 0) AS credit_balance,
    o.credit_pool_allocated AS credit_allocated
  FROM candidate c
  JOIN public.organizations o ON o.id = c.organization_id
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.workspace_org_credit_scope(UUID)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.post_auth_org_assign()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org UUID;
  v_invite RECORD;
BEGIN
  IF NEW.email IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT *
    INTO v_invite
    FROM public.organization_member_invites
   WHERE lower(email) = lower(NEW.email)
     AND status = 'pending'
     AND (expires_at IS NULL OR expires_at > NOW())
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_invite.id IS NOT NULL THEN
    INSERT INTO public.organization_memberships
      (organization_id, user_id, role, status, invited_by, joined_at, approved_at, approved_by, source, team_id)
    VALUES
      (v_invite.organization_id, NEW.id, v_invite.role, 'active', v_invite.invited_by, NOW(), NOW(), v_invite.invited_by, 'invite', v_invite.team_id)
    ON CONFLICT (organization_id, user_id) DO UPDATE
      SET role = EXCLUDED.role,
          status = 'active',
          invited_by = EXCLUDED.invited_by,
          approved_at = NOW(),
          approved_by = EXCLUDED.approved_by,
          source = 'invite',
          team_id = COALESCE(EXCLUDED.team_id, public.organization_memberships.team_id),
          updated_at = NOW();

    UPDATE public.organization_member_invites
       SET status = 'accepted',
           accepted_by = NEW.id,
           accepted_at = NOW(),
           updated_at = NOW()
     WHERE id = v_invite.id;

    UPDATE public.profiles
       SET organization_id = v_invite.organization_id,
           account_type = 'org_user',
           updated_at = NOW()
     WHERE user_id = NEW.id;

    INSERT INTO public.workspace_activity
      (user_id, organization_id, activity_type, metadata)
    VALUES
      (NEW.id, v_invite.organization_id, 'enrollment', jsonb_build_object('source', 'invite'));

    RETURN NEW;
  END IF;

  v_org := public.org_from_email(NEW.email);
  IF v_org IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.organization_memberships
    (organization_id, user_id, role, status, requested_at, source)
  VALUES
    (v_org, NEW.id, 'member', 'pending', NOW(), 'domain_login')
  ON CONFLICT (organization_id, user_id) DO UPDATE
    SET requested_at = COALESCE(public.organization_memberships.requested_at, NOW()),
        source = CASE
          WHEN public.organization_memberships.status = 'active' THEN public.organization_memberships.source
          ELSE 'domain_login'
        END,
        updated_at = NOW();

  INSERT INTO public.workspace_activity
    (user_id, organization_id, activity_type, metadata)
  VALUES
    (NEW.id, v_org, 'enrollment', jsonb_build_object('source', 'domain_login_pending'));

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.post_auth_org_assign() IS
  'Domain sign-in creates a pending org join request. Explicit invite creates active membership.';

COMMIT;
