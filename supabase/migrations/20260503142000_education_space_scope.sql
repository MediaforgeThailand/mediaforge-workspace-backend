-- Education space-scoped credits.
--
-- University students must not receive account-level credits. A QR/link
-- redemption creates a single class-owned workspace ("space") for the
-- student, and the credits granted by that QR are spendable only inside
-- that workspace. Completed spaces become read-only to students.

BEGIN;

ALTER TABLE public.class_enrollment_codes
  ADD COLUMN IF NOT EXISTS credit_amount INT NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.pool_transactions
  DROP CONSTRAINT IF EXISTS pool_transactions_reason_check;

ALTER TABLE public.pool_transactions
  ADD CONSTRAINT pool_transactions_reason_check CHECK (reason IN (
    'member_grant',
    'cycle_reset',
    'cycle_drip',
    'class_revoke',
    'class_pool_allocation',
    'class_pool_consumed',
    'class_pool_revoked',
    'org_pool_topup',
    'org_pool_allocation',
    'org_pool_revoked',
    'org_node_run',
    'org_node_run_refund',
    'education_space_grant',
    'education_space_revoke'
  ));

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS education_status TEXT
    CHECK (education_status IS NULL OR education_status IN ('active', 'submitted', 'passed', 'ended')),
  ADD COLUMN IF NOT EXISTS education_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS education_completed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS education_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.education_student_spaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES public.workspace_projects(id) ON DELETE SET NULL,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'submitted', 'passed', 'ended')),
  credits_balance INT NOT NULL DEFAULT 0 CHECK (credits_balance >= 0),
  credits_lifetime_received INT NOT NULL DEFAULT 0 CHECK (credits_lifetime_received >= 0),
  credits_lifetime_used INT NOT NULL DEFAULT 0 CHECK (credits_lifetime_used >= 0),
  last_activity_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id),
  UNIQUE (class_id, user_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_education_student_spaces_class
  ON public.education_student_spaces (class_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_education_student_spaces_user
  ON public.education_student_spaces (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_education_student_spaces_active
  ON public.education_student_spaces (class_id, status, updated_at DESC)
  WHERE status IN ('active', 'submitted');

CREATE OR REPLACE FUNCTION public.education_student_spaces_touch()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS education_student_spaces_touch_trg ON public.education_student_spaces;
CREATE TRIGGER education_student_spaces_touch_trg
  BEFORE UPDATE ON public.education_student_spaces
  FOR EACH ROW EXECUTE FUNCTION public.education_student_spaces_touch();

ALTER TABLE public.education_student_spaces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS education_student_spaces_admin_all ON public.education_student_spaces;
CREATE POLICY education_student_spaces_admin_all ON public.education_student_spaces
  FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS education_student_spaces_teacher_read ON public.education_student_spaces;
CREATE POLICY education_student_spaces_teacher_read ON public.education_student_spaces
  FOR SELECT
  USING (public.is_class_teacher(auth.uid(), class_id));

DROP POLICY IF EXISTS education_student_spaces_teacher_update ON public.education_student_spaces;
CREATE POLICY education_student_spaces_teacher_update ON public.education_student_spaces
  FOR UPDATE
  USING (public.is_class_teacher(auth.uid(), class_id))
  WITH CHECK (public.is_class_teacher(auth.uid(), class_id));

DROP POLICY IF EXISTS education_student_spaces_self_read ON public.education_student_spaces;
CREATE POLICY education_student_spaces_self_read ON public.education_student_spaces
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.is_education_teacher_or_admin(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.has_role(p_user_id, 'admin'::public.app_role)
    OR EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      JOIN public.organizations o ON o.id = om.organization_id
      WHERE om.user_id = p_user_id
        AND om.status = 'active'
        AND om.role = 'org_admin'
        AND o.type IN ('school', 'university')
        AND o.status = 'active'
        AND o.deleted_at IS NULL
    )
    OR EXISTS (
      SELECT 1
      FROM public.class_members cm
      JOIN public.classes c ON c.id = cm.class_id
      JOIN public.organizations o ON o.id = c.organization_id
      WHERE cm.user_id = p_user_id
        AND cm.role = 'teacher'
        AND cm.status = 'active'
        AND c.deleted_at IS NULL
        AND c.status IN ('active', 'scheduled')
        AND o.type IN ('school', 'university')
        AND o.status = 'active'
        AND o.deleted_at IS NULL
    );
$$;

GRANT EXECUTE ON FUNCTION public.is_education_teacher_or_admin(UUID)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_education_locked_student(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      JOIN public.organizations o ON o.id = om.organization_id
      WHERE om.user_id = p_user_id
        AND om.status = 'active'
        AND o.type IN ('school', 'university')
        AND o.status = 'active'
        AND o.deleted_at IS NULL
    )
    AND NOT public.is_education_teacher_or_admin(p_user_id);
$$;

GRANT EXECUTE ON FUNCTION public.is_education_locked_student(UUID)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.can_write_workspace_for_user(
  p_user_id UUID,
  p_workspace_id TEXT,
  p_class_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    CASE
      WHEN NOT public.is_education_locked_student(p_user_id) THEN TRUE
      WHEN p_workspace_id IS NULL THEN FALSE
      WHEN EXISTS (
        SELECT 1
        FROM public.education_student_spaces ess
        WHERE ess.user_id = p_user_id
          AND ess.workspace_id = p_workspace_id
          AND ess.status IN ('active', 'submitted')
          AND (p_class_id IS NULL OR ess.class_id = p_class_id)
      ) THEN TRUE
      ELSE FALSE
    END;
$$;

GRANT EXECUTE ON FUNCTION public.can_write_workspace_for_user(UUID, TEXT, UUID)
  TO authenticated, service_role;

-- Tighten workspace/canvas write policies so school/university students can
-- only write the class space created for them by the QR redemption flow.
DROP POLICY IF EXISTS "users can insert their own workspaces" ON public.workspaces;
CREATE POLICY "users can insert their own workspaces"
  ON public.workspaces FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND (
      NOT public.is_education_locked_student(auth.uid())
      OR (
        class_id IS NOT NULL
        AND public.can_write_workspace_for_user(auth.uid(), id, class_id)
      )
    )
  );

DROP POLICY IF EXISTS "users can update their own workspaces" ON public.workspaces;
CREATE POLICY "users can update their own workspaces"
  ON public.workspaces FOR UPDATE
  USING (
    auth.uid() = user_id
    AND public.can_write_workspace_for_user(auth.uid(), id, class_id)
  )
  WITH CHECK (
    auth.uid() = user_id
    AND public.can_write_workspace_for_user(auth.uid(), id, class_id)
  );

DROP POLICY IF EXISTS "users can delete their own workspaces" ON public.workspaces;
CREATE POLICY "users can delete their own workspaces"
  ON public.workspaces FOR DELETE
  USING (
    auth.uid() = user_id
    AND education_status IS NULL
    AND NOT public.is_education_locked_student(auth.uid())
  );

DROP POLICY IF EXISTS "workspace_canvases own insert" ON public.workspace_canvases;
CREATE POLICY "workspace_canvases own insert"
  ON public.workspace_canvases FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND public.can_write_workspace_for_user(auth.uid(), workspace_id, class_id)
  );

DROP POLICY IF EXISTS "workspace_canvases own update" ON public.workspace_canvases;
CREATE POLICY "workspace_canvases own update"
  ON public.workspace_canvases FOR UPDATE
  USING (
    auth.uid() = user_id
    AND public.can_write_workspace_for_user(auth.uid(), workspace_id, class_id)
  )
  WITH CHECK (
    auth.uid() = user_id
    AND public.can_write_workspace_for_user(auth.uid(), workspace_id, class_id)
  );

DROP POLICY IF EXISTS "workspace_canvases own delete" ON public.workspace_canvases;
CREATE POLICY "workspace_canvases own delete"
  ON public.workspace_canvases FOR DELETE
  USING (
    auth.uid() = user_id
    AND public.can_write_workspace_for_user(auth.uid(), workspace_id, class_id)
  );

DROP POLICY IF EXISTS "workspace_projects own insert" ON public.workspace_projects;
CREATE POLICY "workspace_projects own insert"
  ON public.workspace_projects FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND NOT public.is_education_locked_student(auth.uid())
  );

DROP POLICY IF EXISTS "workspace_projects own update" ON public.workspace_projects;
CREATE POLICY "workspace_projects own update"
  ON public.workspace_projects FOR UPDATE
  USING (
    auth.uid() = user_id
    AND NOT public.is_education_locked_student(auth.uid())
  )
  WITH CHECK (
    auth.uid() = user_id
    AND NOT public.is_education_locked_student(auth.uid())
  );

DROP POLICY IF EXISTS "workspace_projects own delete" ON public.workspace_projects;
CREATE POLICY "workspace_projects own delete"
  ON public.workspace_projects FOR DELETE
  USING (
    auth.uid() = user_id
    AND NOT public.is_education_locked_student(auth.uid())
  );

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
        v_credit_amount,
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
      v_credit_amount,
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

CREATE OR REPLACE FUNCTION public.consume_education_space_credits(
  p_user_id UUID,
  p_workspace_id TEXT,
  p_amount INT,
  p_feature TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_reference_id TEXT DEFAULT NULL,
  p_canvas_id TEXT DEFAULT NULL,
  p_model_id TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_space RECORD;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'consume_education_space_credits: amount must be positive';
  END IF;

  SELECT ess.*
    INTO v_space
    FROM public.education_student_spaces ess
    JOIN public.classes c ON c.id = ess.class_id
    WHERE ess.user_id = p_user_id
      AND ess.workspace_id = p_workspace_id
      AND ess.status IN ('active', 'submitted')
      AND c.status IN ('active', 'scheduled')
      AND c.deleted_at IS NULL
    FOR UPDATE OF ess;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EDUCATION_SPACE_REQUIRED';
  END IF;

  IF v_space.credits_balance < p_amount THEN
    RETURN FALSE;
  END IF;

  UPDATE public.education_student_spaces
     SET credits_balance = credits_balance - p_amount,
         credits_lifetime_used = credits_lifetime_used + p_amount,
         last_activity_at = NOW()
   WHERE id = v_space.id;

  UPDATE public.class_members
     SET credits_balance = GREATEST(credits_balance - p_amount, 0),
         credits_lifetime_used = credits_lifetime_used + p_amount,
         updated_at = NOW()
   WHERE class_id = v_space.class_id
     AND user_id = p_user_id
     AND role = 'student';

  INSERT INTO public.workspace_activity
    (user_id, organization_id, class_id, activity_type, model_id, credits_used, metadata)
  VALUES
    (
      p_user_id,
      v_space.organization_id,
      v_space.class_id,
      'model_use',
      p_model_id,
      p_amount,
      jsonb_build_object(
        'feature', p_feature,
        'description', p_description,
        'reference_id', p_reference_id,
        'workspace_id', p_workspace_id,
        'canvas_id', p_canvas_id,
        'credit_scope', 'education_space'
      )
    );

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_education_space_credits(UUID, TEXT, INT, TEXT, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_education_space_credits(UUID, TEXT, INT, TEXT, TEXT, TEXT, TEXT, TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.refund_education_space_credits(
  p_user_id UUID,
  p_workspace_id TEXT,
  p_amount INT,
  p_reason TEXT DEFAULT NULL,
  p_reference_id TEXT DEFAULT NULL,
  p_canvas_id TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_space RECORD;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN;
  END IF;

  SELECT *
    INTO v_space
    FROM public.education_student_spaces
    WHERE user_id = p_user_id
      AND workspace_id = p_workspace_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.education_student_spaces
     SET credits_balance = credits_balance + p_amount,
         credits_lifetime_used = GREATEST(credits_lifetime_used - p_amount, 0)
   WHERE id = v_space.id;

  UPDATE public.class_members
     SET credits_balance = credits_balance + p_amount,
         credits_lifetime_used = GREATEST(credits_lifetime_used - p_amount, 0),
         updated_at = NOW()
   WHERE class_id = v_space.class_id
     AND user_id = p_user_id
     AND role = 'student';

  INSERT INTO public.workspace_activity
    (user_id, organization_id, class_id, activity_type, credits_used, metadata)
  VALUES
    (
      p_user_id,
      v_space.organization_id,
      v_space.class_id,
      'credits_refunded',
      p_amount,
      jsonb_build_object(
        'reason', p_reason,
        'reference_id', p_reference_id,
        'workspace_id', p_workspace_id,
        'canvas_id', p_canvas_id,
        'credit_scope', 'education_space'
      )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.refund_education_space_credits(UUID, TEXT, INT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_education_space_credits(UUID, TEXT, INT, TEXT, TEXT, TEXT)
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
  v_delta INT := COALESCE(p_delta, 0);
  v_revoke INT;
  v_new_balance INT;
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

  IF v_delta > 0 THEN
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
  END IF;

  INSERT INTO public.pool_transactions (class_id, triggered_by, amount, reason, description, metadata)
  VALUES (
    v_space.class_id,
    p_actor_id,
    v_delta,
    CASE WHEN v_delta > 0 THEN 'education_space_grant' ELSE 'education_space_revoke' END,
    COALESCE(p_reason, 'ERP education space credit adjustment'),
    jsonb_build_object('workspace_id', p_workspace_id, 'user_id', v_space.user_id)
  );

  INSERT INTO public.workspace_activity
    (user_id, organization_id, class_id, activity_type, credits_used, metadata)
  VALUES
    (
      v_space.user_id,
      v_space.organization_id,
      v_space.class_id,
      CASE WHEN v_delta > 0 THEN 'credits_granted' ELSE 'credits_revoked' END,
      ABS(v_delta),
      jsonb_build_object('actor_id', p_actor_id, 'reason', p_reason, 'workspace_id', p_workspace_id)
    );

  RETURN v_new_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_adjust_education_space_credits(TEXT, INT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adjust_education_space_credits(TEXT, INT, UUID, TEXT)
  TO service_role;

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

-- Replace the QR redemption RPC so it creates a class-owned workspace and
-- never mirrors education credits into user_credits.
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
  v_existing UUID;
  v_already_enrolled BOOLEAN := false;
  v_member_count INTEGER;
  v_org_id UUID;
  v_credit_amount INT := 0;
  v_space JSONB;
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

  IF v_class.max_students IS NOT NULL THEN
    SELECT COUNT(*) INTO v_member_count
      FROM public.class_members
      WHERE class_id = v_class.id AND role = 'student' AND status = 'active';
    IF v_member_count >= v_class.max_students THEN
      RETURN jsonb_build_object('ok', false, 'error', 'class_full');
    END IF;
  END IF;

  SELECT id INTO v_existing
    FROM public.class_members
    WHERE class_id = v_class.id AND user_id = p_user_id;

  IF v_existing IS NOT NULL THEN
    UPDATE public.class_members
       SET status = 'active',
           student_code = COALESCE(NULLIF(TRIM(p_student_code), ''), student_code),
           updated_at = NOW()
     WHERE id = v_existing;
    v_already_enrolled := true;
  ELSE
    INSERT INTO public.class_members (class_id, user_id, role, status, student_code)
    VALUES (v_class.id, p_user_id, 'student', 'active', NULLIF(TRIM(p_student_code), ''));
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
    p_student_code,
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
       'student_code', p_student_code,
       'already_enrolled', v_already_enrolled,
       'via', 'qr_code',
       'workspace_id', v_space->>'workspace_id',
       'credit_scope', 'education_space'
     ));

  RETURN jsonb_build_object(
    'ok', true,
    'already_enrolled', v_already_enrolled,
    'class_id', v_class.id,
    'class_name', v_class.name,
    'organization_id', v_org_id,
    'starting_balance', COALESCE((v_space->>'starting_balance')::INT, 0),
    'student_code', p_student_code,
    'workspace_id', v_space->>'workspace_id',
    'project_id', v_space->>'project_id',
    'space_id', v_space->>'space_id'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_enrollment_code(TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_enrollment_code(TEXT, UUID, TEXT) TO service_role;

DROP VIEW IF EXISTS public.class_memberships;
CREATE OR REPLACE VIEW public.class_memberships AS
SELECT
  cm.id,
  cm.class_id,
  cm.user_id,
  cm.status,
  cm.joined_at AS enrolled_at,
  cm.student_code,
  COALESCE(space_totals.credits_balance, cm.credits_balance, 0) AS credits_balance,
  COALESCE(space_totals.credits_lifetime_received, cm.credits_lifetime_received, 0) AS credits_lifetime_received,
  COALESCE(space_totals.credits_lifetime_used, cm.credits_lifetime_used, 0) AS credits_lifetime_used,
  cm.created_at,
  cm.updated_at
FROM public.class_members cm
LEFT JOIN (
  SELECT
    class_id,
    user_id,
    SUM(credits_balance)::INT AS credits_balance,
    SUM(credits_lifetime_received)::INT AS credits_lifetime_received,
    SUM(credits_lifetime_used)::INT AS credits_lifetime_used
  FROM public.education_student_spaces
  GROUP BY class_id, user_id
) space_totals
  ON space_totals.class_id = cm.class_id
 AND space_totals.user_id = cm.user_id
WHERE cm.role = 'student';

GRANT SELECT ON public.class_memberships TO authenticated, service_role;

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
    credit_balance,
    credits_lifetime_received,
    credits_lifetime_used
  FROM memberships;
$$;

GRANT EXECUTE ON FUNCTION public.workspace_education_credit_scope(UUID)
  TO authenticated, service_role;

ALTER TABLE public.workspace_generation_jobs
  DROP CONSTRAINT IF EXISTS workspace_generation_jobs_credit_scope_check;

ALTER TABLE public.workspace_generation_jobs
  ADD CONSTRAINT workspace_generation_jobs_credit_scope_check
  CHECK (credit_scope IN ('user', 'team', 'organization', 'education_space'));

COMMIT;
