-- Tests for mark_payout_paid_v2 atomicity + payout_id backlink + new guards
-- (migration 20260519032918_mark_payout_paid_v2_atomic.sql).
--
-- All assertions fail-loud via RAISE EXCEPTION, so psql exits non-zero and
-- CI surfaces the failure. The legacy NOTICE-only pattern in the repo lets
-- failed assertions exit 0, which we now avoid.
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
  v_lifetime NUMERIC;
  v_wallet_balance NUMERIC;
  v_debit_count INT;
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
    RAISE EXCEPTION 'TEST 1 SETUP FAILED: not enough eligible users in user_credits';
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

  -- Pre-seed cash_wallets with the balance release_commission would have
  -- credited (3 events x 300). The mark_payout_paid_v2 RPC must debit
  -- this back to 0 + write a payout_debit ledger row.
  INSERT INTO public.cash_wallets (user_id, balance_thb, lifetime_earned)
    VALUES (v_partner, 900, 900);

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
  SELECT lifetime_paid_thb INTO v_lifetime FROM public.partners WHERE user_id = v_partner;
  SELECT balance_thb INTO v_wallet_balance FROM public.cash_wallets WHERE user_id = v_partner;
  SELECT count(*) INTO v_debit_count FROM public.cash_wallet_transactions
    WHERE user_id = v_partner AND tx_type = 'payout_debit' AND reference_id = v_payout_id::text;

  IF v_paid_count = 3 AND v_backlink_count = 3 AND v_payout_status = 'paid'
     AND v_lifetime = 900 AND v_wallet_balance = 0 AND v_debit_count = 1 THEN
    RAISE NOTICE '✅ TEST 1 PASS: 3 commissions paid, backlinked, payout flipped, lifetime=900, wallet=0, debit ledger=1';
  ELSE
    RAISE EXCEPTION 'TEST 1 FAIL: paid=%/3 backlink=%/3 payout=% lifetime=%/900 wallet=%/0 debits=%/1',
      v_paid_count, v_backlink_count, v_payout_status, v_lifetime, v_wallet_balance, v_debit_count;
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 2: Mismatch (one commission clawback) → exception + commissions
--         that briefly flipped to 'paid' are ROLLED BACK to 'available'.
--         Assert the specific final status of each commission so the
--         test catches a regression where rollback doesn't happen.
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
  v_payout_status TEXT;
  v_status_1 TEXT;
  v_status_2 TEXT;
  v_status_3 TEXT;
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
  ) VALUES (v_partner, 'Mismatch', 'Test', '+66999999999', 'SCB', '0123456789', 'Mismatch', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-MISMATCH', 'partner_affiliate', true, 0) RETURNING id INTO v_code_id;
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
           'in_mismatch_' || gs::text, 1000, 1000,
           0.3, 300, 'month', gs, 'available',
           now() - interval '40 days', now() - interval '10 days'
    FROM generate_series(1, 3) gs
    RETURNING id
  )
  SELECT array_agg(id) INTO v_event_ids FROM ins;

  -- Refund landed on commission #1 after the payout was approved.
  UPDATE public.commission_events SET status = 'clawback' WHERE id = v_event_ids[1];

  INSERT INTO public.payout_requests (
    partner_user_id, amount_thb, bank_snapshot, status, commission_ids, approved_at
  ) VALUES (
    v_partner, 900, '{}'::jsonb, 'approved', v_event_ids, now()
  ) RETURNING id INTO v_payout_id;

  BEGIN
    PERFORM public.mark_payout_paid_v2(v_payout_id, NULL::uuid, 'BANK-REF-002', now());
    RAISE EXCEPTION 'TEST 2 FAIL: mark_payout_paid_v2 accepted a mismatched payout';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'commission_state_mismatch%' THEN
      RAISE EXCEPTION 'TEST 2 FAIL: wrong exception "%"', SQLERRM;
    END IF;
  END;

  SELECT status INTO v_status_1 FROM public.commission_events WHERE id = v_event_ids[1];
  SELECT status INTO v_status_2 FROM public.commission_events WHERE id = v_event_ids[2];
  SELECT status INTO v_status_3 FROM public.commission_events WHERE id = v_event_ids[3];
  SELECT status INTO v_payout_status FROM public.payout_requests WHERE id = v_payout_id;

  IF v_status_1 = 'clawback'
     AND v_status_2 = 'available'
     AND v_status_3 = 'available'
     AND v_payout_status = 'approved' THEN
    RAISE NOTICE '✅ TEST 2 PASS: commissions rolled back to original states, payout stayed approved';
  ELSE
    RAISE EXCEPTION 'TEST 2 FAIL: c1=% c2=% c3=% payout=%',
      v_status_1, v_status_2, v_status_3, v_payout_status;
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 3: Cannot pay a pending (non-approved) payout
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_app_id UUID;
  v_payout_id UUID;
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
  ) VALUES (v_partner, 'Cancelled', 'Test', '+66999999999', 'SCB', '0123456789', 'Cancelled', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());

  -- The RPC accepts pending/approved/processing as payable states
  -- (the current ERP workflow flows pending → processing → paid without
  -- an intermediate 'approved' transition). Terminal states stay
  -- rejected. We exercise 'cancelled' here as the canonical terminal —
  -- the reverse_commission RPC sets payouts to 'cancelled' when a
  -- refund clawbacks their commissions, and a v2 RPC that ignored that
  -- guard would silently pay out refunded revenue.
  INSERT INTO public.payout_requests (
    partner_user_id, amount_thb, bank_snapshot, status, commission_ids
  ) VALUES (
    v_partner, 500, '{}'::jsonb, 'cancelled', ARRAY[]::UUID[]
  ) RETURNING id INTO v_payout_id;

  BEGIN
    PERFORM public.mark_payout_paid_v2(v_payout_id, NULL::uuid, 'BANK-REF-003', now());
    RAISE EXCEPTION 'TEST 3 FAIL: marked a cancelled payout as paid';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'payout_not_in_payable_state' THEN
      RAISE NOTICE '✅ TEST 3 PASS: cancelled payout cannot be marked paid';
    ELSE
      RAISE EXCEPTION 'TEST 3 FAIL: wrong exception "%"', SQLERRM;
    END IF;
  END;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 4: Empty commission_ids → payout_has_no_commissions
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_app_id UUID;
  v_payout_id UUID;
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
  ) VALUES (v_partner, 'Empty', 'Array', '+66999999999', 'SCB', '0123456789', 'Empty', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());

  INSERT INTO public.payout_requests (
    partner_user_id, amount_thb, bank_snapshot, status, commission_ids, approved_at
  ) VALUES (
    v_partner, 0, '{}'::jsonb, 'approved', ARRAY[]::UUID[], now()
  ) RETURNING id INTO v_payout_id;

  BEGIN
    PERFORM public.mark_payout_paid_v2(v_payout_id, NULL::uuid, 'BANK-REF-004', now());
    RAISE EXCEPTION 'TEST 4 FAIL: empty commission_ids was silently accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'payout_has_no_commissions' THEN
      RAISE NOTICE '✅ TEST 4 PASS: empty commission_ids rejected';
    ELSE
      RAISE EXCEPTION 'TEST 4 FAIL: wrong exception "%"', SQLERRM;
    END IF;
  END;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 5: p_paid_at far in the past (>30 days ago) is rejected
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
    RAISE EXCEPTION 'TEST 5 SETUP FAILED';
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'Backdate', 'Test', '+66999999999', 'SCB', '0123456789', 'Backdate', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-BACKDATE', 'partner_affiliate', true, 0) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed') RETURNING id INTO v_referral_id;

  WITH ins AS (
    INSERT INTO public.commission_events (
      partner_user_id, referred_user_id, referral_id,
      stripe_invoice_id, gross_amount_thb, net_amount_thb,
      commission_rate, commission_amount_thb, billing_cycle,
      cycle_index, status, hold_until, available_at
    )
    VALUES (v_partner, v_referred, v_referral_id,
            'in_backdate_1', 1000, 1000, 0.3, 300, 'month', 1, 'available',
            now() - interval '40 days', now() - interval '10 days')
    RETURNING id
  )
  SELECT array_agg(id) INTO v_event_ids FROM ins;

  INSERT INTO public.payout_requests (
    partner_user_id, amount_thb, bank_snapshot, status, commission_ids, approved_at
  ) VALUES (
    v_partner, 300, '{}'::jsonb, 'approved', v_event_ids, now()
  ) RETURNING id INTO v_payout_id;

  BEGIN
    PERFORM public.mark_payout_paid_v2(v_payout_id, NULL::uuid, 'BANK-REF-005', now() - interval '90 days');
    RAISE EXCEPTION 'TEST 5 FAIL: backdated p_paid_at was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'paid_at_out_of_range%' THEN
      RAISE NOTICE '✅ TEST 5 PASS: 90-day backdate rejected';
    ELSE
      RAISE EXCEPTION 'TEST 5 FAIL: wrong exception "%"', SQLERRM;
    END IF;
  END;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 6: 'pending' and 'processing' are accepted as payable states.
