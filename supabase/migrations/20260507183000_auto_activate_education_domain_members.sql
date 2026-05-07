-- School/university domains should not create a manual approval queue.
-- A verified education-domain email is enough to become an active student
-- account. Enterprise/team domains still keep the explicit pending workflow.

BEGIN;

CREATE OR REPLACE FUNCTION public.post_auth_org_assign()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org UUID;
  v_org_type TEXT;
  v_is_education BOOLEAN;
BEGIN
  IF NEW.email IS NULL THEN
    RETURN NEW;
  END IF;

  v_org := public.org_from_email(NEW.email);
  IF v_org IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT type
    INTO v_org_type
    FROM public.organizations
    WHERE id = v_org
      AND status = 'active'
      AND deleted_at IS NULL;

  IF v_org_type IS NULL THEN
    RETURN NEW;
  END IF;

  v_is_education := v_org_type IN ('school', 'university');

  IF v_is_education THEN
    UPDATE public.profiles
       SET organization_id = v_org,
           account_type = 'org_user',
           updated_at = NOW()
     WHERE user_id = NEW.id
       AND (organization_id IS NULL OR organization_id = v_org);

    INSERT INTO public.organization_memberships
      (organization_id, user_id, role, status, requested_at, approved_at, source)
    VALUES
      (v_org, NEW.id, 'member', 'active', NOW(), NOW(), 'domain_login')
    ON CONFLICT (organization_id, user_id) DO UPDATE
      SET status = 'active',
          requested_at = COALESCE(public.organization_memberships.requested_at, NOW()),
          approved_at = COALESCE(public.organization_memberships.approved_at, NOW()),
          source = CASE
            WHEN public.organization_memberships.source IN ('invite', 'admin_console', 'manual') THEN public.organization_memberships.source
            ELSE 'domain_login'
          END,
          updated_at = NOW();

    INSERT INTO public.workspace_activity
      (user_id, organization_id, activity_type, metadata)
    VALUES
      (NEW.id, v_org, 'enrollment', jsonb_build_object('source', 'education_domain_login_active'));

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
  'Auto-assign org from email domain. School/university domains become active students; enterprise domains remain pending.';

WITH education_domain_users AS (
  SELECT DISTINCT
         au.id AS user_id,
         od.organization_id
    FROM auth.users au
    JOIN public.organization_domains od
      ON lower(od.domain) = lower(split_part(COALESCE(au.email, ''), '@', 2))
     AND od.verified_at IS NOT NULL
    JOIN public.organizations o
      ON o.id = od.organization_id
   WHERE au.email LIKE '%@%'
     AND o.type IN ('school', 'university')
     AND o.status = 'active'
     AND o.deleted_at IS NULL
)
INSERT INTO public.organization_memberships
  (organization_id, user_id, role, status, requested_at, approved_at, source)
SELECT organization_id, user_id, 'member', 'active', NOW(), NOW(), 'domain_login'
  FROM education_domain_users
ON CONFLICT (organization_id, user_id) DO UPDATE
  SET status = 'active',
      requested_at = COALESCE(public.organization_memberships.requested_at, NOW()),
      approved_at = COALESCE(public.organization_memberships.approved_at, NOW()),
      source = CASE
        WHEN public.organization_memberships.source IN ('invite', 'admin_console', 'manual') THEN public.organization_memberships.source
        ELSE 'domain_login'
      END,
      updated_at = NOW();

WITH education_domain_users AS (
  SELECT DISTINCT
         au.id AS user_id,
         od.organization_id
    FROM auth.users au
    JOIN public.organization_domains od
      ON lower(od.domain) = lower(split_part(COALESCE(au.email, ''), '@', 2))
     AND od.verified_at IS NOT NULL
    JOIN public.organizations o
      ON o.id = od.organization_id
   WHERE au.email LIKE '%@%'
     AND o.type IN ('school', 'university')
     AND o.status = 'active'
     AND o.deleted_at IS NULL
)
UPDATE public.profiles p
   SET organization_id = edu.organization_id,
       account_type = 'org_user',
       updated_at = NOW()
  FROM education_domain_users edu
 WHERE p.user_id = edu.user_id
   AND (p.organization_id IS NULL OR p.organization_id = edu.organization_id);

COMMIT;
