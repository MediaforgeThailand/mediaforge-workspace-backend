-- Tests for grant_sales_upgrade_code RPC (atomic upgrade grant).
-- Migration 20260519053627_grant_sales_upgrade_code_rpc.sql.

\set ON_ERROR_STOP on

-- ─────────────────────────────────────────────────────────────
-- TEST 1: Happy path — partner active, threshold met, no upgrade code yet.
--         RPC inserts code + audit row atomically; returns the new code id.
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_app_id UUID;
  v_existing_code_id UUID;
  v_returned_id UUID;
  v_code_count INT;
  v_audit_count INT;
  v_new_code_row RECORD;
BEGIN
  SELECT user_id INTO v_partner
  FROM public.user_credits
  WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
    AND user_id NOT IN (SELECT user_id FROM public.referral_codes)
    AND user_id NOT IN (SELECT user_id FROM public.partners)
  ORDER BY user_id LIMIT 1;

  IF v_partner IS NULL THEN
    RAISE EXCEPTION 'TEST 1 SETUP FAILED';
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'Grant', 'Happy', '+66999999999', 'SCB', '0123456789', 'Grant', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-GRANT-HAPPY', 'partner_affiliate', true, 0)
  RETURNING id INTO v_existing_code_id;

  v_returned_id := public.grant_sales_upgrade_code(v_partner, 'grant.happy@example.com', 120000);

  IF v_returned_id IS NULL THEN
    RAISE EXCEPTION 'TEST 1 FAIL: grant returned NULL';
  END IF;

  SELECT * INTO v_new_code_row FROM public.referral_codes WHERE id = v_returned_id;
  IF v_new_code_row.code <> 'MF-GRANT-HAPPY-20' THEN
    RAISE EXCEPTION 'TEST 1 FAIL: expected MF-GRANT-HAPPY-20, got %', v_new_code_row.code;
  END IF;
  IF v_new_code_row.discount_percent <> 20 THEN
    RAISE EXCEPTION 'TEST 1 FAIL: expected discount 20, got %', v_new_code_row.discount_percent;
  END IF;

  SELECT count(*) INTO v_code_count FROM public.referral_codes
    WHERE user_id = v_partner AND code_type = 'partner_affiliate';
  SELECT count(*) INTO v_audit_count FROM public.affiliate_audit_log
    WHERE action = 'workspace_affiliate_upgrade_code_granted'
      AND entity_id = v_returned_id::text;

  IF v_code_count = 2 AND v_audit_count = 1 THEN
    RAISE NOTICE '✅ TEST 1 PASS: atomic grant inserted code + audit, both committed';
  ELSE
    RAISE EXCEPTION 'TEST 1 FAIL: code_count=%/2, audit_count=%/1', v_code_count, v_audit_count;
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 2: Idempotency — calling twice returns NULL on the second call,
--         and only one new code + one audit row exists.
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_app_id UUID;
  v_first UUID;
  v_second UUID;
  v_code_count INT;
  v_audit_count INT;
BEGIN
  SELECT user_id INTO v_partner
  FROM public.user_credits
  WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
    AND user_id NOT IN (SELECT user_id FROM public.referral_codes)
    AND user_id NOT IN (SELECT user_id FROM public.partners)
  ORDER BY user_id LIMIT 1;

  IF v_partner IS NULL THEN
    RAISE EXCEPTION 'TEST 2 SETUP FAILED';
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'Grant', 'Idem', '+66999999999', 'SCB', '0123456789', 'Grant', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-GRANT-IDEM', 'partner_affiliate', true, 0);

  v_first := public.grant_sales_upgrade_code(v_partner, 'grant.idem@example.com', 120000);
  v_second := public.grant_sales_upgrade_code(v_partner, 'grant.idem@example.com', 120000);

  IF v_first IS NULL THEN
    RAISE EXCEPTION 'TEST 2 FAIL: first call returned NULL';
  END IF;
  IF v_second IS NOT NULL THEN
    RAISE EXCEPTION 'TEST 2 FAIL: second call returned %, expected NULL', v_second;
  END IF;

  SELECT count(*) INTO v_code_count FROM public.referral_codes
    WHERE user_id = v_partner AND code_type = 'partner_affiliate' AND discount_percent >= 20;
  SELECT count(*) INTO v_audit_count FROM public.affiliate_audit_log
    WHERE action = 'workspace_affiliate_upgrade_code_granted'
      AND (diff->>'partner_user_id')::uuid = v_partner;

  IF v_code_count = 1 AND v_audit_count = 1 THEN
    RAISE NOTICE '✅ TEST 2 PASS: second call no-op, only one discount code + one audit row';
  ELSE
    RAISE EXCEPTION 'TEST 2 FAIL: discount_codes=%/1, audits=%/1', v_code_count, v_audit_count;
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 3: Suspended partner — gate refuses the grant, returns NULL,
--         no code or audit inserted.
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_app_id UUID;
  v_returned UUID;
  v_code_count INT;
BEGIN
  SELECT user_id INTO v_partner
  FROM public.user_credits
  WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
    AND user_id NOT IN (SELECT user_id FROM public.referral_codes)
    AND user_id NOT IN (SELECT user_id FROM public.partners)
  ORDER BY user_id LIMIT 1;

  IF v_partner IS NULL THEN
    RAISE EXCEPTION 'TEST 3 SETUP FAILED';
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'Suspend', 'Test', '+66999999999', 'SCB', '0123456789', 'Suspend', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at, suspended_at)
    VALUES (v_partner, v_app_id, 0.3, now(), now());

  v_returned := public.grant_sales_upgrade_code(v_partner, 'sus@example.com', 120000);

  IF v_returned IS NOT NULL THEN
    RAISE EXCEPTION 'TEST 3 FAIL: suspended partner got id %', v_returned;
  END IF;

  SELECT count(*) INTO v_code_count FROM public.referral_codes WHERE user_id = v_partner;
  IF v_code_count <> 0 THEN
    RAISE EXCEPTION 'TEST 3 FAIL: suspended partner got % codes (expected 0)', v_code_count;
  END IF;

  RAISE NOTICE '✅ TEST 3 PASS: suspended partner cannot upgrade';
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 4: Under threshold — RPC returns NULL, no insert.
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_app_id UUID;
  v_returned UUID;
BEGIN
  SELECT user_id INTO v_partner
  FROM public.user_credits
  WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
    AND user_id NOT IN (SELECT user_id FROM public.referral_codes)
    AND user_id NOT IN (SELECT user_id FROM public.partners)
  ORDER BY user_id LIMIT 1;

  IF v_partner IS NULL THEN
    RAISE EXCEPTION 'TEST 4 SETUP FAILED';
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'Under', 'Threshold', '+66999999999', 'SCB', '0123456789', 'U', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());

  v_returned := public.grant_sales_upgrade_code(v_partner, 'u@example.com', 50000);
  IF v_returned IS NOT NULL THEN
    RAISE EXCEPTION 'TEST 4 FAIL: under-threshold got id %', v_returned;
  END IF;

  RAISE NOTICE '✅ TEST 4 PASS: under-threshold returns NULL';
END $$;
ROLLBACK;
