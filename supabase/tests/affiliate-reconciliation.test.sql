-- Tests for the affiliate_reconcile() cron from
-- 20260519043838_affiliate_reconciliation_cron.sql.
--
-- Verifies:
--   1. No drift → no audit_log rows written, returns 0
--   2. Drift A (lifetime_paid_thb out of sync) → detected, audit row written
--   3. Drift B (paid_commissions ≠ paid_payouts) → detected
--   4. Drift C (lifetime_commission_thb out of sync) → detected
--   5. Cron job is scheduled
--
-- All assertions fail-loud via RAISE EXCEPTION.

\set ON_ERROR_STOP on

-- ─────────────────────────────────────────────────────────────
-- TEST 1: No drift — clean partner returns 0, no audit row
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_drift_before INT;
  v_drift_after INT;
  v_count INT;
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
  ) VALUES (v_partner, 'Clean', 'Reconcile', '+66999999999', 'SCB', '0123456789', 'Clean', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at, lifetime_paid_thb, lifetime_commission_thb)
    VALUES (v_partner, v_app_id, 0.3, now(), 0, 0);

  SELECT count(*) INTO v_drift_before FROM public.affiliate_audit_log
    WHERE action = 'reconciliation_drift' AND entity_id = v_partner::text;

  v_count := public.affiliate_reconcile();

  SELECT count(*) INTO v_drift_after FROM public.affiliate_audit_log
    WHERE action = 'reconciliation_drift' AND entity_id = v_partner::text;

  IF v_drift_after = v_drift_before THEN
    RAISE NOTICE '✅ TEST 1 PASS: clean partner produced no drift rows';
  ELSE
    RAISE EXCEPTION 'TEST 1 FAIL: clean partner produced % drift rows', v_drift_after - v_drift_before;
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 2: Drift A — lifetime_paid_thb stored = 300 but no paid payouts
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_app_id UUID;
  v_drift jsonb;
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
  ) VALUES (v_partner, 'Drift', 'A', '+66999999999', 'SCB', '0123456789', 'Drift', 'approved')
  RETURNING id INTO v_app_id;
  -- Intentional drift: stored 300 but no actual paid payout
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at, lifetime_paid_thb, lifetime_commission_thb)
    VALUES (v_partner, v_app_id, 0.3, now(), 300, 0);

  PERFORM public.affiliate_reconcile();

  SELECT diff INTO v_drift FROM public.affiliate_audit_log
    WHERE action = 'reconciliation_drift'
      AND entity_id = v_partner::text
      AND diff->>'invariant' = 'A_lifetime_paid_vs_paid_payouts'
    ORDER BY created_at DESC LIMIT 1;

  IF v_drift IS NOT NULL
     AND (v_drift->>'actual')::numeric = 300
     AND (v_drift->>'expected')::numeric = 0
     AND (v_drift->>'delta')::numeric = 300 THEN
    RAISE NOTICE '✅ TEST 2 PASS: drift A detected with correct payload';
  ELSE
    RAISE EXCEPTION 'TEST 2 FAIL: drift row = %', v_drift;
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 3: Drift B — paid commissions (600) != paid payouts (300)
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
  v_drift jsonb;
