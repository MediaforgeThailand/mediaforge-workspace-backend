-- Tests for mark_payout_paid_v2 atomicity + payout_id backlink
-- (migration 20260519032918_mark_payout_paid_v2_atomic.sql).
--
-- Verifies:
--   1. Happy path: all commissions in 'available' → all flip to 'paid' with
--      payout_id backlink, payout_request also flips to 'paid'.
--   2. Mismatch path: one commission already 'clawback' → RAISE EXCEPTION,
--      payout_request stays 'approved', no commissions get flipped.
--   3. payout_id backlink populated (regression check vs v1 parity).
--
-- Each test wraps in a transaction and ROLLBACKs.

\set ON_ERROR_STOP on

-- ─────────────────────────────────────────────────────────────
-- TEST 1: Happy path — 3 available commissions → all paid + backlinked
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
  v_event_ids UUID[];
  v_payout_id UUID;
  v_paid_count INT;
  v_payout_status TEXT;
  v_backlink_count INT;
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
    RAISE NOTICE '⚠️ TEST 1 SKIPPED';
    RETURN;
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'Happy', 'Path', '+66999999999', 'SCB', '0123456789', 'Happy', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-HAPPY', 'partner_affiliate', true, 0) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed') RETURNING id INTO v_referral_id;

  WITH ins AS (
    INSERT INTO public.commission_events (
      partner_user_id, referred_user_id, referral_id,
      stripe_invoice_id, gross_amount_thb, net_amount_thb,
      commission_rate, commission_amount_thb, billing_cycle,
      cycle_index, status, hold_until, available_at
    )
    SELECT v_partner, v_referred, v_referral_id,
           'in_happy_' || gs::text, 1000, 1000,
           0.3, 300, 'month', gs, 'available',
           now() - interval '40 days', now() - interval '10 days'
    FROM generate_series(1, 3) gs
    RETURNING id
  )
  SELECT array_agg(id) INTO v_event_ids FROM ins;

  INSERT INTO public.payout_requests (
    partner_user_id, amount_thb, bank_snapshot, status, commission_ids, approved_at
  ) VALUES (
    v_partner, 900, '{}'::jsonb, 'approved', v_event_ids, now()
  ) RETURNING id INTO v_payout_id;

  PERFORM public.mark_payout_paid_v2(v_payout_id, NULL, 'BANK-REF-001', now());

  SELECT count(*) INTO v_paid_count
  FROM public.commission_events
  WHERE id = ANY(v_event_ids) AND status = 'paid';

  SELECT count(*) INTO v_backlink_count
  FROM public.commission_events
  WHERE id = ANY(v_event_ids) AND payout_id = v_payout_id;

  SELECT status INTO v_payout_status FROM public.payout_requests WHERE id = v_payout_id;

  IF v_paid_count = 3 AND v_backlink_count = 3 AND v_payout_status = 'paid' THEN
    RAISE NOTICE '✅ TEST 1 PASS: 3 commissions paid, all backlinked, payout flipped';
  ELSE
    RAISE NOTICE '❌ TEST 1 FAIL: paid=%/3, backlink=%/3, payout=%', v_paid_count, v_backlink_count, v_payout_status;
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 2: Mismatch — one commission is 'clawback' (refunded) → REJECT
--         AND no side effects (no commission flipped, no payout flipped)
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
  v_event_ids UUID[];
  v_clawback_event_id UUID;
  v_payout_id UUID;
  v_payout_status TEXT;
  v_unchanged_count INT;
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
  ) VALUES (v_partner, 'Mismatch', 'Test', '+66999999999', 'SCB', '0123456789', 'Mismatch', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-MISMATCH', 'partner_affiliate', true, 0) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed') RETURNING id INTO v_referral_id;

  -- 2 available + 1 clawback (refund hit one of the commissions while it was available)
  WITH ins AS (
    INSERT INTO public.commission_events (
      partner_user_id, referred_user_id, referral_id,
      stripe_invoice_id, gross_amount_thb, net_amount_thb,
      commission_rate, commission_amount_thb, billing_cycle,
      cycle_index, status, hold_until, available_at
    )
    SELECT v_partner, v_referred, v_referral_id,
           'in_mismatch_' || gs::text, 1000, 1000,
           0.3, 300, 'month', gs, 'available',
           now() - interval '40 days', now() - interval '10 days'
    FROM generate_series(1, 3) gs
    RETURNING id
  )
  SELECT array_agg(id) INTO v_event_ids FROM ins;

  -- Refund clawed one back AFTER the payout was approved but BEFORE marking paid
  v_clawback_event_id := v_event_ids[1];
  UPDATE public.commission_events SET status = 'clawback' WHERE id = v_clawback_event_id;

  INSERT INTO public.payout_requests (
    partner_user_id, amount_thb, bank_snapshot, status, commission_ids, approved_at
  ) VALUES (
    v_partner, 900, '{}'::jsonb, 'approved', v_event_ids, now()
  ) RETURNING id INTO v_payout_id;

  BEGIN
    PERFORM public.mark_payout_paid_v2(v_payout_id, NULL::uuid, 'BANK-REF-002', now());
    RAISE NOTICE '❌ TEST 2 FAIL: mark_payout_paid_v2 accepted a mismatched payout';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'commission_state_mismatch%' THEN
      -- Verify no side effects: payout still approved, no commission moved
      SELECT status INTO v_payout_status FROM public.payout_requests WHERE id = v_payout_id;
      SELECT count(*) INTO v_unchanged_count
      FROM public.commission_events
      WHERE id = ANY(v_event_ids) AND status NOT IN ('available','clawback');

      IF v_payout_status = 'approved' AND v_unchanged_count = 0 THEN
        RAISE NOTICE '✅ TEST 2 PASS: mismatch rejected, no side effects';
      ELSE
        RAISE NOTICE '❌ TEST 2 FAIL: side effects leaked — payout=%, moved=%', v_payout_status, v_unchanged_count;
      END IF;
    ELSE
      RAISE NOTICE '❌ TEST 2 FAIL: wrong exception "%"', SQLERRM;
    END IF;
  END;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 3: Cannot pay a payout that isn't 'approved' — regression check
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
  v_payout_id UUID;
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
  ) VALUES (v_partner, 'Pending', 'Test', '+66999999999', 'SCB', '0123456789', 'Pending', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());

  INSERT INTO public.payout_requests (
    partner_user_id, amount_thb, bank_snapshot, status, commission_ids
  ) VALUES (
    v_partner, 500, '{}'::jsonb, 'pending', ARRAY[]::UUID[]
  ) RETURNING id INTO v_payout_id;

  BEGIN
    PERFORM public.mark_payout_paid_v2(v_payout_id, NULL::uuid, 'BANK-REF-003', now());
    RAISE NOTICE '❌ TEST 3 FAIL: marked a pending payout as paid';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'payout_not_approved' THEN
      RAISE NOTICE '✅ TEST 3 PASS: pending payout cannot be marked paid';
    ELSE
      RAISE NOTICE '❌ TEST 3 FAIL: wrong exception "%"', SQLERRM;
    END IF;
  END;
END $$;
ROLLBACK;
