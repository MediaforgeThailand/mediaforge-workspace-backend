-- Regression test for the ambiguous-column bug introduced by PR #50.
--
-- The bug: reverse_commission's inner FOR loop over payout_requests used
-- the bare column name `partner_user_id`, which collided with the OUT
-- parameter of the same name declared by the RETURNS TABLE signature
-- (added in PR #39 renewal lookup). Postgres raised 42702 ambiguous and
-- the refund webhook silently failed mid-flow.
--
-- This test reproduces the exact failure shape: a refund hits an
-- available commission that is referenced by a pending payout_request.
-- The fixed function must complete without raising, mark the commission
-- as clawback, and cancel the payout.
--
-- If the migration is reverted, the PERFORM call inside this test will
-- raise 42702 and psql will exit non-zero (we use RAISE EXCEPTION on
-- assertion failures, so CI catches the regression).

\set ON_ERROR_STOP on

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
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
      AND user_id NOT IN (SELECT referrer_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner
      AND user_id NOT IN (SELECT referred_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL OR v_referred IS NULL THEN
    RAISE NOTICE '⚠️ SKIPPED: not enough eligible users';
    RETURN;
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'Disambig', 'Test', '+66999999999', 'SCB', '0123456789', 'Disambig', 'approved')
  RETURNING id INTO v_app_id;

  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());

  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-DISAMBIG', 'partner_affiliate', true, 0)
    RETURNING id INTO v_code_id;

  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status, commission_base_amount_thb, commission_rate)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed', 1000, 0.3)
    RETURNING id INTO v_referral_id;

  -- available commission ที่จะถูก refund
  INSERT INTO public.commission_events (
    partner_user_id, referred_user_id, referral_id, stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate, commission_amount_thb,
    billing_cycle, cycle_index, status, hold_until, available_at
  ) VALUES (v_partner, v_referred, v_referral_id, NULL, 'pi_disambig_test',
      1000, 1000, 0.3, 300, 'month', 1, 'available', now() - interval '1 day', now() - interval '1 hour')
  RETURNING id INTO v_event_id;

  INSERT INTO public.cash_wallets (user_id, balance_thb, lifetime_earned)
    VALUES (v_partner, 300, 300);

  -- Pending payout referencing this commission. The bug fires precisely
  -- when reverse_commission enters its second FOR loop over this table.
  INSERT INTO public.payout_requests (partner_user_id, amount_thb, bank_snapshot, status, commission_ids)
    VALUES (v_partner, 300, '{}'::jsonb, 'pending', ARRAY[v_event_id])
    RETURNING id INTO v_payout_id;

  -- If the ambiguous-column bug is present, the next PERFORM raises
  -- 42702 here and the test fails non-zero from the unhandled exception.
  PERFORM public.reverse_commission('pi_disambig_test', 're_disambig_test', 'requested_by_customer');

  -- Functional assertions: not enough to verify the call returned —
  -- we also need to confirm the loop actually ran to completion.
  SELECT status INTO v_event_status FROM public.commission_events WHERE id = v_event_id;
  IF v_event_status <> 'clawback' THEN
    RAISE EXCEPTION '❌ FAIL: commission status=%/clawback', v_event_status;
  END IF;

  SELECT status INTO v_payout_status FROM public.payout_requests WHERE id = v_payout_id;
  IF v_payout_status <> 'cancelled' THEN
    RAISE EXCEPTION '❌ FAIL: payout status=%/cancelled (the alias fix did not apply)', v_payout_status;
  END IF;

  RAISE NOTICE '✅ PASS: reverse_commission no longer raises 42702 on pending payout overlap';
END $$;
ROLLBACK;
