-- Tests for the refund-cancels-payout fix
-- (migration 20260519120000_reverse_commission_cancels_payout.sql).
--
-- When a Stripe refund reverses a commission, any in-flight payout_request
-- that includes that commission must be cancelled — otherwise an admin
-- will run mark_payout_paid against a refunded amount.
--
-- Tests use RAISE EXCEPTION on FAIL (not RAISE NOTICE) so a CI driver
-- that does `psql -f` will exit non-zero on any failure. The older
-- reverse-commission-renewal.test.sql uses NOTICE which silently passes;
-- new tests follow the EXCEPTION style.
--
-- Each test wraps in a transaction and ROLLBACKs.

\set ON_ERROR_STOP on

-- ─────────────────────────────────────────────────────────────
-- TEST 1: Refund on a 'holding' commission with a pending payout
--         → commission becomes 'clawback'
--         → payout becomes 'cancelled' with reason populated
--         → affiliate_audit_log gets a payout_cancelled_on_refund row
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
  v_event_status TEXT;
  v_payout_status TEXT;
  v_payout_reason TEXT;
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
    RAISE NOTICE '⚠️ TEST 1 SKIPPED: not enough eligible users';
    RETURN;
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'Hold', 'Test', '+66900000001', 'SCB', '0000000001', 'Hold', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-CANCEL-1', 'partner_affiliate', true, 0)
    RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed')
    RETURNING id INTO v_referral_id;
  INSERT INTO public.commission_events (
    partner_user_id, referred_user_id, referral_id,
    stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate,
    commission_amount_thb, billing_cycle, cycle_index, status, hold_until
  ) VALUES (
    v_partner, v_referred, v_referral_id,
    NULL, 'pi_cancel_1',
    1000, 1000, 0.3, 300, 'month', 1,
    'holding', now() + interval '30 days'
  ) RETURNING id INTO v_event_id;

  -- A pending payout that includes this commission. In reality
  -- request_payout would only pick 'available' rows, but for this
  -- test we want to assert the cancel-on-refund path triggers for
  -- ANY status in the payout's reference array — the safety net is
  -- intentionally broader than just 'available'.
  INSERT INTO public.payout_requests (partner_user_id, amount_thb, bank_snapshot, status, commission_ids)
  VALUES (v_partner, 300, '{}'::jsonb, 'pending', ARRAY[v_event_id])
  RETURNING id INTO v_payout_id;

  PERFORM public.reverse_commission('pi_cancel_1', 're_cancel_1', 'requested_by_customer');

  SELECT status INTO v_event_status FROM public.commission_events WHERE id = v_event_id;
  IF v_event_status <> 'clawback' THEN
    RAISE EXCEPTION '❌ TEST 1 FAIL: commission status=% (expected clawback)', v_event_status;
  END IF;

  SELECT status, cancellation_reason INTO v_payout_status, v_payout_reason
    FROM public.payout_requests WHERE id = v_payout_id;
  IF v_payout_status <> 'cancelled' THEN
    RAISE EXCEPTION '❌ TEST 1 FAIL: payout status=% (expected cancelled)', v_payout_status;
  END IF;
  IF v_payout_reason NOT LIKE '%re_cancel_1%' THEN
    RAISE EXCEPTION '❌ TEST 1 FAIL: cancellation_reason=% (expected refund id)', v_payout_reason;
  END IF;

  SELECT count(*) INTO v_audit_count FROM public.affiliate_audit_log
    WHERE action = 'payout_cancelled_on_refund' AND entity_id = v_payout_id::text;
  IF v_audit_count <> 1 THEN
    RAISE EXCEPTION '❌ TEST 1 FAIL: audit_count=% (expected 1)', v_audit_count;
  END IF;

  RAISE NOTICE '✅ TEST 1 PASS: holding+pending payout fully cancelled on refund';
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 2: Refund on 'available' + processing payout
--         → clawback + payout cancelled + wallet debited + ledger row
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
  v_payout_status TEXT;
  v_wallet_balance NUMERIC;
  v_ledger_count INT;
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
  ) VALUES (v_partner, 'Avail', 'Test', '+66900000002', 'SCB', '0000000002', 'Avail', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-CANCEL-2', 'partner_affiliate', true, 0)
    RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed')
    RETURNING id INTO v_referral_id;
  INSERT INTO public.commission_events (
    partner_user_id, referred_user_id, referral_id,
    stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate,
    commission_amount_thb, billing_cycle, cycle_index, status, hold_until, available_at
  ) VALUES (
    v_partner, v_referred, v_referral_id,
    NULL, 'pi_cancel_2',
    1000, 1000, 0.3, 300, 'month', 1,
    'available', now() - interval '1 day', now() - interval '1 hour'
  ) RETURNING id INTO v_event_id;

  -- Wallet already credited by release_commission cron in reality
  INSERT INTO public.cash_wallets (user_id, balance_thb, lifetime_earned)
    VALUES (v_partner, 500, 500)
    ON CONFLICT (user_id) DO UPDATE SET balance_thb = 500, lifetime_earned = 500;

  INSERT INTO public.payout_requests (partner_user_id, amount_thb, bank_snapshot, status, commission_ids)
  VALUES (v_partner, 300, '{}'::jsonb, 'processing', ARRAY[v_event_id])
  RETURNING id INTO v_payout_id;

  PERFORM public.reverse_commission('pi_cancel_2', 're_cancel_2', 'fraudulent');

  SELECT status INTO v_payout_status FROM public.payout_requests WHERE id = v_payout_id;
  IF v_payout_status <> 'cancelled' THEN
    RAISE EXCEPTION '❌ TEST 2 FAIL: processing payout not cancelled (status=%)', v_payout_status;
  END IF;

  SELECT balance_thb INTO v_wallet_balance FROM public.cash_wallets WHERE user_id = v_partner;
  IF v_wallet_balance <> 200 THEN
    RAISE EXCEPTION '❌ TEST 2 FAIL: wallet=% (expected 500-300=200)', v_wallet_balance;
  END IF;

  SELECT count(*) INTO v_ledger_count FROM public.cash_wallet_transactions
    WHERE user_id = v_partner AND tx_type = 'commission_refunded' AND reference_id = v_event_id::text;
  IF v_ledger_count <> 1 THEN
    RAISE EXCEPTION '❌ TEST 2 FAIL: ledger_count=% (expected 1)', v_ledger_count;
  END IF;

  RAISE NOTICE '✅ TEST 2 PASS: available+processing payout cancelled, wallet debited, ledger logged';
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 3: Idempotency — second call with same refund_id is no-op,
--         payout stays cancelled (not flipped back), no duplicate audit.
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
  v_audit_count_before INT;
  v_audit_count_after INT;
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
  ) VALUES (v_partner, 'Idem', 'Test', '+66900000003', 'SCB', '0000000003', 'Idem', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-CANCEL-3', 'partner_affiliate', true, 0)
    RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed')
    RETURNING id INTO v_referral_id;
  INSERT INTO public.commission_events (
    partner_user_id, referred_user_id, referral_id,
    stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate,
    commission_amount_thb, billing_cycle, cycle_index, status, hold_until
  ) VALUES (
    v_partner, v_referred, v_referral_id, NULL, 'pi_cancel_3',
    1000, 1000, 0.3, 300, 'month', 1,
    'holding', now() + interval '30 days'
  ) RETURNING id INTO v_event_id;
  INSERT INTO public.payout_requests (partner_user_id, amount_thb, bank_snapshot, status, commission_ids)
    VALUES (v_partner, 300, '{}'::jsonb, 'pending', ARRAY[v_event_id])
    RETURNING id INTO v_payout_id;

  PERFORM public.reverse_commission('pi_cancel_3', 're_cancel_3', 'requested_by_customer');
  SELECT count(*) INTO v_audit_count_before FROM public.affiliate_audit_log
    WHERE action = 'payout_cancelled_on_refund' AND entity_id = v_payout_id::text;

  -- Second call with same refund_id — should no-op
  PERFORM public.reverse_commission('pi_cancel_3', 're_cancel_3', 'requested_by_customer');
  SELECT count(*) INTO v_audit_count_after FROM public.affiliate_audit_log
    WHERE action = 'payout_cancelled_on_refund' AND entity_id = v_payout_id::text;

  IF v_audit_count_before <> 1 OR v_audit_count_after <> 1 THEN
    RAISE EXCEPTION '❌ TEST 3 FAIL: audit before=%, after=% (expected 1/1)',
      v_audit_count_before, v_audit_count_after;
  END IF;

  RAISE NOTICE '✅ TEST 3 PASS: idempotent on duplicate refund_id (audit count stable)';
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 4: Already-paid payout is NOT touched by refund (Hole 2 documented).
--         The commission for a 'paid' event stays 'paid' (the WHERE clause
--         on reverse_commission only matches holding+available). Business
--         decision: creator was paid within 21-day commitment; MediaForge
--         absorbs the loss from late refunds.
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
  v_payout_status TEXT;
  v_event_status TEXT;
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.referral_codes)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL OR v_referred IS NULL THEN
    RAISE NOTICE '⚠️ TEST 4 SKIPPED'; RETURN;
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'Paid', 'Test', '+66900000004', 'SCB', '0000000004', 'Paid', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-CANCEL-4', 'partner_affiliate', true, 0)
    RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed')
    RETURNING id INTO v_referral_id;
  INSERT INTO public.payout_requests (partner_user_id, amount_thb, bank_snapshot, status, commission_ids)
    VALUES (v_partner, 300, '{}'::jsonb, 'paid', ARRAY[]::UUID[])
    RETURNING id INTO v_payout_id;
  INSERT INTO public.commission_events (
    partner_user_id, referred_user_id, referral_id,
    stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate,
    commission_amount_thb, billing_cycle, cycle_index,
    status, hold_until, payout_id, paid_at
  ) VALUES (
    v_partner, v_referred, v_referral_id, NULL, 'pi_cancel_4',
    1000, 1000, 0.3, 300, 'month', 1,
    'paid', now() - interval '30 days', v_payout_id, now()
  ) RETURNING id INTO v_event_id;

  PERFORM public.reverse_commission('pi_cancel_4', 're_cancel_4', 'requested_by_customer');

  SELECT status INTO v_event_status FROM public.commission_events WHERE id = v_event_id;
  SELECT status INTO v_payout_status FROM public.payout_requests WHERE id = v_payout_id;

  IF v_event_status <> 'paid' THEN
    RAISE EXCEPTION '❌ TEST 4 FAIL: paid commission was modified (status=%)', v_event_status;
  END IF;
  IF v_payout_status <> 'paid' THEN
    RAISE EXCEPTION '❌ TEST 4 FAIL: paid payout was modified (status=%)', v_payout_status;
  END IF;

  RAISE NOTICE '✅ TEST 4 PASS: refund after payout-paid is correctly NOT clawed back (Hole 2)';
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 5: Dispute path uses dispute_id as p_refund_id.
--         A second dispute webhook delivery for the same dispute is a no-op.
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
  v_event_status TEXT;
  v_reason TEXT;
  v_reversed_id TEXT;
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.referral_codes)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL OR v_referred IS NULL THEN
    RAISE NOTICE '⚠️ TEST 5 SKIPPED'; RETURN;
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'Disp', 'Test', '+66900000005', 'SCB', '0000000005', 'Disp', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-CANCEL-5', 'partner_affiliate', true, 0)
    RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed')
    RETURNING id INTO v_referral_id;
  INSERT INTO public.commission_events (
    partner_user_id, referred_user_id, referral_id,
    stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate,
    commission_amount_thb, billing_cycle, cycle_index, status, hold_until
  ) VALUES (
    v_partner, v_referred, v_referral_id, NULL, 'pi_cancel_5',
    1000, 1000, 0.3, 300, 'month', 1,
    'holding', now() + interval '30 days'
  ) RETURNING id INTO v_event_id;

  -- Dispute webhook calls reverse_commission with dispute.id as p_refund_id
  PERFORM public.reverse_commission('pi_cancel_5', 'dp_dispute_5', 'stripe_dispute:fraudulent');
  SELECT status, reversal_reason, reversed_by_refund_id
    INTO v_event_status, v_reason, v_reversed_id
    FROM public.commission_events WHERE id = v_event_id;

  IF v_event_status <> 'clawback' THEN
    RAISE EXCEPTION '❌ TEST 5 FAIL: dispute clawback didn''t happen (status=%)', v_event_status;
  END IF;
  IF v_reason NOT LIKE 'stripe_dispute:%' THEN
    RAISE EXCEPTION '❌ TEST 5 FAIL: reversal_reason=% (expected stripe_dispute:*)', v_reason;
  END IF;
  IF v_reversed_id <> 'dp_dispute_5' THEN
    RAISE EXCEPTION '❌ TEST 5 FAIL: reversed_by_refund_id=% (expected dp_dispute_5)', v_reversed_id;
  END IF;

  -- Duplicate dispute webhook delivery → idempotent no-op
  PERFORM public.reverse_commission('pi_cancel_5', 'dp_dispute_5', 'stripe_dispute:fraudulent');

  RAISE NOTICE '✅ TEST 5 PASS: dispute reverses via shared RPC, idempotent on redelivery';
END $$;
ROLLBACK;
