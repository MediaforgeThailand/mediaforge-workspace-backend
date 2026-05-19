-- Tests for self-referral fraud_flag restoration + commission_rate CHECK.
-- (migration 20260519053321_accrue_commission_restore_fraud_flag.sql)

\set ON_ERROR_STOP on

-- ─────────────────────────────────────────────────────────────
-- TEST 1: self-referral attempt writes a fraud_flags row with kind='self_referral'
--         AND returns NULL (no commission_event created)
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
  v_event_id UUID;
  v_flag_count INT;
  v_event_count INT;
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
  ) VALUES (v_partner, 'Self', 'Referral', '+66999999999', 'SCB', '0123456789', 'Self', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-SELF-REF', 'partner_affiliate', true, 0) RETURNING id INTO v_code_id;

  -- Referral row where referrer == referred (self-referral)
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_partner, v_code_id, 'partner_affiliate', 'pending') RETURNING id INTO v_referral_id;

  v_event_id := public.accrue_commission(v_partner, 'pi_self_ref_test', 1000, 1000, 'month', 1);

  IF v_event_id IS NOT NULL THEN
    RAISE EXCEPTION 'TEST 1 FAIL: accrue_commission returned event id % for self-referral', v_event_id;
  END IF;

  SELECT count(*) INTO v_flag_count FROM public.fraud_flags
    WHERE kind = 'self_referral' AND partner_id = v_partner;
  SELECT count(*) INTO v_event_count FROM public.commission_events
    WHERE stripe_payment_intent_id = 'pi_self_ref_test';

  IF v_flag_count = 1 AND v_event_count = 0 THEN
    RAISE NOTICE '✅ TEST 1 PASS: self-referral logged to fraud_flags, no commission_event written';
  ELSE
    RAISE EXCEPTION 'TEST 1 FAIL: flag_count=%, event_count=%', v_flag_count, v_event_count;
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 2: partners.commission_rate > 1 is rejected by the new CHECK
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_app_id UUID;
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
  ) VALUES (v_partner, 'Rate', 'Check', '+66999999999', 'SCB', '0123456789', 'Rate', 'approved')
  RETURNING id INTO v_app_id;

  BEGIN
    INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
      VALUES (v_partner, v_app_id, 1.5, now());
    RAISE EXCEPTION 'TEST 2 FAIL: commission_rate=1.5 was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '✅ TEST 2 PASS: partners.commission_rate=1.5 rejected by CHECK';
  END;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 3: commission_events.commission_rate < 0 is rejected
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
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
  ) VALUES (v_partner, 'Neg', 'Rate', '+66999999999', 'SCB', '0123456789', 'Neg', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-NEG-RATE', 'partner_affiliate', true, 0) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed') RETURNING id INTO v_referral_id;

  BEGIN
    INSERT INTO public.commission_events (
      partner_user_id, referred_user_id, referral_id,
      stripe_invoice_id, gross_amount_thb, net_amount_thb,
      commission_rate, commission_amount_thb, billing_cycle,
      cycle_index, status, hold_until
    ) VALUES (
      v_partner, v_referred, v_referral_id,
      'in_neg_rate', 1000, 1000, -0.1, 100, 'month', 1, 'holding',
      now() + interval '30 days'
    );
    RAISE EXCEPTION 'TEST 3 FAIL: commission_rate=-0.1 was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '✅ TEST 3 PASS: commission_events.commission_rate=-0.1 rejected by CHECK';
  END;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 4: legit accrue_commission (referrer ≠ referred) still works
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
  v_event_id UUID;
  v_flag_count INT;
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
  ) VALUES (v_partner, 'Legit', 'Accrue', '+66999999999', 'SCB', '0123456789', 'Legit', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-LEGIT', 'partner_affiliate', true, 0) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'pending') RETURNING id INTO v_referral_id;

  v_event_id := public.accrue_commission(v_referred, 'pi_legit_accrue', 1000, 1000, 'month', 1);

  IF v_event_id IS NULL THEN
    RAISE EXCEPTION 'TEST 4 FAIL: legit accrual returned NULL';
  END IF;

  SELECT count(*) INTO v_flag_count FROM public.fraud_flags
    WHERE kind = 'self_referral' AND partner_id = v_partner;

  IF v_flag_count = 0 THEN
    RAISE NOTICE '✅ TEST 4 PASS: legit (referrer ≠ referred) accrues commission, no fraud flag';
  ELSE
    RAISE EXCEPTION 'TEST 4 FAIL: legit accrual created a self_referral flag (%)', v_flag_count;
  END IF;
END $$;
ROLLBACK;
