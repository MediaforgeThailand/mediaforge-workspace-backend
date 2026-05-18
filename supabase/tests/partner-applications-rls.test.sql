-- Tests for the tightened partner_applications RLS policy from
-- 20260518162718_partner_applications_rls_tighten.sql.
--
-- Each test wraps in a transaction and ROLLBACKs to leave DB clean.
-- We simulate an authenticated user by SET LOCAL ROLE authenticated +
-- SET LOCAL request.jwt.claim.sub = '<uuid>'.

\set ON_ERROR_STOP on

-- ─────────────────────────────────────────────────────────────
-- TEST 1: User tries to INSERT with status='approved' → REJECT
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_user UUID;
BEGIN
  SELECT user_id INTO v_user
  FROM public.user_credits
  WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
  ORDER BY user_id LIMIT 1;

  IF v_user IS NULL THEN
    RAISE NOTICE '⚠️ TEST 1 SKIPPED: no eligible user';
    RETURN;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  BEGIN
    INSERT INTO public.partner_applications (
      user_id, legal_first_name, legal_last_name, phone_e164,
      bank_name, bank_account_no, bank_account_name, status
    ) VALUES (
      v_user, 'Self', 'Approve', '+66999999999',
      'SCB', '0123456789', 'Self',
      'approved'
    );
    RAISE NOTICE '❌ TEST 1 FAIL: INSERT with status=approved was allowed';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    RAISE NOTICE '✅ TEST 1 PASS: INSERT with status=approved rejected';
  END;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 2: User tries to UPDATE their own row to status='approved' → REJECT
--         (this is the headline regression we are fixing)
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_user UUID;
  v_app_id UUID;
BEGIN
  SELECT user_id INTO v_user
  FROM public.user_credits
  WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
  ORDER BY user_id LIMIT 1;

  IF v_user IS NULL THEN
    RAISE NOTICE '⚠️ TEST 2 SKIPPED: no eligible user';
    RETURN;
  END IF;

  -- Service-role seed: an existing draft application
  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (
    v_user, 'Real', 'Draft', '+66999999999',
    'SCB', '0123456789', 'Real Draft',
    'draft'
  )
  RETURNING id INTO v_app_id;

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  BEGIN
    UPDATE public.partner_applications SET status = 'approved' WHERE id = v_app_id;
    -- If the row count is zero, PostgreSQL still raises only if RLS rejects
    -- with check_violation; column-level REVOKE raises insufficient_privilege.
    -- Either way, the UPDATE should NOT change status to 'approved'.
    IF (SELECT status FROM public.partner_applications WHERE id = v_app_id) = 'approved' THEN
      RAISE NOTICE '❌ TEST 2 FAIL: UPDATE to status=approved was applied';
    ELSE
      RAISE NOTICE '✅ TEST 2 PASS: UPDATE to status=approved blocked';
    END IF;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    RAISE NOTICE '✅ TEST 2 PASS: UPDATE to status=approved rejected with %', SQLSTATE;
  END;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 3: User legitimately edits their bank info on a draft → OK
--         (regression check: tightening must not block legit edits)
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_user UUID;
  v_app_id UUID;
  v_new_bank TEXT;
BEGIN
  SELECT user_id INTO v_user
  FROM public.user_credits
  WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
  ORDER BY user_id LIMIT 1;

  IF v_user IS NULL THEN
    RAISE NOTICE '⚠️ TEST 3 SKIPPED: no eligible user';
    RETURN;
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (
    v_user, 'Legit', 'Edit', '+66999999999',
    'SCB', '0123456789', 'Legit',
    'draft'
  )
  RETURNING id INTO v_app_id;

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  UPDATE public.partner_applications SET bank_name = 'Kasikorn' WHERE id = v_app_id;

  SELECT bank_name INTO v_new_bank FROM public.partner_applications WHERE id = v_app_id;
  IF v_new_bank = 'Kasikorn' THEN
    RAISE NOTICE '✅ TEST 3 PASS: legitimate bank_name edit on draft was allowed';
  ELSE
    RAISE NOTICE '❌ TEST 3 FAIL: legit edit was blocked (bank_name still %)', v_new_bank;
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 4: User tries to UPDATE reviewed_by on their own row → REJECT
--         (column-level REVOKE catches this even with a future broken policy)
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_user UUID;
  v_app_id UUID;
BEGIN
  SELECT user_id INTO v_user
  FROM public.user_credits
  WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
  ORDER BY user_id LIMIT 1;

  IF v_user IS NULL THEN
    RAISE NOTICE '⚠️ TEST 4 SKIPPED: no eligible user';
    RETURN;
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (
    v_user, 'Bypass', 'Reviewed', '+66999999999',
    'SCB', '0123456789', 'Bypass',
    'draft'
  )
  RETURNING id INTO v_app_id;

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  BEGIN
    UPDATE public.partner_applications SET reviewed_by = v_user WHERE id = v_app_id;
    IF (SELECT reviewed_by FROM public.partner_applications WHERE id = v_app_id) = v_user THEN
      RAISE NOTICE '❌ TEST 4 FAIL: UPDATE of reviewed_by was applied';
    ELSE
      RAISE NOTICE '✅ TEST 4 PASS: UPDATE of reviewed_by blocked (REVOKE column-level)';
    END IF;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    RAISE NOTICE '✅ TEST 4 PASS: UPDATE of reviewed_by rejected with %', SQLSTATE;
  END;
END $$;
ROLLBACK;
