-- Tests for the 21-day hold window migration
-- (20260519130000_accrue_commission_21d_hold.sql).
--
-- Asserts that:
--   T1: New accrue_commission inserts produce hold_until ≈ now() + 21 days
--       (within 1-minute tolerance to allow for transaction wall-clock skew).
--   T2: The bulk-shift query lives in the migration itself; a fresh DB
--       won't have anything to shift, so we synthesise a fixture inside
--       this test that mimics a pre-migration row (hold_until = now + 30d)
--       and verify that running the same shift logic would land at 21d.
--
-- Tests use RAISE EXCEPTION on FAIL so `psql -f` exits non-zero in CI.
-- Each test wraps in a transaction and ROLLBACKs.

\set ON_ERROR_STOP on

-- ─────────────────────────────────────────────────────────────
-- TEST 1: accrue_commission inserts hold_until ≈ now() + 21 days
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_event_id UUID;
  v_hold_until TIMESTAMPTZ;
  v_expected TIMESTAMPTZ;
  v_drift_seconds NUMERIC;
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.referral_codes)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL OR v_referred IS NULL THEN
    RAISE NOTICE '⚠️ TEST 1 SKIPPED'; RETURN;
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'Hold', '21d', '+66900000010', 'SCB', '0000000010', 'Hold', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-HOLD-21', 'partner_affiliate', true, 0)
    RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed');

  v_event_id := public.accrue_commission(
    v_referred, 'pi_hold_21_test', 1000, 1000, 'month', 1
  );

  IF v_event_id IS NULL THEN
    RAISE EXCEPTION '❌ TEST 1 FAIL: accrue_commission returned NULL';
  END IF;

  SELECT hold_until INTO v_hold_until FROM public.commission_events WHERE id = v_event_id;
  v_expected := now() + interval '21 days';
  v_drift_seconds := abs(EXTRACT(EPOCH FROM (v_hold_until - v_expected)));

  IF v_drift_seconds > 60 THEN
    RAISE EXCEPTION '❌ TEST 1 FAIL: hold_until drift % seconds (expected <60). actual=%, expected=%',
      v_drift_seconds, v_hold_until, v_expected;
  END IF;

  RAISE NOTICE '✅ TEST 1 PASS: new accruals use 21-day hold (drift % sec)', v_drift_seconds;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 2: Bulk-shift logic correctness — synthesise a "legacy" 30-day
--          row, run the same UPDATE the migration uses, verify it lands
--          at 21 days from creation.
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
  v_created_at TIMESTAMPTZ;
  v_hold_after TIMESTAMPTZ;
  v_expected TIMESTAMPTZ;
  v_drift_seconds NUMERIC;
  v_audit_count INT;
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.referral_codes)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL OR v_referred IS NULL THEN
    RAISE NOTICE '⚠️ TEST 2 SKIPPED'; RETURN;
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'Shift', 'Test', '+66900000011', 'SCB', '0000000011', 'Shift', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-SHIFT-30', 'partner_affiliate', true, 0)
    RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed')
    RETURNING id INTO v_referral_id;

  -- "Legacy" pre-migration row with 30-day hold from a definite creation time
  v_created_at := now() - interval '2 days';
  INSERT INTO public.commission_events (
    partner_user_id, referred_user_id, referral_id,
    stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate,
    commission_amount_thb, billing_cycle, cycle_index,
    status, hold_until, created_at
  ) VALUES (
    v_partner, v_referred, v_referral_id, NULL, 'pi_shift_test',
    1000, 1000, 0.3, 300, 'month', 1,
    'holding', v_created_at + interval '30 days', v_created_at
  ) RETURNING id INTO v_event_id;

  -- Run the same shift logic from the migration (in isolation here so
  -- we don't depend on the migration having been applied)
  WITH shifted AS (
    UPDATE public.commission_events
       SET hold_until = hold_until - interval '9 days'
     WHERE id = v_event_id
       AND status = 'holding'
    RETURNING id, partner_user_id, commission_amount_thb, hold_until
  )
  INSERT INTO public.affiliate_audit_log (actor_id, action, entity_type, entity_id, diff)
  SELECT NULL, 'hold_window_retroactively_shifted', 'commission_event',
         id::text, jsonb_build_object('shift_days', 9, 'new_hold_until', hold_until)
  FROM shifted;

  SELECT hold_until INTO v_hold_after FROM public.commission_events WHERE id = v_event_id;
  v_expected := v_created_at + interval '21 days';
  v_drift_seconds := abs(EXTRACT(EPOCH FROM (v_hold_after - v_expected)));

  IF v_drift_seconds > 60 THEN
    RAISE EXCEPTION '❌ TEST 2 FAIL: shifted hold_until=%, expected=% (drift % sec)',
      v_hold_after, v_expected, v_drift_seconds;
  END IF;

  SELECT count(*) INTO v_audit_count FROM public.affiliate_audit_log
    WHERE action = 'hold_window_retroactively_shifted' AND entity_id = v_event_id::text;
  IF v_audit_count <> 1 THEN
    RAISE EXCEPTION '❌ TEST 2 FAIL: audit row missing (count=%)', v_audit_count;
  END IF;

  RAISE NOTICE '✅ TEST 2 PASS: bulk-shift logic lands at +21d from creation, with audit row';
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 3: Already-released ('available') rows are NOT shifted by the
--          migration's WHERE status='holding' guard.
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
  v_original_hold TIMESTAMPTZ;
  v_after_hold TIMESTAMPTZ;
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.referral_codes)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL OR v_referred IS NULL THEN
    RAISE NOTICE '⚠️ TEST 3 SKIPPED'; RETURN;
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'NoShift', 'Test', '+66900000012', 'SCB', '0000000012', 'NoShift', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-NOSHIFT', 'partner_affiliate', true, 0)
    RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed')
    RETURNING id INTO v_referral_id;

  v_original_hold := now() - interval '5 days';
  INSERT INTO public.commission_events (
    partner_user_id, referred_user_id, referral_id,
    stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate,
    commission_amount_thb, billing_cycle, cycle_index,
    status, hold_until, available_at
  ) VALUES (
    v_partner, v_referred, v_referral_id, NULL, 'pi_noshift_test',
    1000, 1000, 0.3, 300, 'month', 1,
    'available', v_original_hold, now() - interval '5 days'
  ) RETURNING id INTO v_event_id;

  UPDATE public.commission_events
     SET hold_until = hold_until - interval '9 days'
   WHERE status = 'holding';

  SELECT hold_until INTO v_after_hold FROM public.commission_events WHERE id = v_event_id;

  IF v_after_hold <> v_original_hold THEN
    RAISE EXCEPTION '❌ TEST 3 FAIL: available row was shifted (before=%, after=%)',
      v_original_hold, v_after_hold;
  END IF;

  RAISE NOTICE '✅ TEST 3 PASS: status=available rows untouched by bulk shift';
END $$;
ROLLBACK;
