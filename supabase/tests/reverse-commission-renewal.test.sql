-- Tests for the renewal-clawback fix in reverse_commission
-- (migration 20260518163235_reverse_commission_renewal_lookup.sql).
--
-- The original function only matched commission_events by
-- stripe_payment_intent_id. Renewal accruals from invoice.paid stored
-- stripe_invoice_id only, so refund webhooks (which carry the PI) found
-- nothing and silently no-oped. We resolve the invoice id from
-- payment_transactions and OR-match.
--
-- Each test wraps in a transaction and ROLLBACKs.

\set ON_ERROR_STOP on

-- ─────────────────────────────────────────────────────────────
-- TEST 1: A renewal commission (only stripe_invoice_id populated)
--         IS reversed when its PI's refund arrives.
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
  v_status TEXT;
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
    RAISE NOTICE '⚠️ TEST 1 SKIPPED: not enough eligible users';
    RETURN;
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'Renew', 'Test', '+66999999999', 'SCB', '0123456789', 'Renew', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-RENEW', 'partner_affiliate', true, 0) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed') RETURNING id INTO v_referral_id;

  -- Renewal commission: only invoice id populated, PI is NULL
  INSERT INTO public.commission_events (
    partner_user_id, referred_user_id, referral_id,
    stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate,
    commission_amount_thb, billing_cycle, cycle_index,
    status, hold_until
  ) VALUES (
    v_partner, v_referred, v_referral_id,
    'in_renew_test', NULL,
    1000, 1000, 0.3, 300, 'month', 2,
    'holding', now() + interval '30 days'
  ) RETURNING id INTO v_event_id;

  -- Payment_transactions row links PI <-> invoice
  INSERT INTO public.payment_transactions (
    user_id, amount_thb, status, stripe_payment_intent_id, stripe_invoice_id
  ) VALUES (v_referred, 1000, 'completed', 'pi_renew_test', 'in_renew_test');

  -- Refund webhook would call this:
  PERFORM public.reverse_commission('pi_renew_test', 're_renew_test', 'requested_by_customer');

  SELECT status INTO v_status FROM public.commission_events WHERE id = v_event_id;
  IF v_status = 'clawback' THEN
    RAISE NOTICE '✅ TEST 1 PASS: renewal commission clawed back via PI→invoice lookup';
  ELSE
    RAISE NOTICE '❌ TEST 1 FAIL: renewal commission status=% (expected clawback)', v_status;
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 2: First-cycle commission (only stripe_payment_intent_id) — still works
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
  v_status TEXT;
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
    RAISE NOTICE '⚠️ TEST 2 SKIPPED';
    RETURN;
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'First', 'Test', '+66999999999', 'SCB', '0123456789', 'First', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-FIRST', 'partner_affiliate', true, 0) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed') RETURNING id INTO v_referral_id;

  -- First-cycle PI accrual: only PI populated
  INSERT INTO public.commission_events (
    partner_user_id, referred_user_id, referral_id,
    stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate,
    commission_amount_thb, billing_cycle, cycle_index,
    status, hold_until
  ) VALUES (
    v_partner, v_referred, v_referral_id,
    NULL, 'pi_first_test',
    1000, 1000, 0.3, 300, 'month', 1,
    'holding', now() + interval '30 days'
  ) RETURNING id INTO v_event_id;

  PERFORM public.reverse_commission('pi_first_test', 're_first_test', 'requested_by_customer');

  SELECT status INTO v_status FROM public.commission_events WHERE id = v_event_id;
  IF v_status = 'clawback' THEN
    RAISE NOTICE '✅ TEST 2 PASS: first-cycle PI-only commission still clawed back (regression check)';
  ELSE
    RAISE NOTICE '❌ TEST 2 FAIL: first-cycle commission status=% (expected clawback)', v_status;
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 3: Idempotency — second call with same refund_id is a no-op
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
  v_count BIGINT;
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
    RAISE NOTICE '⚠️ TEST 3 SKIPPED';
    RETURN;
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'Idem', 'Test', '+66999999999', 'SCB', '0123456789', 'Idem', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-IDEM', 'partner_affiliate', true, 0) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed') RETURNING id INTO v_referral_id;

  INSERT INTO public.commission_events (
    partner_user_id, referred_user_id, referral_id,
    stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate,
    commission_amount_thb, billing_cycle, cycle_index,
    status, hold_until
  ) VALUES (
    v_partner, v_referred, v_referral_id,
    'in_idem_test', NULL,
    1000, 1000, 0.3, 300, 'month', 2,
    'holding', now() + interval '30 days'
  ) RETURNING id INTO v_event_id;

  INSERT INTO public.payment_transactions (
    user_id, amount_thb, status, stripe_payment_intent_id, stripe_invoice_id
  ) VALUES (v_referred, 1000, 'completed', 'pi_idem_test', 'in_idem_test');

  -- First call: clawback
  PERFORM public.reverse_commission('pi_idem_test', 're_idem_test');
  -- Second call: should no-op
  PERFORM public.reverse_commission('pi_idem_test', 're_idem_test');

  SELECT count(*) INTO v_count
  FROM public.cash_wallet_transactions
  WHERE reference_id = v_event_id::text;

  IF v_count <= 1 THEN
    RAISE NOTICE '✅ TEST 3 PASS: idempotent (wallet tx count = %)', v_count;
  ELSE
    RAISE NOTICE '❌ TEST 3 FAIL: idempotency broken (wallet tx count = %)', v_count;
  END IF;
END $$;
ROLLBACK;
