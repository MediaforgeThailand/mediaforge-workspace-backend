-- public.redeem_enrollment_code(code, user_id, student_code) — atomic class join.
--
-- Called by mf-um-class-enroll edge function after a student scans a
-- teacher's QR code. Validates the code, joins them to the class, logs
-- activity, and returns class info + starting balance.
--
-- Logic:
--   1. Look up code in class_enrollment_codes. Reject if missing / revoked
--      / expired / max_uses reached.
--   2. Look up class. Reject if deleted / archived / ended (past end_date).
--   3. UPSERT into class_members (idempotent — re-scanning the same code
--      doesn't error, just returns "already enrolled").
--   4. Increment code uses_count (race-safe via row lock).
--   5. Log workspace_activity (enrollment).
--   6. If class.credit_policy != 'manual', grant initial credits per policy.
--
-- Return shape (jsonb):
--   {
--     ok: true,
--     already_enrolled: bool,
--     class_id, class_name, organization_id,
--     starting_balance: int,
--     student_code: text|null
--   }
-- On error:
--   { ok: false, error: 'code_not_found'|'code_expired'|'code_exhausted'|
--                       'class_not_found'|'class_ended'|'class_full' }

BEGIN;

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
  v_starting_balance INTEGER := 0;
  v_org_id UUID;
BEGIN
  -- 1. Lock code row
  SELECT id, class_id, max_uses, uses_count, expires_at, revoked_at
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

  -- 2. Lock class row + check viability
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

  -- Check class capacity (only if max_students set)
  IF v_class.max_students IS NOT NULL THEN
    SELECT COUNT(*) INTO v_member_count
      FROM public.class_members
      WHERE class_id = v_class.id AND status = 'active';
    IF v_member_count >= v_class.max_students THEN
      RETURN jsonb_build_object('ok', false, 'error', 'class_full');
    END IF;
  END IF;

  -- 3. Check existing membership
  SELECT id INTO v_existing
    FROM public.class_members
    WHERE class_id = v_class.id AND user_id = p_user_id;

  IF v_existing IS NOT NULL THEN
    -- Already enrolled — re-activate if suspended/left, idempotent otherwise
    UPDATE public.class_members
       SET status = 'active', updated_at = NOW()
       WHERE id = v_existing AND status != 'active';
    v_already_enrolled := true;

    SELECT credits_balance INTO v_starting_balance
      FROM public.class_members WHERE id = v_existing;
  ELSE
    -- Fresh enrolment
    INSERT INTO public.class_members (class_id, user_id, role, status)
    VALUES (v_class.id, p_user_id, 'student', 'active');

    -- 6. Grant initial credits if policy != manual
    IF v_class.credit_policy IN ('monthly_reset', 'weekly_drip') AND v_class.credit_amount > 0 THEN
      -- Update class pool consumed counter
      -- Note: we don't enforce pool capacity here — initial enrolment grants
      -- come from the class's allocation regardless of remaining pool. Teacher
      -- can revoke later if pool runs out.
      UPDATE public.classes
         SET credit_pool_consumed = credit_pool_consumed + v_class.credit_amount,
             updated_at = NOW()
         WHERE id = v_class.id;

      -- Mirror to user wallet (credit_batches + user_credits)
      INSERT INTO public.credit_batches (user_id, source_type, amount, remaining, expires_at, reference_id)
      VALUES (
        p_user_id,
        'class_grant',
        v_class.credit_amount,
        v_class.credit_amount,
        COALESCE((v_class.end_date + INTERVAL '30 days')::timestamptz, NOW() + INTERVAL '1 year'),
        v_class.id::text
      );

      INSERT INTO public.user_credits (user_id, balance)
      VALUES (p_user_id, v_class.credit_amount)
      ON CONFLICT (user_id) DO UPDATE
        SET balance = public.user_credits.balance + EXCLUDED.balance,
            updated_at = NOW();

      UPDATE public.class_members
         SET credits_balance = v_class.credit_amount,
             credits_lifetime_received = credits_lifetime_received + v_class.credit_amount,
             updated_at = NOW()
         WHERE class_id = v_class.id AND user_id = p_user_id;

      INSERT INTO public.pool_transactions (class_id, triggered_by, amount, reason, description)
      VALUES (v_class.id, p_user_id, -v_class.credit_amount, 'class_pool_consumed', 'enrolment grant');
      INSERT INTO public.pool_transactions (user_id, triggered_by, amount, reason, description, metadata)
      VALUES (p_user_id, p_user_id, v_class.credit_amount, 'member_grant', 'enrolment grant',
              jsonb_build_object('class_id', v_class.id, 'auto', true));

      v_starting_balance := v_class.credit_amount;
    END IF;
  END IF;

  -- 4. Increment code uses_count (only if NEW enrolment)
  IF NOT v_already_enrolled THEN
    UPDATE public.class_enrollment_codes
       SET uses_count = uses_count + 1
       WHERE id = v_code_row.id;
  END IF;

  -- 5. Activity log (always, even for re-enrolment)
  INSERT INTO public.workspace_activity
    (user_id, organization_id, class_id, activity_type, metadata)
  VALUES
    (p_user_id, v_org_id, v_class.id, 'enrollment',
     jsonb_build_object(
       'code', p_code,
       'student_code', p_student_code,
       'already_enrolled', v_already_enrolled,
       'via', 'qr_code'
     ));

  -- Optionally pin profile.organization_id (for users who joined via QR but
  -- whose email domain wasn't registered — this is a manual fast-path)
  UPDATE public.profiles
     SET organization_id = v_org_id,
         account_type = 'org_user',
         updated_at = NOW()
     WHERE user_id = p_user_id AND organization_id IS NULL;

  -- And ensure organization_memberships row
  INSERT INTO public.organization_memberships (organization_id, user_id, role, status)
  VALUES (v_org_id, p_user_id, 'member', 'active')
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  RETURN jsonb_build_object(
    'ok', true,
    'already_enrolled', v_already_enrolled,
    'class_id', v_class.id,
    'class_name', v_class.name,
    'organization_id', v_org_id,
    'starting_balance', v_starting_balance,
    'student_code', p_student_code
  );
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_enrollment_code(TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_enrollment_code(TEXT, UUID, TEXT) TO service_role;

COMMENT ON FUNCTION public.redeem_enrollment_code(TEXT, UUID, TEXT) IS
  'Atomic class enrolment via QR code. Called by mf-um-class-enroll edge fn. Returns jsonb with ok/error + class info.';

COMMIT;
