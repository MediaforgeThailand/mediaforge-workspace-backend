-- Make QR enrollment account-first: the student code is optional when
-- redeeming a class link, then can be saved or corrected from the student's
-- own profile later.

BEGIN;

CREATE OR REPLACE FUNCTION public.set_education_student_code(
  p_class_id UUID,
  p_user_id UUID,
  p_student_code TEXT,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_class RECORD;
  v_member RECORD;
  v_student_code TEXT := NULLIF(TRIM(COALESCE(p_student_code, '')), '');
  v_space_name TEXT;
  v_updated_spaces INT := 0;
BEGIN
  IF v_student_code IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'student_code_required');
  END IF;

  SELECT id, organization_id, name
    INTO v_class
    FROM public.classes
    WHERE id = p_class_id
      AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'class_not_found');
  END IF;

  SELECT id, student_code
    INTO v_member
    FROM public.class_members
    WHERE class_id = p_class_id
      AND user_id = p_user_id
      AND role = 'student'
      AND status = 'active'
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'class_membership_not_found');
  END IF;

  UPDATE public.class_members
     SET student_code = v_student_code,
         updated_at = NOW()
   WHERE id = v_member.id;

  v_space_name := v_class.name || ' - ' || v_student_code;

  UPDATE public.education_student_spaces
     SET settings = jsonb_set(
           COALESCE(settings, '{}'::jsonb),
           '{student_code}',
           to_jsonb(v_student_code),
           true
         )
   WHERE class_id = p_class_id
     AND user_id = p_user_id;

  GET DIAGNOSTICS v_updated_spaces = ROW_COUNT;

  UPDATE public.workspaces
     SET name = v_space_name,
         education_settings = jsonb_set(
           COALESCE(education_settings, '{}'::jsonb),
           '{student_code}',
           to_jsonb(v_student_code),
           true
         ),
         updated_at = NOW()
   WHERE class_id = p_class_id
     AND user_id = p_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'class_id', p_class_id,
    'student_code', v_student_code,
    'updated_spaces', v_updated_spaces
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_education_student_code(UUID, UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_education_student_code(UUID, UUID, TEXT, UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.redeem_enrollment_code(
  p_code TEXT,
  p_user_id UUID,
  p_student_code TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code_row RECORD;
  v_class RECORD;
  v_existing_member_id UUID;
  v_existing_student_code TEXT;
  v_already_enrolled BOOLEAN := false;
  v_member_count INTEGER;
  v_org_id UUID;
  v_credit_amount INT := 0;
  v_space JSONB;
  v_input_student_code TEXT := NULLIF(TRIM(COALESCE(p_student_code, '')), '');
  v_previous_student_code TEXT;
  v_effective_student_code TEXT;
BEGIN
  SELECT id, class_id, max_uses, uses_count, expires_at, revoked_at, credit_amount
    INTO v_code_row
    FROM public.class_enrollment_codes
    WHERE code = p_code
    FOR UPDATE;

  IF v_code_row IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'code_not_found');
  END IF;
  IF v_code_row.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'code_revoked');
  END IF;
  IF v_code_row.expires_at IS NOT NULL AND v_code_row.expires_at < NOW() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'code_expired');
  END IF;
  IF v_code_row.max_uses IS NOT NULL AND v_code_row.uses_count >= v_code_row.max_uses THEN
    RETURN jsonb_build_object('ok', false, 'error', 'code_exhausted');
  END IF;

  SELECT id, organization_id, name, status, end_date, max_students, credit_policy, credit_amount
    INTO v_class
    FROM public.classes
    WHERE id = v_code_row.class_id AND deleted_at IS NULL
    FOR UPDATE;

  IF v_class IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'class_not_found');
  END IF;
  IF v_class.status = 'ended' OR v_class.status = 'archived' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'class_ended');
  END IF;
  IF v_class.end_date IS NOT NULL AND v_class.end_date < CURRENT_DATE THEN
    RETURN jsonb_build_object('ok', false, 'error', 'class_ended');
  END IF;

  v_org_id := v_class.organization_id;
  v_credit_amount := GREATEST(0, COALESCE(v_code_row.credit_amount, v_class.credit_amount, 0));

  SELECT id, student_code
    INTO v_existing_member_id, v_existing_student_code
    FROM public.class_members
    WHERE class_id = v_class.id AND user_id = p_user_id;

  SELECT cm.student_code
    INTO v_previous_student_code
    FROM public.class_members cm
    JOIN public.classes c ON c.id = cm.class_id
    WHERE cm.user_id = p_user_id
      AND cm.role = 'student'
      AND cm.status = 'active'
      AND NULLIF(TRIM(cm.student_code), '') IS NOT NULL
      AND c.organization_id = v_org_id
      AND c.deleted_at IS NULL
    ORDER BY cm.updated_at DESC NULLS LAST, cm.joined_at DESC NULLS LAST
    LIMIT 1;

  v_effective_student_code := COALESCE(
    v_input_student_code,
    NULLIF(TRIM(COALESCE(v_existing_student_code, '')), ''),
    NULLIF(TRIM(COALESCE(v_previous_student_code, '')), '')
  );

  IF v_existing_member_id IS NULL AND v_class.max_students IS NOT NULL THEN
    SELECT COUNT(*) INTO v_member_count
      FROM public.class_members
      WHERE class_id = v_class.id AND role = 'student' AND status = 'active';
    IF v_member_count >= v_class.max_students THEN
      RETURN jsonb_build_object('ok', false, 'error', 'class_full');
    END IF;
  END IF;

  IF v_existing_member_id IS NOT NULL THEN
    UPDATE public.class_members
       SET status = 'active',
           student_code = COALESCE(v_effective_student_code, student_code),
           updated_at = NOW()
     WHERE id = v_existing_member_id;
    v_already_enrolled := true;
  ELSE
    INSERT INTO public.class_members (class_id, user_id, role, status, student_code)
    VALUES (v_class.id, p_user_id, 'student', 'active', v_effective_student_code);
  END IF;

  UPDATE public.profiles
     SET organization_id = v_org_id,
         account_type = 'org_user',
         updated_at = NOW()
   WHERE user_id = p_user_id AND organization_id IS NULL;

  INSERT INTO public.organization_memberships (organization_id, user_id, role, status)
  VALUES (v_org_id, p_user_id, 'member', 'active')
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  v_space := public.ensure_education_student_space(
    v_class.id,
    p_user_id,
    v_effective_student_code,
    CASE WHEN v_already_enrolled THEN 0 ELSE v_credit_amount END,
    p_user_id,
    'qr_enrollment_grant'
  );

  IF COALESCE((v_space->>'ok')::BOOLEAN, FALSE) IS NOT TRUE THEN
    RETURN v_space;
  END IF;

  IF NOT v_already_enrolled THEN
    UPDATE public.class_enrollment_codes
       SET uses_count = uses_count + 1
     WHERE id = v_code_row.id;
  END IF;

  INSERT INTO public.workspace_activity
    (user_id, organization_id, class_id, activity_type, metadata)
  VALUES
    (p_user_id, v_org_id, v_class.id, 'enrollment',
     jsonb_build_object(
       'code', p_code,
       'student_code', v_effective_student_code,
       'already_enrolled', v_already_enrolled,
       'via', 'qr_code',
       'workspace_id', v_space->>'workspace_id',
       'credit_scope', 'education_space',
       'student_code_source',
         CASE
           WHEN v_input_student_code IS NOT NULL THEN 'input'
           WHEN NULLIF(TRIM(COALESCE(v_existing_student_code, '')), '') IS NOT NULL THEN 'existing_class'
           WHEN v_previous_student_code IS NOT NULL THEN 'previous_class'
           ELSE 'missing'
         END
     ));

  RETURN jsonb_build_object(
    'ok', true,
    'already_enrolled', v_already_enrolled,
    'class_id', v_class.id,
    'class_name', v_class.name,
    'organization_id', v_org_id,
    'starting_balance', COALESCE((v_space->>'starting_balance')::INT, 0),
    'student_code', v_effective_student_code,
    'needs_student_code', v_effective_student_code IS NULL,
    'workspace_id', v_space->>'workspace_id',
    'project_id', v_space->>'project_id',
    'space_id', v_space->>'space_id'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_enrollment_code(TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_enrollment_code(TEXT, UUID, TEXT) TO service_role;

DROP FUNCTION IF EXISTS public.workspace_education_credit_scope(UUID);
CREATE OR REPLACE FUNCTION public.workspace_education_credit_scope(p_user_id UUID)
RETURNS TABLE (
  organization_id UUID,
  organization_name TEXT,
  organization_type TEXT,
  class_id UUID,
  class_name TEXT,
  class_code TEXT,
  class_role TEXT,
  student_code TEXT,
  credit_balance INT,
  credits_lifetime_received INT,
  credits_lifetime_used INT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH memberships AS (
    SELECT
      o.id AS organization_id,
      COALESCE(o.display_name, o.name) AS organization_name,
      o.type AS organization_type,
      c.id AS class_id,
      c.name AS class_name,
      c.code AS class_code,
      cm.role AS class_role,
      cm.student_code,
      COALESCE((
        SELECT SUM(ess.credits_balance)::INT
        FROM public.education_student_spaces ess
        WHERE ess.class_id = c.id
          AND ess.user_id = cm.user_id
          AND ess.status IN ('active', 'submitted')
      ), cm.credits_balance, 0) AS credit_balance,
      COALESCE((
        SELECT SUM(ess.credits_lifetime_received)::INT
        FROM public.education_student_spaces ess
        WHERE ess.class_id = c.id
          AND ess.user_id = cm.user_id
      ), cm.credits_lifetime_received, 0) AS credits_lifetime_received,
      COALESCE((
        SELECT SUM(ess.credits_lifetime_used)::INT
        FROM public.education_student_spaces ess
        WHERE ess.class_id = c.id
          AND ess.user_id = cm.user_id
      ), cm.credits_lifetime_used, 0) AS credits_lifetime_used,
      CASE
        WHEN cm.role = 'student' THEN 0
        WHEN cm.role = 'teacher' THEN 1
        ELSE 2
      END AS priority,
      cm.joined_at
    FROM public.class_members cm
    JOIN public.classes c ON c.id = cm.class_id
    JOIN public.organizations o ON o.id = c.organization_id
    WHERE cm.user_id = p_user_id
      AND cm.status = 'active'
      AND c.status IN ('active', 'scheduled')
      AND c.deleted_at IS NULL
      AND o.status = 'active'
      AND o.deleted_at IS NULL
      AND o.type IN ('school', 'university')
    ORDER BY priority, cm.joined_at DESC
    LIMIT 1
  )
  SELECT
    organization_id,
    organization_name,
    organization_type,
    class_id,
    class_name,
    class_code,
    class_role,
    student_code,
    credit_balance,
    credits_lifetime_received,
    credits_lifetime_used
  FROM memberships;
$$;

GRANT EXECUTE ON FUNCTION public.workspace_education_credit_scope(UUID)
  TO authenticated, service_role;

COMMIT;
