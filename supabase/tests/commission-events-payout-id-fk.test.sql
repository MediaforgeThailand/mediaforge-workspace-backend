-- Tests for the FK + index on commission_events.payout_id added in
-- 20260519035315_commission_events_payout_id_fk.sql.
--
-- Verifies:
--   1. INSERT with payout_id = NULL → OK (NULLable)
--   2. INSERT with payout_id pointing to a real payout_request → OK
--   3. INSERT with payout_id pointing to a non-existent UUID → FK violation
--   4. DELETE the payout_request row → linked commission_events.payout_id becomes NULL (ON DELETE SET NULL)
--   5. Index exists (sanity check for the EXPLAIN-able query pattern)

\set ON_ERROR_STOP on

-- ─────────────────────────────────────────────────────────────
-- TEST 1: NULL payout_id is allowed
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
BEGIN
  SELECT user_id INTO v_partner
  FROM public.user_credits
  WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
    AND user_id NOT IN (SELECT user_id FROM public.referral_codes)
    AND user_id NOT IN (SELECT user_id FROM public.partners)
  ORDER BY user_id LIMIT 1;

  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner ORDER BY user_id LIMIT 1;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'FK', 'Null', '+66999999999', 'SCB', '0123456789', 'FK', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-FK-NULL', 'partner_affiliate', true, 0) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed') RETURNING id INTO v_referral_id;

  INSERT INTO public.commission_events (
    partner_user_id, referred_user_id, referral_id,
    stripe_invoice_id, gross_amount_thb, net_amount_thb,
    commission_rate, commission_amount_thb, billing_cycle,
    cycle_index, status, hold_until, payout_id
  ) VALUES (
    v_partner, v_referred, v_referral_id,
    'in_fk_null', 1000, 1000, 0.3, 300, 'month', 1, 'holding',
    now() + interval '30 days', NULL
  )
  RETURNING id INTO v_event_id;

  IF v_event_id IS NOT NULL THEN
    RAISE NOTICE '✅ TEST 1 PASS: NULL payout_id allowed';
  ELSE
    RAISE NOTICE '❌ TEST 1 FAIL';
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 2: Non-existent payout_id → FK violation
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

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'FK', 'Orphan', '+66999999999', 'SCB', '0123456789', 'FK', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-FK-ORPHAN', 'partner_affiliate', true, 0) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed') RETURNING id INTO v_referral_id;

  BEGIN
    INSERT INTO public.commission_events (
      partner_user_id, referred_user_id, referral_id,
      stripe_invoice_id, gross_amount_thb, net_amount_thb,
      commission_rate, commission_amount_thb, billing_cycle,
      cycle_index, status, hold_until, payout_id
    ) VALUES (
      v_partner, v_referred, v_referral_id,
      'in_fk_orphan', 1000, 1000, 0.3, 300, 'month', 1, 'holding',
      now() + interval '30 days', '00000000-0000-0000-0000-000000000000'::uuid
    );
    RAISE NOTICE '❌ TEST 2 FAIL: INSERT with non-existent payout_id was allowed';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE '✅ TEST 2 PASS: non-existent payout_id rejected';
  END;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 3: DELETE the payout_request → linked commission_events.payout_id is NULLed
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
  v_payout_id UUID;
  v_payout_id_after UUID;
BEGIN
  SELECT user_id INTO v_partner
  FROM public.user_credits
  WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
    AND user_id NOT IN (SELECT user_id FROM public.referral_codes)
    AND user_id NOT IN (SELECT user_id FROM public.partners)
  ORDER BY user_id LIMIT 1;

  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner ORDER BY user_id LIMIT 1;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'FK', 'Cascade', '+66999999999', 'SCB', '0123456789', 'FK', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-FK-CASCADE', 'partner_affiliate', true, 0) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed') RETURNING id INTO v_referral_id;

  INSERT INTO public.payout_requests (
    partner_user_id, amount_thb, bank_snapshot, status, commission_ids
  ) VALUES (v_partner, 300, '{}'::jsonb, 'paid', ARRAY[]::UUID[])
  RETURNING id INTO v_payout_id;

  INSERT INTO public.commission_events (
    partner_user_id, referred_user_id, referral_id,
    stripe_invoice_id, gross_amount_thb, net_amount_thb,
    commission_rate, commission_amount_thb, billing_cycle,
    cycle_index, status, hold_until, payout_id
  ) VALUES (
    v_partner, v_referred, v_referral_id,
    'in_fk_cascade', 1000, 1000, 0.3, 300, 'month', 1, 'paid',
    now() + interval '30 days', v_payout_id
  )
  RETURNING id INTO v_event_id;

  DELETE FROM public.payout_requests WHERE id = v_payout_id;

  SELECT payout_id INTO v_payout_id_after FROM public.commission_events WHERE id = v_event_id;

  IF v_payout_id_after IS NULL THEN
    RAISE NOTICE '✅ TEST 3 PASS: payout_id NULLed on payout_requests DELETE (ON DELETE SET NULL)';
  ELSE
    RAISE NOTICE '❌ TEST 3 FAIL: payout_id is % (expected NULL)', v_payout_id_after;
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 4: Partial index exists (sanity)
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public'
      AND tablename='commission_events'
      AND indexname='idx_commission_events_payout_id'
  ) THEN
    RAISE NOTICE '✅ TEST 4 PASS: idx_commission_events_payout_id exists';
  ELSE
    RAISE NOTICE '❌ TEST 4 FAIL: idx_commission_events_payout_id missing';
  END IF;
END $$;
ROLLBACK;
