-- Grant QR enrollment credits once per enrollment code and user, even when
-- the student membership/space already exists. This fixes account-first
-- enrollment flows where a class space can be created before the first QR
-- credit grant, while still preventing repeated scans from pumping credits.

BEGIN;

CREATE TABLE IF NOT EXISTS public.class_enrollment_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id UUID NOT NULL REFERENCES public.class_enrollment_codes(id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  workspace_id TEXT,
  credit_amount INT NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (code_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_class_enrollment_redemptions_class
  ON public.class_enrollment_redemptions(class_id, redeemed_at DESC);

ALTER TABLE public.class_enrollment_redemptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS class_enrollment_redemptions_admin_all ON public.class_enrollment_redemptions;
CREATE POLICY class_enrollment_redemptions_admin_all ON public.class_enrollment_redemptions
  FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS class_enrollment_redemptions_teacher_read ON public.class_enrollment_redemptions;
CREATE POLICY class_enrollment_redemptions_teacher_read ON public.class_enrollment_redemptions
  FOR SELECT USING (
    public.is_class_teacher(auth.uid(), class_id)
    OR EXISTS (
      SELECT 1
      FROM public.classes c
      WHERE c.id = class_enrollment_redemptions.class_id
        AND public.is_org_admin(auth.uid(), c.organization_id)
    )
  );

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
  v_existing_redemption_id UUID;
  v_should_grant BOOLEAN := false;
  v_member_count INTEGER;
  v_org_id UUID;
  v_credit_amount INT := 0;
  v_grant_amount INT := 0;
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

  SELECT id
    INTO v_existing_redemption_id
    FROM public.class_enrollment_redemptions
    WHERE code_id = v_code_row.id
      AND user_id = p_user_id;

  v_should_grant := v_existing_redemption_id IS NULL;
  v_grant_amount := CASE WHEN v_should_grant THEN v_credit_amount ELSE 0 END;

  IF v_should_grant THEN
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

  IF v_grant_amount > 0
     AND v_grant_amount > GREATEST(v_class.credit_pool - v_class.credit_pool_consumed, 0) THEN
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
    v_grant_amount,
    p_user_id,
    'qr_enrollment_grant'
  );

  IF COALESCE((v_space->>'ok')::BOOLEAN, FALSE) IS NOT TRUE THEN
    RETURN v_space;
  END IF;

  IF v_should_grant THEN
    INSERT INTO public.class_enrollment_redemptions (
      code_id,
      class_id,
      user_id,
      workspace_id,
      credit_amount,
      metadata
    )
    VALUES (
      v_code_row.id,
      v_class.id,
      p_user_id,
      v_space->>'workspace_id',
      v_grant_amount,
      jsonb_build_object('student_code', v_effective_student_code, 'already_enrolled', v_already_enrolled)
    );

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
       'credited_this_scan', v_should_grant,
       'granted_credits', v_grant_amount,
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
    'credited_this_scan', v_should_grant,
    'granted_credits', v_grant_amount,
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
