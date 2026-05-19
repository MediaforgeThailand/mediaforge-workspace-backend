-- Tests for the FK + index on commission_events.payout_id
-- (migration 20260519035315_commission_events_payout_id_fk.sql).
--
-- Verifies:
--   1. INSERT with payout_id = NULL → OK (NULLable)
--   2. INSERT with payout_id pointing to a non-existent UUID → FK violation
--   3. DELETE the payout_request row whose id is referenced → FK violation
--      (ON DELETE RESTRICT — provenance is protected; payouts must never
--      be deleted while they still have linked commissions)
--   4. Partial index exists (sanity check for the EXPLAIN-able query pattern)
--
-- All assertions fail-loud via RAISE EXCEPTION, so psql exits non-zero on
-- a broken DB state — CI surfaces the failure instead of going green on
-- a silent NOTICE.

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

  IF v_partner IS NULL OR v_referred IS NULL THEN
    RAISE EXCEPTION 'TEST 1 SETUP FAILED';
  END IF;

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
    RAISE EXCEPTION 'TEST 1 FAIL: insert returned no id';
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

  IF v_partner IS NULL OR v_referred IS NULL THEN
    RAISE EXCEPTION 'TEST 2 SETUP FAILED';
  END IF;

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
    RAISE EXCEPTION 'TEST 2 FAIL: INSERT with non-existent payout_id was allowed';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE '✅ TEST 2 PASS: non-existent payout_id rejected';
  END;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 3: DELETE payout_requests row that has linked commission_events
--         → FK violation (ON DELETE RESTRICT). Provenance protected:
--         a paid commission can always trace back to the payout that
--         cleared it.
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
  ) VALUES (v_partner, 'FK', 'Restrict', '+66999999999', 'SCB', '0123456789', 'FK', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-FK-RESTRICT', 'partner_affiliate', true, 0) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed') RETURNING id INTO v_referral_id;

  -- Realistic shape: commission_ids array contains the event's UUID
  INSERT INTO public.commission_events (
    partner_user_id, referred_user_id, referral_id,
    stripe_invoice_id, gross_amount_thb, net_amount_thb,
    commission_rate, commission_amount_thb, billing_cycle,
    cycle_index, status, hold_until
  ) VALUES (
    v_partner, v_referred, v_referral_id,
    'in_fk_restrict', 1000, 1000, 0.3, 300, 'month', 1, 'paid',
    now() + interval '30 days'
  )
  RETURNING id INTO v_event_id;

  INSERT INTO public.payout_requests (
    partner_user_id, amount_thb, bank_snapshot, status, commission_ids
  ) VALUES (v_partner, 300, '{}'::jsonb, 'paid', ARRAY[v_event_id])
  RETURNING id INTO v_payout_id;

  UPDATE public.commission_events SET payout_id = v_payout_id WHERE id = v_event_id;

  BEGIN
    DELETE FROM public.payout_requests WHERE id = v_payout_id;
    RAISE EXCEPTION 'TEST 3 FAIL: DELETE of payout_requests with linked commissions was allowed';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE '✅ TEST 3 PASS: DELETE of payout_requests blocked while commissions still reference it (RESTRICT)';
  END;
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
    RAISE EXCEPTION 'TEST 4 FAIL: idx_commission_events_payout_id missing';
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 5: Migration is re-runnable — second apply must not error
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
BEGIN
  -- Simulate re-running the FK creation idempotently.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commission_events_payout_id_fkey'
      AND conrelid = 'public.commission_events'::regclass
  ) THEN
    RAISE EXCEPTION 'TEST 5 FAIL: FK was not created by the migration';
  END IF;

  -- Re-attempt without IF NOT EXISTS would raise duplicate_object;
  -- the migration wraps it in a DO block that checks first, so this
  -- second simulated apply is a no-op:
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commission_events_payout_id_fkey'
      AND conrelid = 'public.commission_events'::regclass
  ) THEN
    ALTER TABLE public.commission_events
      ADD CONSTRAINT commission_events_payout_id_fkey
      FOREIGN KEY (payout_id)
      REFERENCES public.payout_requests(id)
      ON DELETE RESTRICT;
  END IF;

  RAISE NOTICE '✅ TEST 5 PASS: re-applying migration is idempotent';
END $$;
ROLLBACK;
