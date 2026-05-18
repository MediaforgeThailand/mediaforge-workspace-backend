-- Tests for the request_payout() bank-info guard added in
-- 20260518110000_request_payout_bank_guard.sql.
--
-- Run via: psql ... -f supabase/tests/request-payout-bank-guard.test.sql
--
-- Each test wraps in a transaction and ROLLBACKs to leave DB clean.
-- auth.uid() is faked per-test via `SET LOCAL request.jwt.claim.sub`.

\set ON_ERROR_STOP on

-- ─────────────────────────────────────────────────────────────
-- TEST 1: bank_account_no = 'Pending' → request_payout raises
--         bank_details_incomplete (the regression we're guarding)
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
    RAISE NOTICE '⚠️ TEST 1 SKIPPED: no user_credits row without an existing partner_applications row';
    RETURN;
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (
    v_user, 'Test', 'Pending', '+66999999999',
    'Pending', 'Pending', 'Test Pending',
    'approved'
  )
  RETURNING id INTO v_app_id;

  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at, suspended_at)
  VALUES (v_user, v_app_id, 0.3000, now(), NULL);

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);

  BEGIN
    PERFORM public.request_payout(500, '{}'::jsonb);
    RAISE NOTICE '❌ TEST 1 FAIL: request_payout accepted Pending bank info';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'bank_details_incomplete' THEN
      RAISE NOTICE '✅ TEST 1 PASS: Pending bank_account_no rejected';
    ELSE
      RAISE NOTICE '❌ TEST 1 FAIL: wrong exception "%"', SQLERRM;
    END IF;
  END;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 2: empty bank_name → bank_details_incomplete
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
    RAISE NOTICE '⚠️ TEST 2 SKIPPED: no user_credits row without an existing partner_applications row';
    RETURN;
  END IF;

  -- We cannot INSERT an empty bank_name directly because of NOT NULL +
  -- the application table schema; mimic the "Pending" placeholder by
  -- starting with valid values and then bypassing the trigger to set
  -- bank_name = '' via a direct UPDATE — same shape as legacy data.
  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (
    v_user, 'Test', 'Empty', '+66999999999',
    'Initial', '1234567890', 'Test Empty',
    'approved'
  )
  RETURNING id INTO v_app_id;

  UPDATE public.partner_applications SET bank_name = '   ' WHERE id = v_app_id;

  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at, suspended_at)
  VALUES (v_user, v_app_id, 0.3000, now(), NULL);

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);

  BEGIN
    PERFORM public.request_payout(500, '{}'::jsonb);
    RAISE NOTICE '❌ TEST 2 FAIL: request_payout accepted whitespace-only bank_name';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'bank_details_incomplete' THEN
      RAISE NOTICE '✅ TEST 2 PASS: whitespace bank_name rejected';
    ELSE
      RAISE NOTICE '❌ TEST 2 FAIL: wrong exception "%"', SQLERRM;
    END IF;
  END;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 3: Valid bank info → bank guard does NOT fire (regression
--         check: legit partners are not blocked). We expect to
--         fall through to insufficient_balance because we did not
--         seed any commission_events.
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
    RAISE NOTICE '⚠️ TEST 3 SKIPPED: no user_credits row without an existing partner_applications row';
    RETURN;
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (
    v_user, 'Test', 'Valid', '+66999999999',
    'SCB', '0123456789', 'Test Valid',
    'approved'
  )
  RETURNING id INTO v_app_id;

  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at, suspended_at)
  VALUES (v_user, v_app_id, 0.3000, now(), NULL);

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);

  BEGIN
    PERFORM public.request_payout(500, '{}'::jsonb);
    RAISE NOTICE '❌ TEST 3 FAIL: request_payout unexpectedly succeeded with no commission events';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'insufficient_balance%' THEN
      RAISE NOTICE '✅ TEST 3 PASS: valid bank info passed the guard (fell through to balance check)';
    ELSIF SQLERRM = 'bank_details_incomplete' THEN
      RAISE NOTICE '❌ TEST 3 FAIL: false positive — guard rejected valid bank info';
    ELSE
      RAISE NOTICE '❌ TEST 3 FAIL: unexpected exception "%"', SQLERRM;
    END IF;
  END;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 4: function signature smoke — request_payout(NUMERIC, JSONB)
--         exists in public schema
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'request_payout'
  ) THEN
    RAISE NOTICE '❌ TEST 4 FAIL: request_payout function not found in public schema';
  ELSE
    RAISE NOTICE '✅ TEST 4 PASS: request_payout registered in public schema';
  END IF;
END $$;
ROLLBACK;
