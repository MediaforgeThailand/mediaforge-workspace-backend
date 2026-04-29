-- Post-auth trigger: auto-assign org from email domain.
--
-- When a new user signs up (or updates their email) we look up the
-- domain in organization_domains. If verified, we:
--   1. Stamp profiles.organization_id + account_type='org_user'
--   2. Insert organization_memberships row with role='member'
--
-- This is a SECOND trigger on auth.users — handle_new_user / on_auth_user_created
-- runs FIRST (it inserts the profiles row this trigger UPDATEs).
--
-- PostgreSQL fires same-event triggers in alphabetical order by NAME. To
-- force this one to run after `on_auth_user_created`, the trigger name is
-- prefixed with `zz_`:
--   on_auth_user_created          → first  (handle_new_user)
--   zz_post_auth_org_assign       → second (this trigger)

BEGIN;

CREATE OR REPLACE FUNCTION public.post_auth_org_assign()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org UUID;
BEGIN
  -- Defensive: skip rows with no email (shouldn't happen via Supabase Auth)
  IF NEW.email IS NULL THEN
    RETURN NEW;
  END IF;

  v_org := public.org_from_email(NEW.email);

  -- No matching verified domain → user stays consumer
  IF v_org IS NULL THEN
    RETURN NEW;
  END IF;

  -- Mark profile. Guard `WHERE organization_id IS NULL` so a manual
  -- re-org reassignment (admin moves user between orgs) is not clobbered
  -- if the trigger fires again on email update.
  UPDATE public.profiles
     SET organization_id = v_org,
         account_type = 'org_user',
         updated_at = NOW()
   WHERE user_id = NEW.id
     AND organization_id IS NULL;

  -- Idempotent membership insert
  INSERT INTO public.organization_memberships
    (organization_id, user_id, role, status)
  VALUES
    (v_org, NEW.id, 'member', 'active')
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  -- Activity log (analytics)
  INSERT INTO public.workspace_activity
    (user_id, organization_id, activity_type, metadata)
  VALUES
    (NEW.id, v_org, 'enrollment', jsonb_build_object('source', 'sso_auto'));

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_post_auth_org_assign ON auth.users;
CREATE TRIGGER zz_post_auth_org_assign
  AFTER INSERT OR UPDATE OF email ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.post_auth_org_assign();

COMMENT ON FUNCTION public.post_auth_org_assign() IS
  'Auto-assign org from email domain. Runs AFTER handle_new_user (zz_ prefix forces order).';

-- Verification query — run manually after applying:
--
--   SELECT tgname FROM pg_trigger
--    WHERE tgrelid = 'auth.users'::regclass AND NOT tgisinternal
--    ORDER BY tgname;
--
-- Expected (in firing order):
--   on_auth_user_created       (handle_new_user)
--   zz_post_auth_org_assign    (this trigger)

COMMIT;
