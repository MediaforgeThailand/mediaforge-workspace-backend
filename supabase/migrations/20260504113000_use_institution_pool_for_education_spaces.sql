-- Education spaces no longer use a class-level credit pool. Existing
-- education class allocations are folded back into the institution pool model:
-- previously consumed class credits become direct institution spend, while
-- unused class allocations are released back to the institution.

WITH education_class_rollup AS (
  SELECT
    c.organization_id,
    SUM(COALESCE(c.credit_pool, 0))::INT AS total_class_pool,
    SUM(COALESCE(c.credit_pool_consumed, 0))::INT AS total_consumed
  FROM public.classes c
  JOIN public.organizations o ON o.id = c.organization_id
  WHERE o.type IN ('school', 'university')
    AND o.deleted_at IS NULL
    AND c.deleted_at IS NULL
  GROUP BY c.organization_id
)
UPDATE public.organizations o
   SET credit_pool = GREATEST(0, o.credit_pool - r.total_consumed),
       credit_pool_allocated = LEAST(
         GREATEST(0, o.credit_pool_allocated - r.total_class_pool),
         GREATEST(0, o.credit_pool - r.total_consumed)
       ),
       updated_at = NOW()
  FROM education_class_rollup r
 WHERE o.id = r.organization_id
   AND (r.total_class_pool > 0 OR r.total_consumed > 0);

UPDATE public.classes c
   SET credit_pool = 0,
       updated_at = NOW()
  FROM public.organizations o
 WHERE o.id = c.organization_id
   AND o.type IN ('school', 'university')
   AND o.deleted_at IS NULL
   AND c.deleted_at IS NULL
   AND c.credit_pool <> 0;

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
  v_org RECORD;
  v_project_id TEXT;
  v_workspace_id TEXT;
  v_canvas_id UUID;
  v_space_name TEXT;
  v_credit_amount INT := GREATEST(0, COALESCE(p_credit_amount, 0));
  v_org_remaining INT;
BEGIN
  SELECT c.id, c.organization_id, c.name, c.code, c.status
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
    SELECT id, credit_pool, credit_pool_allocated
      INTO v_org
      FROM public.organizations
      WHERE id = v_class.organization_id
        AND type IN ('school', 'university')
        AND status = 'active'
        AND deleted_at IS NULL
      FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'institution_not_active');
    END IF;

    v_org_remaining := GREATEST(COALESCE(v_org.credit_pool, 0) - COALESCE(v_org.credit_pool_allocated, 0), 0);
    IF v_credit_amount > v_org_remaining THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'institution_budget_exhausted',
        'institution_pool_remaining', v_org_remaining
      );
    END IF;

    UPDATE public.organizations
       SET credit_pool = credit_pool - v_credit_amount,
           updated_at = NOW()
     WHERE id = v_class.organization_id;
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

      INSERT INTO public.pool_transactions (organization_id, class_id, triggered_by, amount, reason, description, metadata)
      VALUES (
        v_class.organization_id,
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

    INSERT INTO public.pool_transactions (organization_id, class_id, triggered_by, amount, reason, description, metadata)
    VALUES (
      v_class.organization_id,
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
  v_org RECORD;
  v_delta INT := COALESCE(p_delta, 0);
  v_revoke INT;
  v_new_balance INT;
  v_org_remaining INT;
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

  SELECT id, credit_pool, credit_pool_allocated
    INTO v_org
    FROM public.organizations
    WHERE id = v_space.organization_id
      AND type IN ('school', 'university')
      AND status = 'active'
      AND deleted_at IS NULL
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_adjust_education_space_credits: institution not active';
  END IF;

  IF v_delta > 0 THEN
    v_org_remaining := GREATEST(COALESCE(v_org.credit_pool, 0) - COALESCE(v_org.credit_pool_allocated, 0), 0);
    IF v_delta > v_org_remaining THEN
      RETURN -1;
    END IF;

    UPDATE public.organizations
       SET credit_pool = credit_pool - v_delta,
           updated_at = NOW()
     WHERE id = v_space.organization_id;

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

    UPDATE public.organizations
       SET credit_pool = credit_pool + v_revoke,
           updated_at = NOW()
     WHERE id = v_space.organization_id;

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

  INSERT INTO public.pool_transactions (organization_id, class_id, triggered_by, amount, reason, description, metadata)
  VALUES (
    v_space.organization_id,
    v_space.class_id,
    p_actor_id,
    v_transaction_amount,
    CASE WHEN v_delta > 0 THEN 'education_space_grant' ELSE 'education_space_revoke' END,
    COALESCE(p_reason, 'ERP education space credit adjustment'),
    jsonb_build_object(
      'workspace_id', p_workspace_id,
      'user_id', v_space.user_id,
      'requested_delta', v_delta,
      'actual_amount', v_activity_amount
    )
  );

  INSERT INTO public.workspace_activity
    (user_id, organization_id, class_id, activity_type, credits_used, metadata)
  VALUES
    (
      v_space.user_id,
      v_space.organization_id,
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