BEGIN
  SELECT user_id INTO v_partner
  FROM public.user_credits
  WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
    AND user_id NOT IN (SELECT user_id FROM public.referral_codes)
    AND user_id NOT IN (SELECT user_id FROM public.partners)
  ORDER BY user_id LIMIT 1;

  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner ORDER BY user_id LIMIT 1;

  IF v_partner IS NULL OR v_referred IS NULL THEN
    RAISE EXCEPTION 'TEST 3 SETUP FAILED';
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'Drift', 'B', '+66999999999', 'SCB', '0123456789', 'Drift', 'approved')
  RETURNING id INTO v_app_id;
  -- Make A invariant clean: lifetime_paid = 300 = sum of paid payouts (300)
  -- But B will be wrong: paid commissions (600) ≠ paid payouts (300)
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at, lifetime_paid_thb, lifetime_commission_thb)
    VALUES (v_partner, v_app_id, 0.3, now(), 300, 600);
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-DRIFT-B', 'partner_affiliate', true, 0) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed') RETURNING id INTO v_referral_id;

  -- Two paid commission_events totalling 600
  INSERT INTO public.commission_events (
    partner_user_id, referred_user_id, referral_id,
    stripe_invoice_id, gross_amount_thb, net_amount_thb,
    commission_rate, commission_amount_thb, billing_cycle,
    cycle_index, status, hold_until, available_at, paid_at
  )
  SELECT v_partner, v_referred, v_referral_id,
         'in_drift_b_' || gs::text, 1000, 1000,
         0.3, 300, 'month', gs, 'paid',
         now() - interval '40 days', now() - interval '10 days', now() - interval '1 day'
  FROM generate_series(1, 2) gs;

  -- One paid payout for 300 (so A passes: 300 = 300; but B fails: 600 != 300)
  INSERT INTO public.payout_requests (
    partner_user_id, amount_thb, bank_snapshot, status, commission_ids
  ) VALUES (v_partner, 300, '{}'::jsonb, 'paid', ARRAY[]::UUID[]);

  PERFORM public.affiliate_reconcile();

  SELECT diff INTO v_drift FROM public.affiliate_audit_log
    WHERE action = 'reconciliation_drift'
      AND entity_id = v_partner::text
      AND diff->>'invariant' = 'B_paid_commissions_vs_paid_payouts'
    ORDER BY created_at DESC LIMIT 1;

  IF v_drift IS NOT NULL
     AND (v_drift->>'actual')::numeric = 600
     AND (v_drift->>'expected')::numeric = 300
     AND (v_drift->>'delta')::numeric = 300 THEN
    RAISE NOTICE '✅ TEST 3 PASS: drift B detected with correct payload';
  ELSE
    RAISE EXCEPTION 'TEST 3 FAIL: drift row = %', v_drift;
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 4: Drift C — lifetime_commission_thb stored = 1000 but
--                   active commissions sum to 300
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
  v_drift jsonb;
BEGIN
  SELECT user_id INTO v_partner
  FROM public.user_credits
  WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
    AND user_id NOT IN (SELECT user_id FROM public.referral_codes)
    AND user_id NOT IN (SELECT user_id FROM public.partners)
  ORDER BY user_id LIMIT 1;

  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner ORDER BY user_id LIMIT 1;

  IF v_partner IS NULL OR v_referred IS NULL THEN
    RAISE EXCEPTION 'TEST 4 SETUP FAILED';
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'Drift', 'C', '+66999999999', 'SCB', '0123456789', 'Drift', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at, lifetime_paid_thb, lifetime_commission_thb)
    VALUES (v_partner, v_app_id, 0.3, now(), 0, 1000);
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-DRIFT-C', 'partner_affiliate', true, 0) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed') RETURNING id INTO v_referral_id;

  INSERT INTO public.commission_events (
    partner_user_id, referred_user_id, referral_id,
    stripe_invoice_id, gross_amount_thb, net_amount_thb,
    commission_rate, commission_amount_thb, billing_cycle,
    cycle_index, status, hold_until
  ) VALUES (
    v_partner, v_referred, v_referral_id,
    'in_drift_c', 1000, 1000, 0.3, 300, 'month', 1, 'holding',
    now() + interval '30 days'
  );

  PERFORM public.affiliate_reconcile();

  SELECT diff INTO v_drift FROM public.affiliate_audit_log
    WHERE action = 'reconciliation_drift'
      AND entity_id = v_partner::text
      AND diff->>'invariant' = 'C_lifetime_commission_vs_active_commissions'
    ORDER BY created_at DESC LIMIT 1;

  IF v_drift IS NOT NULL
     AND (v_drift->>'actual')::numeric = 1000
     AND (v_drift->>'expected')::numeric = 300
     AND (v_drift->>'delta')::numeric = 700 THEN
    RAISE NOTICE '✅ TEST 4 PASS: drift C detected with correct payload';
  ELSE
    RAISE EXCEPTION 'TEST 4 FAIL: drift row = %', v_drift;
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 5: Cron is scheduled
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job
    WHERE jobname = 'affiliate-reconcile-daily'
  ) THEN
    RAISE NOTICE '✅ TEST 5 PASS: affiliate-reconcile-daily cron is scheduled';
  ELSE
    RAISE EXCEPTION 'TEST 5 FAIL: affiliate-reconcile-daily cron is missing';
  END IF;
END $$;
ROLLBACK;
