BEGIN;

-- Education-domain students must be locked before they redeem a class QR/link.
-- The earlier implementation only checked active memberships, so a user with a
-- verified university/school email could still look like a consumer until class
-- enrollment promoted their profile.
CREATE OR REPLACE FUNCTION public.is_education_locked_student(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (
      EXISTS (
        SELECT 1
        FROM public.organization_memberships om
        JOIN public.organizations o ON o.id = om.organization_id
        WHERE om.user_id = p_user_id
          AND (
            om.status = 'active'
            OR (
              om.status = 'pending'
              AND om.role = 'member'
              AND COALESCE(om.source, '') = 'domain_login'
            )
          )
          AND o.type IN ('school', 'university')
          AND o.status = 'active'
          AND o.deleted_at IS NULL
      )
      OR EXISTS (
        SELECT 1
        FROM auth.users au
        JOIN public.organization_domains od
          ON lower(od.domain) = lower(split_part(COALESCE(au.email, ''), '@', 2))
         AND od.verified_at IS NOT NULL
        JOIN public.organizations o ON o.id = od.organization_id
        WHERE au.id = p_user_id
          AND au.email LIKE '%@%'
          AND o.type IN ('school', 'university')
          AND o.status = 'active'
          AND o.deleted_at IS NULL
      )
    )
    AND NOT public.is_education_teacher_or_admin(p_user_id);
$$;

GRANT EXECUTE ON FUNCTION public.is_education_locked_student(UUID)
  TO authenticated, service_role;

-- Allow status events written when a teacher passes/ends/reopens a student
-- class space. Existing analytics values are preserved.
ALTER TABLE public.workspace_activity
  DROP CONSTRAINT IF EXISTS workspace_activity_activity_type_check;

ALTER TABLE public.workspace_activity
  ADD CONSTRAINT workspace_activity_activity_type_check
  CHECK (activity_type IN (
    'login',
    'model_use',
    'enrollment',
    'credits_granted',
    'credits_revoked',
    'workspace_created',
    'workspace_deleted',
    'space_completed',
    'space_reopened'
  ));

CREATE OR REPLACE FUNCTION public.admin_set_education_space_status(
  p_workspace_id TEXT,
  p_status TEXT,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_space RECORD;
  v_status TEXT := COALESCE(NULLIF(TRIM(p_status), ''), 'passed');
  v_completed_at TIMESTAMPTZ;
BEGIN
  IF v_status NOT IN ('active', 'submitted', 'passed', 'ended') THEN
    RAISE EXCEPTION 'admin_set_education_space_status: invalid status %', v_status;
  END IF;

  v_completed_at := CASE WHEN v_status IN ('passed', 'ended') THEN NOW() ELSE NULL END;

  UPDATE public.education_student_spaces
     SET status = v_status,
         completed_at = v_completed_at,
         completed_by = CASE WHEN v_status IN ('passed', 'ended') THEN p_actor_id ELSE NULL END
   WHERE workspace_id = p_workspace_id
   RETURNING * INTO v_space;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_set_education_space_status: space not found';
  END IF;

  UPDATE public.workspaces
     SET education_status = v_status,
         education_completed_at = v_completed_at,
         education_completed_by = CASE WHEN v_status IN ('passed', 'ended') THEN p_actor_id ELSE NULL END,
         updated_at = NOW()
   WHERE id = p_workspace_id;

  INSERT INTO public.workspace_activity
    (user_id, organization_id, class_id, activity_type, metadata)
  VALUES
    (
      v_space.user_id,
      v_space.organization_id,
      v_space.class_id,
      CASE WHEN v_status IN ('passed', 'ended') THEN 'space_completed' ELSE 'space_reopened' END,
      jsonb_build_object('actor_id', p_actor_id, 'workspace_id', p_workspace_id, 'status', v_status)
    );

  RETURN to_jsonb(v_space);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_education_space_status(TEXT, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_education_space_status(TEXT, TEXT, UUID)
  TO service_role;

COMMIT;
