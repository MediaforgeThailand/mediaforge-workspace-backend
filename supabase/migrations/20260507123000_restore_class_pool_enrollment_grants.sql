-- Restore the education credit contract to class pools.
-- QR/class-space grants draw from classes.credit_pool, not directly from the
-- institution pool. Re-opening an already-joined class link is idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.ensure_education_student_space(
  p_class_id UUID,
  p_user_id UUID,
  p_student_code TEXT DEFAULT NULL,
  p_credit_amount INT DEFAULT 0,
  p_actor_id UUID DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_class RECORD;
  v_member RECORD;
  v_existing RECORD;
  v_project_id TEXT;
  v_workspace_id TEXT;
  v_canvas_id UUID;
  v_space_name TEXT;
  v_credit_amount INT := GREATEST(0, COALESCE(p_credit_amount, 0));
  v_class_remaining INT;
BEGIN
  SELECT c.id,
         c.organization_id,
         c.name,
         c.code,
         c.status,
         COALESCE(c.credit_pool, 0) AS credit_pool,
         COALESCE(c.credit_pool_consumed, 0) AS credit_pool_consumed
    INTO v_class
    FROM public.classes c
    WHERE c.id = p_class_id
      AND c.deleted_at IS NULL
      AND c.status IN ('active', 'scheduled')
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'class_not_active');
  END IF;

  SELECT *
    INTO v_member
    FROM public.class_members
    WHERE class_id = p_class_id
      AND user_id = p_user_id
      AND role = 'student'
      AND status = 'active'
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'student_membership_not_found');
  END IF;

  IF v_credit_amount > 0 THEN
    v_class_remaining := GREATEST(v_class.credit_pool - v_class.credit_pool_consumed, 0);
    IF v_credit_amount > v_class_remaining THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'class_pool_exhausted',
        'class_pool_remaining', v_class_remaining
      );
    END IF;
  END IF;

  SELECT *
    INTO v_existing
    FROM public.education_student_spaces
    WHERE class_id = p_class_id
      AND user_id = p_user_id
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE;

  IF FOUND THEN
    IF v_credit_amount > 0 THEN
      UPDATE public.education_student_spaces
         SET credits_balance = credits_balance + v_credit_amount,
             credits_lifetime_received = credits_lifetime_received + v_credit_amount,
             status = CASE WHEN status IN ('passed', 'ended') THEN status ELSE 'active' END
       WHERE id = v_existing.id;

      UPDATE public.class_members
         SET credits_balance = credits_balance + v_credit_amount,
             credits_lifetime_received = credits_lifetime_received + v_credit_amount,
             updated_at = NOW()
       WHERE id = v_member.id;

      UPDATE public.classes
         SET credit_pool_consumed = credit_pool_consumed + v_credit_amount,
             updated_at = NOW()
       WHERE id = p_class_id;

      INSERT INTO public.pool_transactions (class_id, triggered_by, amount, reason, description, metadata)
      VALUES (
        p_class_id,
        p_actor_id,
        -v_credit_amount,
        'education_space_grant',
        COALESCE(p_reason, 'education space grant'),
        jsonb_build_object('workspace_id', v_existing.workspace_id, 'user_id', p_user_id)
      );
    END IF;

    RETURN jsonb_build_object(
      'ok', true,
      'workspace_id', v_existing.workspace_id,
      'project_id', v_existing.project_id,
      'space_id', v_existing.id,
      'starting_balance', v_existing.credits_balance + v_credit_amount,
      'already_exists', true
    );
  END IF;

  v_project_id := gen_random_uuid()::TEXT;
  v_workspace_id := gen_random_uuid()::TEXT;
  v_canvas_id := gen_random_uuid();
  v_space_name := v_class.name || ' - ' || COALESCE(NULLIF(TRIM(p_student_code), ''), 'student');

  INSERT INTO public.workspace_projects (id, user_id, name)
  VALUES (v_project_id, p_user_id, v_class.name);

  INSERT INTO public.workspaces (
    id, user_id, project_id, name, class_id, education_status, education_settings
  )
  VALUES (
    v_workspace_id,
    p_user_id,
    v_project_id,
    v_space_name,
    p_class_id,
    'active',
    jsonb_build_object('class_id', p_class_id, 'student_code', p_student_code)
  );

  INSERT INTO public.workspace_canvases (
    id, user_id, workspace_id, project_id, class_id, name, nodes, edges
  )
  VALUES (
    v_canvas_id,
    p_user_id,
    v_workspace_id,
    v_project_id,
    p_class_id,
    'Page 1',
    '[]'::jsonb,
    '[]'::jsonb
  );

  INSERT INTO public.education_student_spaces (
    organization_id,
    class_id,
    user_id,
    project_id,
    workspace_id,
    status,
    credits_balance,
    credits_lifetime_received,
    settings
  )
  VALUES (
    v_class.organization_id,
    p_class_id,
    p_user_id,
    v_project_id,
    v_workspace_id,
    'active',
    v_credit_amount,
    v_credit_amount,
    jsonb_build_object('student_code', p_student_code)
  )
  RETURNING * INTO v_existing;

  IF v_credit_amount > 0 THEN
    UPDATE public.class_members
       SET credits_balance = credits_balance + v_credit_amount,
           credits_lifetime_received = credits_lifetime_received + v_credit_amount,
           updated_at = NOW()
     WHERE id = v_member.id;

    UPDATE public.classes
       SET credit_pool_consumed = credit_pool_consumed + v_credit_amount,
           updated_at = NOW()
     WHERE id = p_class_id;

    INSERT INTO public.pool_transactions (class_id, triggered_by, amount, reason, description, metadata)
    VALUES (
      p_class_id,
      p_actor_id,
      -v_credit_amount,
      'education_space_grant',
      COALESCE(p_reason, 'education space grant'),
      jsonb_build_object('workspace_id', v_workspace_id, 'user_id', p_user_id)
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'workspace_id', v_workspace_id,
    'project_id', v_project_id,
    'canvas_id', v_canvas_id,
    'space_id', v_existing.id,
    'starting_balance', v_credit_amount,
    'already_exists', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_education_student_space(UUID, UUID, TEXT, INT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_education_student_space(UUID, UUID, TEXT, INT, UUID, TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.admin_adjust_education_space_credits(
  p_workspace_id TEXT,
  p_delta INT,
  p_actor_id UUID DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_space RECORD;
  v_class RECORD;
  v_delta INT := COALESCE(p_delta, 0);
  v_revoke INT;
  v_new_balance INT;
  v_class_remaining INT;
  v_transaction_amount INT;
  v_activity_amount INT;
BEGIN
  IF v_delta = 0 THEN
    RAISE EXCEPTION 'admin_adjust_education_space_credits: delta must be non-zero';
  END IF;

  SELECT *
    INTO v_space
    FROM public.education_student_spaces
    WHERE workspace_id = p_workspace_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_adjust_education_space_credits: space not found';
  END IF;

  SELECT id,
         organization_id,
         COALESCE(credit_pool, 0) AS credit_pool,
         COALESCE(credit_pool_consumed, 0) AS credit_pool_consumed
    INTO v_class
    FROM public.classes
    WHERE id = v_space.class_id
      AND deleted_at IS NULL
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_adjust_education_space_credits: class not found';
  END IF;

  IF v_delta > 0 THEN
    v_class_remaining := GREATEST(v_class.credit_pool - v_class.credit_pool_consumed, 0);
    IF v_delta > v_class_remaining THEN
      RETURN -1;
    END IF;

    UPDATE public.education_student_spaces
       SET credits_balance = credits_balance + v_delta,
           credits_lifetime_received = credits_lifetime_received + v_delta,
           status = CASE WHEN status IN ('passed', 'ended') THEN status ELSE 'active' END
     WHERE id = v_space.id
     RETURNING credits_balance INTO v_new_balance;

    UPDATE public.class_members
       SET credits_balance = credits_balance + v_delta,
           credits_lifetime_received = credits_lifetime_received + v_delta,
           updated_at = NOW()
     WHERE class_id = v_space.class_id
       AND user_id = v_space.user_id
       AND role = 'student';

    UPDATE public.classes
       SET credit_pool_consumed = credit_pool_consumed + v_delta,
           updated_at = NOW()
     WHERE id = v_space.class_id;

    v_transaction_amount := -v_delta;
    v_activity_amount := v_delta;
  ELSE
    v_revoke := LEAST(ABS(v_delta), v_space.credits_balance);

    UPDATE public.education_student_spaces
       SET credits_balance = GREATEST(credits_balance - v_revoke, 0)
     WHERE id = v_space.id
     RETURNING credits_balance INTO v_new_balance;

    UPDATE public.class_members
       SET credits_balance = GREATEST(credits_balance - v_revoke, 0),
           updated_at = NOW()
     WHERE class_id = v_space.class_id
       AND user_id = v_space.user_id
       AND role = 'student';

    UPDATE public.classes
       SET credit_pool_consumed = GREATEST(credit_pool_consumed - v_revoke, 0),
           updated_at = NOW()
     WHERE id = v_space.class_id;

    v_transaction_amount := v_revoke;
    v_activity_amount := v_revoke;
  END IF;

  INSERT INTO public.pool_transactions (class_id, triggered_by, amount, reason, description, metadata)
  VALUES (
    v_space.class_id,
    p_actor_id,
    v_transaction_amount,
    CASE WHEN v_delta > 0 THEN 'education_space_grant' ELSE 'education_space_revoke' END,
    COALESCE(p_reason, 'education space credit adjustment'),
    jsonb_build_object(
      'workspace_id', p_workspace_id,
      'user_id', v_space.user_id,
      'requested_delta', v_delta,
      'actual_amount', v_activity_amount,
      'source', 'class_pool'
    )
  );

  INSERT INTO public.workspace_activity
    (user_id, organization_id, class_id, activity_type, credits_used, metadata)
  VALUES
    (
      v_space.user_id,
      v_class.organization_id,
      v_space.class_id,
      CASE WHEN v_delta > 0 THEN 'credits_granted' ELSE 'credits_revoked' END,
      v_activity_amount,
      jsonb_build_object('actor_id', p_actor_id, 'reason', p_reason, 'workspace_id', p_workspace_id)
    );

  RETURN v_new_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_adjust_education_space_credits(TEXT, INT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adjust_education_space_credits(TEXT, INT, UUID, TEXT)
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

  SELECT id,
         organization_id,
         name,
         status,
         end_date,
         max_students,
         credit_policy,
         credit_amount,
         COALESCE(credit_pool, 0) AS credit_pool,
         COALESCE(credit_pool_consumed, 0) AS credit_pool_consumed
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

  v_already_enrolled := v_existing_member_id IS NOT NULL;

  IF NOT v_already_enrolled THEN
    IF v_code_row.revoked_at IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'code_revoked');
    END IF;
    IF v_code_row.expires_at IS NOT NULL AND v_code_row.expires_at < NOW() THEN
      RETURN jsonb_build_object('ok', false, 'error', 'code_expired');
    END IF;
    IF v_code_row.max_uses IS NOT NULL AND v_code_row.uses_count >= v_code_row.max_uses THEN
      RETURN jsonb_build_object('ok', false, 'error', 'code_exhausted');
    END IF;
  END IF;

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

  IF NOT v_already_enrolled AND v_class.max_students IS NOT NULL THEN
    SELECT COUNT(*) INTO v_member_count
      FROM public.class_members
      WHERE class_id = v_class.id AND role = 'student' AND status = 'active';
    IF v_member_count >= v_class.max_students THEN
      RETURN jsonb_build_object('ok', false, 'error', 'class_full');
    END IF;
  END IF;

  IF NOT v_already_enrolled
     AND v_credit_amount > 0
     AND v_credit_amount > GREATEST(v_class.credit_pool - v_class.credit_pool_consumed, 0) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'class_pool_exhausted',
      'class_pool_remaining', GREATEST(v_class.credit_pool - v_class.credit_pool_consumed, 0)
    );
  END IF;

  IF v_already_enrolled THEN
    UPDATE public.class_members
       SET status = 'active',
           student_code = COALESCE(v_effective_student_code, student_code),
           updated_at = NOW()
     WHERE id = v_existing_member_id;
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

COMMIT;