--          The ERP workflow never transitions through 'approved' —
--          v1 went pending → processing → paid — so the v2 RPC must
--          accept those states or every payout in the system fails.
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
  v_final_status TEXT;
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.referral_codes)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL OR v_referred IS NULL THEN
    RAISE NOTICE '⚠️ TEST 6 SKIPPED'; RETURN;
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'Pending', 'Accepts', '+66999999999', 'SCB', '0123456789', 'Pending', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-PENDING-OK', 'partner_affiliate', true, 0)
    RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed')
    RETURNING id INTO v_referral_id;
  INSERT INTO public.commission_events (
    partner_user_id, referred_user_id, referral_id,
    stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate,
    commission_amount_thb, billing_cycle, cycle_index,
    status, hold_until, available_at
  ) VALUES (
    v_partner, v_referred, v_referral_id, NULL, 'pi_pending_test',
    1000, 1000, 0.3, 300, 'month', 1,
    'available', now() - interval '1 day', now() - interval '1 hour'
  ) RETURNING id INTO v_event_id;
  INSERT INTO public.payout_requests (
    partner_user_id, amount_thb, bank_snapshot, status, commission_ids
  ) VALUES (v_partner, 300, '{}'::jsonb, 'pending', ARRAY[v_event_id])
    RETURNING id INTO v_payout_id;

  PERFORM public.mark_payout_paid_v2(v_payout_id, NULL::uuid, 'BANK-REF-006', now());
  SELECT status INTO v_final_status FROM public.payout_requests WHERE id = v_payout_id;
  IF v_final_status <> 'paid' THEN
    RAISE EXCEPTION 'TEST 6 FAIL: pending payout final status=%, expected paid', v_final_status;
  END IF;

  RAISE NOTICE '✅ TEST 6 PASS: pending payout marked paid via v2 RPC';
END $$;
ROLLBACK;
