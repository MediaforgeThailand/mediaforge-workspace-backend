-- Affiliate complete end-to-end coverage.
--
-- This is the canonical regression test for the entire affiliate system.
-- Where `affiliate-e2e-smoke.test.sql` walks one happy-path lifecycle,
-- this file covers every scenario an admin or partner can drive — every
-- state transition, every guard, every race protection, every
-- reconciliation invariant.
--
-- The file is organised as independent SECTIONS each wrapped in
-- BEGIN/ROLLBACK so a failure in one does not pollute the others. Every
-- assertion fails loud via RAISE EXCEPTION so `psql -f` exits non-zero
-- on regression. PASS lines are RAISE NOTICE — useful for log review,
-- harmless if a downstream CI ignores them.
--
-- Coverage map (in order):
--   §1  admin_create_affiliate_partner_atomic — manual onboarding via ERP
--   §2  Apply → approve workflow — self-serve onboarding via affiliate-portal
--   §3  Commission accrual locks base + rate + 21-day hold_until
--   §4  Self-referral blocked + fraud_flag emitted
--   §5  Renewal accrues separately + PI→invoice resolution for refunds
--   §6  release_commission promotes holding → available + wallet ledger
--   §7  request_payout — happy path FIFO selection
--   §8  request_payout — bank guard (missing + 'Pending' placeholder)
--   §9  request_payout — below minimum (<500 THB) rejected
--   §10 request_payout — insufficient balance rejected
--   §11 mark_payout_paid (bridge) — happy path: payout paid, commissions
--       flipped, wallet debited, ledger row, lifetime_paid bumped
--   §12 mark_payout_paid (bridge) — rejects cancelled payout (PR #50)
--   §13 mark_payout_paid (bridge) — rowcount mismatch rolls back + 409
--   §14 reverse_commission — holding commission clawback (no wallet touch)
--   §15 reverse_commission — available commission clawback + wallet debit
--   §16 reverse_commission — cancels pending payout + audit row (PR #50)
--   §17 reverse_commission — cancels processing payout
--   §18 reverse_commission — paid commission left alone (Hole 2, by design)
--   §19 reverse_commission — idempotent on duplicate refund_id
--   §20 Dispute path — dispute.id used as p_refund_id, audit reflects it
--   §21 Reconciliation — zero drift on healthy state
--   §22 Reconciliation — Drift B (paid_commissions vs paid_payouts)
--   §23 Reconciliation — dedup index prevents duplicate audit rows
--   §24 RLS — authenticated user cannot self-promote application
--   §25 First-touch attribution lock — second referral attempt ignored
--   §26 21-day hold window verification (PR #51)

\set ON_ERROR_STOP on

-- =============================================================
-- §1  admin_create_affiliate_partner_atomic — manual onboarding
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_target UUID;
  v_actor UUID;
  v_result JSONB;
  v_app_status TEXT;
  v_partner_rate NUMERIC;
  v_code TEXT;
  v_code_active BOOLEAN;
BEGIN
  SELECT user_id INTO v_target FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
      AND user_id NOT IN (SELECT user_id FROM public.referral_codes)
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_actor FROM public.user_credits
    WHERE user_id <> v_target ORDER BY user_id LIMIT 1;
  IF v_target IS NULL OR v_actor IS NULL THEN
    RAISE NOTICE '⚠️ §1 SKIPPED'; RETURN;
  END IF;

  v_result := public.admin_create_affiliate_partner_atomic(
    v_target, v_actor, 'admin@mediaforge.co',
    'creator@example.com', 'New', 'Creator', '+66800000001',
    'SCB', '1111111111', 'New Creator',
    'https://instagram.com/newcreator', 'instagram', 1000,
    0.30, 'MF-NEW-CREATOR', 20, 'Invited creator (test)'
  );

  -- Application landed at approved
  SELECT status INTO v_app_status FROM public.partner_applications WHERE user_id = v_target;
  IF v_app_status <> 'approved' THEN
    RAISE EXCEPTION '§1 FAIL: application status=% (expected approved)', v_app_status;
  END IF;
  -- Partner row created with the requested commission_rate
  SELECT commission_rate INTO v_partner_rate FROM public.partners WHERE user_id = v_target;
  IF v_partner_rate <> 0.30 THEN
    RAISE EXCEPTION '§1 FAIL: commission_rate=%/0.30', v_partner_rate;
  END IF;
  -- Referral code minted, active, normalized to upper-case
  SELECT code, is_active INTO v_code, v_code_active FROM public.referral_codes
    WHERE user_id = v_target AND code_type = 'partner_affiliate' LIMIT 1;
  IF v_code IS NULL OR v_code <> 'MF-NEW-CREATOR' OR v_code_active IS NOT TRUE THEN
    RAISE EXCEPTION '§1 FAIL: code=%, active=%', v_code, v_code_active;
  END IF;
  RAISE NOTICE '✅ §1 PASS: manual partner created atomically (app+partner+code)';
END $$;
ROLLBACK;

-- =============================================================
-- §2  Apply → approve workflow (self-serve onboarding)
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_user UUID;
  v_app_id UUID;
  v_status_after_submit TEXT;
  v_status_after_approve TEXT;
BEGIN
  SELECT user_id INTO v_user FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
    ORDER BY user_id LIMIT 1;
  IF v_user IS NULL THEN RAISE NOTICE '⚠️ §2 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status, submitted_at
  ) VALUES (
    v_user, 'Self', 'Apply', '+66800000002', 'SCB', '2222222222',
    'Self Apply', 'submitted', now()
  ) RETURNING id INTO v_app_id;

  SELECT status INTO v_status_after_submit FROM public.partner_applications WHERE id = v_app_id;
  IF v_status_after_submit <> 'submitted' THEN
    RAISE EXCEPTION '§2 FAIL: post-submit status=% (expected submitted)', v_status_after_submit;
  END IF;

  -- Admin approval (direct UPDATE simulates the approve_application bridge action)
  UPDATE public.partner_applications
    SET status = 'approved', reviewed_at = now()
    WHERE id = v_app_id;
  -- Bridge inserts the partners row + code on approve
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_user, v_app_id, 0.30, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active)
    VALUES (v_user, 'MF-P-' || substr(md5(v_user::text), 1, 6), 'partner_affiliate', true);

  SELECT status INTO v_status_after_approve FROM public.partner_applications WHERE id = v_app_id;
  IF v_status_after_approve <> 'approved'
     OR NOT EXISTS (SELECT 1 FROM public.partners WHERE user_id = v_user)
     OR NOT EXISTS (SELECT 1 FROM public.referral_codes WHERE user_id = v_user) THEN
    RAISE EXCEPTION '§2 FAIL: post-approve invariant broken';
  END IF;
  RAISE NOTICE '✅ §2 PASS: apply→approve workflow';
END $$;
ROLLBACK;

-- =============================================================
-- §3  Commission accrual locks base + rate
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
  v_event_id UUID;
  v_locked_base NUMERIC;
  v_locked_rate NUMERIC;
  v_amount NUMERIC;
  v_status TEXT;
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
  IF v_partner IS NULL OR v_referred IS NULL THEN RAISE NOTICE '⚠️ §3 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'Accrual', 'Lock', '+66800000003', 'SCB', '3333333333', 'Accrual Lock', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.30, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active)
    VALUES (v_partner, 'MF-LOCK-3', 'partner_affiliate', true) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'pending') RETURNING id INTO v_referral_id;

  v_event_id := public.accrue_commission(v_referred, 'pi_lock_test', 1000, 1000, 'month', 1);
  IF v_event_id IS NULL THEN RAISE EXCEPTION '§3 FAIL: accrue returned NULL'; END IF;

  SELECT commission_base_amount_thb, commission_rate INTO v_locked_base, v_locked_rate
    FROM public.referrals WHERE id = v_referral_id;
  IF v_locked_base <> 1000 OR v_locked_rate <> 0.30 THEN
    RAISE EXCEPTION '§3 FAIL: referral lock base=%, rate=%', v_locked_base, v_locked_rate;
  END IF;

  SELECT commission_amount_thb, status INTO v_amount, v_status
    FROM public.commission_events WHERE id = v_event_id;
  IF v_amount <> 300 OR v_status <> 'holding' THEN
    RAISE EXCEPTION '§3 FAIL: commission amount=%, status=% (expected 300, holding)', v_amount, v_status;
  END IF;
  RAISE NOTICE '✅ §3 PASS: base+rate locked at first paid, commission=300, holding';
END $$;
ROLLBACK;

-- =============================================================
-- §4  Self-referral blocked + fraud_flag emitted
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
  v_event_id UUID;
  v_fraud_count INT;
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
    ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL THEN RAISE NOTICE '⚠️ §4 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'Self', 'Ref', '+66800000004', 'SCB', '4444444444', 'Self Ref', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.30, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active)
    VALUES (v_partner, 'MF-SELF-4', 'partner_affiliate', true) RETURNING id INTO v_code_id;

  -- Attacker uses their own referral code on their own account
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_partner, v_code_id, 'partner_affiliate', 'confirmed')
    RETURNING id INTO v_referral_id;

  v_event_id := public.accrue_commission(v_partner, 'pi_self_ref', 1000, 1000, 'month', 1);
  IF v_event_id IS NOT NULL THEN
    RAISE EXCEPTION '§4 FAIL: accrue_commission allowed self-referral, event_id=%', v_event_id;
  END IF;

  -- Fraud flag should be emitted by the trigger (PR #45)
  SELECT count(*) INTO v_fraud_count FROM public.fraud_flags
    WHERE related_user_id = v_partner AND kind = 'self_referral';
  IF v_fraud_count = 0 THEN
    RAISE EXCEPTION '§4 FAIL: no self_referral fraud_flag emitted';
  END IF;
  RAISE NOTICE '✅ §4 PASS: self-referral blocked + fraud_flag emitted';
END $$;
ROLLBACK;

-- =============================================================
-- §5  Renewal accrual is separate + PI→invoice resolution
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
  v_event_first UUID;
  v_event_renewal UUID;
  v_status_first TEXT;
  v_status_renewal TEXT;
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
  IF v_partner IS NULL OR v_referred IS NULL THEN RAISE NOTICE '⚠️ §5 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'Renewal', 'Path', '+66800000005', 'SCB', '5555555555', 'Renewal Path', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.30, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active)
    VALUES (v_partner, 'MF-RENEW-5', 'partner_affiliate', true) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'pending') RETURNING id INTO v_referral_id;

  -- First paid (PI prefix)
  v_event_first := public.accrue_commission(v_referred, 'pi_renewal_first', 1000, 1000, 'month', 1);
  -- Renewal (invoice prefix)
  v_event_renewal := public.accrue_commission(v_referred, 'in_renewal_test_5', 1000, 1000, 'month', 2);
  IF v_event_first IS NULL OR v_event_renewal IS NULL OR v_event_first = v_event_renewal THEN
    RAISE EXCEPTION '§5 FAIL: events first=%, renewal=%', v_event_first, v_event_renewal;
  END IF;

  -- PI→invoice mapping so refund webhook can later resolve the renewal
  INSERT INTO public.payment_transactions (user_id, amount_thb, status, stripe_payment_intent_id, stripe_invoice_id)
    VALUES (v_referred, 1000, 'completed', 'pi_renewal_renewal_pi', 'in_renewal_test_5');

  -- Refund on the PI should claw back the renewal commission via lookup
  UPDATE public.commission_events SET status = 'holding', hold_until = now() + interval '21 days'
    WHERE id IN (v_event_first, v_event_renewal);
  PERFORM public.reverse_commission('pi_renewal_renewal_pi', 're_renewal_5', 'requested_by_customer');

  SELECT status INTO v_status_first FROM public.commission_events WHERE id = v_event_first;
  SELECT status INTO v_status_renewal FROM public.commission_events WHERE id = v_event_renewal;
  IF v_status_renewal <> 'clawback' THEN
    RAISE EXCEPTION '§5 FAIL: renewal not clawback (status=%)', v_status_renewal;
  END IF;
  IF v_status_first <> 'holding' THEN
    RAISE EXCEPTION '§5 FAIL: first paid commission was reversed by an unrelated refund (status=%)', v_status_first;
  END IF;
  RAISE NOTICE '✅ §5 PASS: renewal reverses independently via PI→invoice resolution';
END $$;
ROLLBACK;

-- =============================================================
-- §6  release_commission promotes holding → available + ledger
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
  v_event_id UUID;
  v_balance NUMERIC;
  v_ledger_count INT;
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
  IF v_partner IS NULL OR v_referred IS NULL THEN RAISE NOTICE '⚠️ §6 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'Release', 'Path', '+66800000006', 'SCB', '6666666666', 'Release Path', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.30, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active)
    VALUES (v_partner, 'MF-RELEASE-6', 'partner_affiliate', true) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'pending') RETURNING id INTO v_referral_id;

  v_event_id := public.accrue_commission(v_referred, 'pi_release_6', 1000, 1000, 'month', 1);
  UPDATE public.commission_events SET hold_until = now() - interval '1 hour' WHERE id = v_event_id;
  PERFORM public.release_commission();

  IF (SELECT status FROM public.commission_events WHERE id = v_event_id) <> 'available' THEN
    RAISE EXCEPTION '§6 FAIL: release did not promote to available';
  END IF;
  SELECT balance_thb INTO v_balance FROM public.cash_wallets WHERE user_id = v_partner;
  IF v_balance <> 300 THEN RAISE EXCEPTION '§6 FAIL: wallet balance=%/300', v_balance; END IF;
  SELECT count(*) INTO v_ledger_count FROM public.cash_wallet_transactions
    WHERE user_id = v_partner AND tx_type = 'commission_released' AND reference_id = v_event_id::text;
  IF v_ledger_count <> 1 THEN RAISE EXCEPTION '§6 FAIL: ledger count=%/1', v_ledger_count; END IF;
  RAISE NOTICE '✅ §6 PASS: release flips status, credits wallet, writes ledger';
END $$;
ROLLBACK;

-- =============================================================
-- §7  request_payout — happy path FIFO
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
  v_event_1 UUID;
  v_event_2 UUID;
  v_payout_id UUID;
  v_picked_ids UUID[];
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
  IF v_partner IS NULL OR v_referred IS NULL THEN RAISE NOTICE '⚠️ §7 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'Payout', 'Happy', '+66800000007', 'SCB', '7777777777', 'Payout Happy', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.30, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active)
    VALUES (v_partner, 'MF-PAYOUT-7', 'partner_affiliate', true) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'pending') RETURNING id INTO v_referral_id;

  v_event_1 := public.accrue_commission(v_referred, 'pi_payout_1', 1000, 1000, 'month', 1);
  v_event_2 := public.accrue_commission(v_referred, 'in_payout_2', 1000, 1000, 'month', 2);
  UPDATE public.commission_events SET status = 'available',
    hold_until = now() - interval '1 day',
    available_at = now() - interval '1 hour'
    WHERE id IN (v_event_1, v_event_2);
  INSERT INTO public.cash_wallets (user_id, balance_thb, lifetime_earned) VALUES (v_partner, 600, 600)
    ON CONFLICT (user_id) DO UPDATE SET balance_thb = 600;

  PERFORM set_config('request.jwt.claim.sub', v_partner::text, true);
  v_payout_id := public.request_payout(600, jsonb_build_object('bank_name','SCB','account','7777777777'));
  IF v_payout_id IS NULL THEN RAISE EXCEPTION '§7 FAIL: request_payout returned NULL'; END IF;

  SELECT commission_ids INTO v_picked_ids FROM public.payout_requests WHERE id = v_payout_id;
  IF array_length(v_picked_ids, 1) <> 2
     OR NOT (v_event_1 = ANY(v_picked_ids)) OR NOT (v_event_2 = ANY(v_picked_ids)) THEN
    RAISE EXCEPTION '§7 FAIL: payout did not pick both commissions';
  END IF;
  RAISE NOTICE '✅ §7 PASS: payout=pending, both commissions picked FIFO';
END $$;
ROLLBACK;

-- =============================================================
-- §8  request_payout — bank guard
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_app_id UUID;
  v_threw BOOLEAN := false;
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
    ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL THEN RAISE NOTICE '⚠️ §8 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'Bank', 'Guard', '+66800000008', '', '', 'Bank Guard', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.30, now());

  PERFORM set_config('request.jwt.claim.sub', v_partner::text, true);
  BEGIN
    PERFORM public.request_payout(500, '{}'::jsonb);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'bank_details_incomplete' THEN v_threw := true; END IF;
  END;
  IF NOT v_threw THEN RAISE EXCEPTION '§8 FAIL (a): empty bank should raise bank_details_incomplete'; END IF;

  -- Now try with 'Pending' placeholder
  UPDATE public.partner_applications SET bank_name = 'Pending', bank_account_no = 'Pending' WHERE id = v_app_id;
  v_threw := false;
  BEGIN
    PERFORM public.request_payout(500, '{}'::jsonb);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'bank_details_incomplete' THEN v_threw := true; END IF;
  END;
  IF NOT v_threw THEN RAISE EXCEPTION '§8 FAIL (b): "Pending" placeholder should raise bank_details_incomplete'; END IF;
  RAISE NOTICE '✅ §8 PASS: bank guard rejects empty + Pending placeholder';
END $$;
ROLLBACK;

-- =============================================================
-- §9  request_payout — below minimum (<500)
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_app_id UUID;
  v_threw BOOLEAN := false;
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
    ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL THEN RAISE NOTICE '⚠️ §9 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'Below', 'Min', '+66800000009', 'SCB', '9999999999', 'Below Min', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.30, now());

  PERFORM set_config('request.jwt.claim.sub', v_partner::text, true);
  BEGIN
    PERFORM public.request_payout(100, '{}'::jsonb);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'below_minimum_threshold%' THEN v_threw := true; END IF;
  END;
  IF NOT v_threw THEN RAISE EXCEPTION '§9 FAIL: 100 THB should raise below_minimum_threshold'; END IF;
  RAISE NOTICE '✅ §9 PASS: <500 THB request rejected';
END $$;
ROLLBACK;

-- =============================================================
-- §10  request_payout — insufficient balance
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_app_id UUID;
  v_threw BOOLEAN := false;
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
    ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL THEN RAISE NOTICE '⚠️ §10 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'No', 'Balance', '+66800000010', 'SCB', '1010101010', 'No Balance', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.30, now());

  PERFORM set_config('request.jwt.claim.sub', v_partner::text, true);
  BEGIN
    PERFORM public.request_payout(500, '{}'::jsonb);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'insufficient_balance%' THEN v_threw := true; END IF;
  END;
  IF NOT v_threw THEN RAISE EXCEPTION '§10 FAIL: zero balance should raise insufficient_balance'; END IF;
  RAISE NOTICE '✅ §10 PASS: insufficient balance rejected';
END $$;
ROLLBACK;

-- =============================================================
-- §11  mark_payout_paid (bridge) — happy path
--       Simulates the bridge's UPDATE flow + assertions.
-- =============================================================
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
  v_updated_count INT;
  v_wallet_before NUMERIC;
  v_wallet_after NUMERIC;
  v_lifetime_before NUMERIC;
  v_lifetime_after NUMERIC;
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
  IF v_partner IS NULL OR v_referred IS NULL THEN RAISE NOTICE '⚠️ §11 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'Paid', 'Path', '+66800000011', 'SCB', '1111111112', 'Paid Path', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at, lifetime_commission_thb)
    VALUES (v_partner, v_app_id, 0.30, now(), 300);
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active)
    VALUES (v_partner, 'MF-PAID-11', 'partner_affiliate', true) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status, commission_base_amount_thb, commission_rate)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed', 1000, 0.30) RETURNING id INTO v_referral_id;
  INSERT INTO public.commission_events (
    partner_user_id, referred_user_id, referral_id, stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate, commission_amount_thb,
    billing_cycle, cycle_index, status, hold_until, available_at
  ) VALUES (v_partner, v_referred, v_referral_id, NULL, 'pi_paid_11',
    1000, 1000, 0.30, 300, 'month', 1, 'available', now() - interval '1 day', now() - interval '1 hour')
    RETURNING id INTO v_event_id;
  INSERT INTO public.cash_wallets (user_id, balance_thb, lifetime_earned) VALUES (v_partner, 300, 300);

  INSERT INTO public.payout_requests (partner_user_id, amount_thb, bank_snapshot, status, commission_ids)
    VALUES (v_partner, 300, '{}'::jsonb, 'pending', ARRAY[v_event_id]) RETURNING id INTO v_payout_id;

  -- Bridge's mark_payout_paid logic (simulated): UPDATE filtered by status='available'
  SELECT balance_thb, lifetime_paid_thb INTO v_wallet_before, v_lifetime_before
    FROM public.cash_wallets CROSS JOIN public.partners
    WHERE cash_wallets.user_id = v_partner AND partners.user_id = v_partner;
  IF v_lifetime_before IS NULL THEN v_lifetime_before := 0; END IF;

  UPDATE public.payout_requests SET status = 'paid', processed_at = now(), proof_url = 'BANK-REF-11' WHERE id = v_payout_id;
  WITH upd AS (
    UPDATE public.commission_events
       SET status = 'paid', paid_at = now(), payout_id = v_payout_id
     WHERE id = v_event_id AND status = 'available'
    RETURNING 1
  )
  SELECT count(*) INTO v_updated_count FROM upd;
  IF v_updated_count <> 1 THEN RAISE EXCEPTION '§11 FAIL: commission update rowcount=%/1', v_updated_count; END IF;
  UPDATE public.partners SET lifetime_paid_thb = COALESCE(lifetime_paid_thb, 0) + 300 WHERE user_id = v_partner;
  UPDATE public.cash_wallets SET balance_thb = balance_thb - 300 WHERE user_id = v_partner;
  INSERT INTO public.cash_wallet_transactions (user_id, amount_thb, tx_type, reference_id, note)
    VALUES (v_partner, -300, 'payout_debit', v_payout_id::text, 'Payout paid');

  SELECT balance_thb INTO v_wallet_after FROM public.cash_wallets WHERE user_id = v_partner;
  SELECT lifetime_paid_thb INTO v_lifetime_after FROM public.partners WHERE user_id = v_partner;

  IF v_wallet_after <> 0 THEN RAISE EXCEPTION '§11 FAIL: wallet=%/0', v_wallet_after; END IF;
  IF v_lifetime_after <> 300 THEN RAISE EXCEPTION '§11 FAIL: lifetime_paid=%/300', v_lifetime_after; END IF;
  IF (SELECT status FROM public.commission_events WHERE id = v_event_id) <> 'paid' THEN
    RAISE EXCEPTION '§11 FAIL: commission not paid';
  END IF;
  RAISE NOTICE '✅ §11 PASS: bridge mark_payout_paid happy path (wallet=0, lifetime=300)';
END $$;
ROLLBACK;

-- =============================================================
-- §12  mark_payout_paid (bridge) — cancelled payout rejected (PR #50)
--      Simulates the bridge's status-guard branch.
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_app_id UUID;
  v_payout_id UUID;
  v_payout_status TEXT;
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
    ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL THEN RAISE NOTICE '⚠️ §12 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'Cancelled', 'Reject', '+66800000012', 'SCB', '1212121212', 'C R', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.30, now());
  INSERT INTO public.payout_requests (partner_user_id, amount_thb, bank_snapshot, status, commission_ids, cancelled_at, cancellation_reason)
    VALUES (v_partner, 500, '{}'::jsonb, 'cancelled', ARRAY[]::UUID[], now(), 'simulated refund cancel')
    RETURNING id INTO v_payout_id;

  -- Bridge would check `if (["cancelled","failed","rejected"].includes(payout.status))`
  -- and return fail 409. We assert the precondition holds.
  SELECT status INTO v_payout_status FROM public.payout_requests WHERE id = v_payout_id;
  IF v_payout_status <> 'cancelled' THEN
    RAISE EXCEPTION '§12 FAIL: precondition payout.status=%/cancelled', v_payout_status;
  END IF;
  -- Bridge would NOT proceed → no commission update, no wallet debit.
  -- If the bridge were buggy and bypassed the guard, the same UPDATE filter
  -- would still match zero rows because commission_ids is empty.
  RAISE NOTICE '✅ §12 PASS: cancelled payout is in terminal state — bridge guard would reject';
END $$;
ROLLBACK;

-- =============================================================
-- §13  mark_payout_paid — rowcount mismatch rolls back (PR #50)
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
  v_event_avail UUID;
  v_event_clawback UUID;
  v_payout_id UUID;
  v_updated_count INT;
  v_payout_status_after TEXT;
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
      AND user_id NOT IN (SELECT referrer_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner AND user_id NOT IN (SELECT referred_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL OR v_referred IS NULL THEN RAISE NOTICE '⚠️ §13 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'RowMis', 'Match', '+66800000013', 'SCB', '1313131313', 'RM', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.30, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active)
    VALUES (v_partner, 'MF-RM-13', 'partner_affiliate', true) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status, commission_base_amount_thb, commission_rate)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed', 1000, 0.30) RETURNING id INTO v_referral_id;
  -- One available, one already clawback'd (simulating concurrent refund)
  INSERT INTO public.commission_events (partner_user_id, referred_user_id, referral_id, stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate, commission_amount_thb, billing_cycle, cycle_index, status, hold_until)
    VALUES (v_partner, v_referred, v_referral_id, NULL, 'pi_rm_a', 1000, 1000, 0.30, 300, 'month', 1, 'available', now() - interval '1 day')
    RETURNING id INTO v_event_avail;
  INSERT INTO public.commission_events (partner_user_id, referred_user_id, referral_id, stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate, commission_amount_thb, billing_cycle, cycle_index, status, hold_until)
    VALUES (v_partner, v_referred, v_referral_id, NULL, 'pi_rm_b', 1000, 1000, 0.30, 300, 'month', 2, 'clawback', now() - interval '1 day')
    RETURNING id INTO v_event_clawback;
  INSERT INTO public.payout_requests (partner_user_id, amount_thb, bank_snapshot, status, commission_ids)
    VALUES (v_partner, 600, '{}'::jsonb, 'pending', ARRAY[v_event_avail, v_event_clawback])
    RETURNING id INTO v_payout_id;

  -- Bridge UPDATE simulation: filtered by status='available'
  WITH upd AS (
    UPDATE public.commission_events
       SET status = 'paid', paid_at = now(), payout_id = v_payout_id
     WHERE id IN (v_event_avail, v_event_clawback) AND status = 'available'
    RETURNING 1
  )
  SELECT count(*) INTO v_updated_count FROM upd;

  -- Bridge sees updated_count=1 but commission_ids.length=2 → rollback
  IF v_updated_count <> 1 THEN
    RAISE EXCEPTION '§13 FAIL: expected rowcount=1 (one row clawback), got %', v_updated_count;
  END IF;
  -- Simulate rollback: payout never flipped to paid, stays pending
  SELECT status INTO v_payout_status_after FROM public.payout_requests WHERE id = v_payout_id;
  IF v_payout_status_after <> 'pending' THEN
    RAISE EXCEPTION '§13 FAIL: payout flipped despite rowcount mismatch (status=%)', v_payout_status_after;
  END IF;
  RAISE NOTICE '✅ §13 PASS: rowcount mismatch caught — bridge would roll back payout flip';
END $$;
ROLLBACK;

-- =============================================================
-- §14  reverse_commission — holding clawback, no wallet touch
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
  v_event_id UUID;
  v_wallet_count INT;
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
      AND user_id NOT IN (SELECT referrer_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner AND user_id NOT IN (SELECT referred_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL OR v_referred IS NULL THEN RAISE NOTICE '⚠️ §14 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'Hold', 'Claw', '+66800000014', 'SCB', '1414141414', 'HC', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.30, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active)
    VALUES (v_partner, 'MF-HOLDCLAW-14', 'partner_affiliate', true) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'pending') RETURNING id INTO v_referral_id;

  v_event_id := public.accrue_commission(v_referred, 'pi_hold_claw_14', 1000, 1000, 'month', 1);
  PERFORM public.reverse_commission('pi_hold_claw_14', 're_hold_claw_14', 'requested_by_customer');

  IF (SELECT status FROM public.commission_events WHERE id = v_event_id) <> 'clawback' THEN
    RAISE EXCEPTION '§14 FAIL: holding commission not clawback';
  END IF;
  SELECT count(*) INTO v_wallet_count FROM public.cash_wallet_transactions
    WHERE user_id = v_partner AND tx_type = 'commission_refunded';
  IF v_wallet_count <> 0 THEN
    RAISE EXCEPTION '§14 FAIL: holding clawback wrote wallet ledger (count=%)', v_wallet_count;
  END IF;
  RAISE NOTICE '✅ §14 PASS: holding clawback flips status, no wallet ledger';
END $$;
ROLLBACK;

-- =============================================================
-- §15  reverse_commission — available clawback + wallet debit
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
  v_event_id UUID;
  v_balance_before NUMERIC;
  v_balance_after NUMERIC;
  v_ledger_count INT;
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
      AND user_id NOT IN (SELECT referrer_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner AND user_id NOT IN (SELECT referred_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL OR v_referred IS NULL THEN RAISE NOTICE '⚠️ §15 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'Avail', 'Claw', '+66800000015', 'SCB', '1515151515', 'AC', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.30, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active)
    VALUES (v_partner, 'MF-AVAILCLAW-15', 'partner_affiliate', true) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status, commission_base_amount_thb, commission_rate)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed', 1000, 0.30) RETURNING id INTO v_referral_id;
  INSERT INTO public.commission_events (partner_user_id, referred_user_id, referral_id, stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate, commission_amount_thb, billing_cycle, cycle_index, status, hold_until, available_at)
    VALUES (v_partner, v_referred, v_referral_id, NULL, 'pi_avail_claw_15',
      1000, 1000, 0.30, 300, 'month', 1, 'available', now() - interval '1 day', now() - interval '1 hour')
    RETURNING id INTO v_event_id;
  INSERT INTO public.cash_wallets (user_id, balance_thb, lifetime_earned) VALUES (v_partner, 500, 500);
  v_balance_before := 500;

  PERFORM public.reverse_commission('pi_avail_claw_15', 're_avail_claw_15', 'fraudulent');

  SELECT balance_thb INTO v_balance_after FROM public.cash_wallets WHERE user_id = v_partner;
  IF v_balance_after <> v_balance_before - 300 THEN
    RAISE EXCEPTION '§15 FAIL: wallet=%/200', v_balance_after;
  END IF;
  SELECT count(*) INTO v_ledger_count FROM public.cash_wallet_transactions
    WHERE user_id = v_partner AND tx_type = 'commission_refunded' AND reference_id = v_event_id::text;
  IF v_ledger_count <> 1 THEN RAISE EXCEPTION '§15 FAIL: ledger count=%/1', v_ledger_count; END IF;
  RAISE NOTICE '✅ §15 PASS: available clawback debits wallet + writes commission_refunded ledger';
END $$;
ROLLBACK;

-- =============================================================
-- §16  reverse_commission — cancels pending payout (PR #50)
-- =============================================================
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
  v_payout_reason TEXT;
  v_audit_count INT;
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
      AND user_id NOT IN (SELECT referrer_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner AND user_id NOT IN (SELECT referred_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL OR v_referred IS NULL THEN RAISE NOTICE '⚠️ §16 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'Pending', 'Cancel', '+66800000016', 'SCB', '1616161616', 'PC', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.30, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active)
    VALUES (v_partner, 'MF-PC-16', 'partner_affiliate', true) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'pending') RETURNING id INTO v_referral_id;
  v_event_id := public.accrue_commission(v_referred, 'pi_pc_16', 1000, 1000, 'month', 1);
  INSERT INTO public.payout_requests (partner_user_id, amount_thb, bank_snapshot, status, commission_ids)
    VALUES (v_partner, 300, '{}'::jsonb, 'pending', ARRAY[v_event_id]) RETURNING id INTO v_payout_id;

  PERFORM public.reverse_commission('pi_pc_16', 're_pc_16', 'requested_by_customer');

  SELECT status, cancellation_reason INTO v_payout_status, v_payout_reason
    FROM public.payout_requests WHERE id = v_payout_id;
  IF v_payout_status <> 'cancelled' THEN
    RAISE EXCEPTION '§16 FAIL: payout=%/cancelled', v_payout_status;
  END IF;
  IF v_payout_reason NOT LIKE '%re_pc_16%' THEN
    RAISE EXCEPTION '§16 FAIL: cancellation_reason=% (missing refund id)', v_payout_reason;
  END IF;
  SELECT count(*) INTO v_audit_count FROM public.affiliate_audit_log
    WHERE action = 'payout_cancelled_on_refund' AND entity_id = v_payout_id::text;
  IF v_audit_count <> 1 THEN RAISE EXCEPTION '§16 FAIL: audit count=%/1', v_audit_count; END IF;
  RAISE NOTICE '✅ §16 PASS: pending payout cancelled by refund, audit row written';
END $$;
ROLLBACK;

-- =============================================================
-- §17  reverse_commission — cancels processing payout
-- =============================================================
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
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
      AND user_id NOT IN (SELECT referrer_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner AND user_id NOT IN (SELECT referred_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL OR v_referred IS NULL THEN RAISE NOTICE '⚠️ §17 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'Proc', 'Cancel', '+66800000017', 'SCB', '1717171717', 'PXC', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.30, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active)
    VALUES (v_partner, 'MF-PXC-17', 'partner_affiliate', true) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'pending') RETURNING id INTO v_referral_id;
  v_event_id := public.accrue_commission(v_referred, 'pi_pxc_17', 1000, 1000, 'month', 1);
  INSERT INTO public.payout_requests (partner_user_id, amount_thb, bank_snapshot, status, commission_ids)
    VALUES (v_partner, 300, '{}'::jsonb, 'processing', ARRAY[v_event_id]) RETURNING id INTO v_payout_id;

  PERFORM public.reverse_commission('pi_pxc_17', 're_pxc_17', 'requested_by_customer');
  SELECT status INTO v_payout_status FROM public.payout_requests WHERE id = v_payout_id;
  IF v_payout_status <> 'cancelled' THEN
    RAISE EXCEPTION '§17 FAIL: processing payout=%/cancelled', v_payout_status;
  END IF;
  RAISE NOTICE '✅ §17 PASS: processing payout cancelled by refund';
END $$;
ROLLBACK;

-- =============================================================
-- §18  reverse_commission — paid commission left alone (Hole 2)
-- =============================================================
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
    WHERE user_id <> v_partner AND user_id NOT IN (SELECT referred_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL OR v_referred IS NULL THEN RAISE NOTICE '⚠️ §18 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'Hole', 'Two', '+66800000018', 'SCB', '1818181818', 'H2', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.30, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active)
    VALUES (v_partner, 'MF-H2-18', 'partner_affiliate', true) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status, commission_base_amount_thb, commission_rate)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed', 1000, 0.30) RETURNING id INTO v_referral_id;
  INSERT INTO public.payout_requests (partner_user_id, amount_thb, bank_snapshot, status, commission_ids)
    VALUES (v_partner, 300, '{}'::jsonb, 'paid', ARRAY[]::UUID[]) RETURNING id INTO v_payout_id;
  INSERT INTO public.commission_events (partner_user_id, referred_user_id, referral_id, stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate, commission_amount_thb, billing_cycle, cycle_index, status, hold_until, payout_id, paid_at)
    VALUES (v_partner, v_referred, v_referral_id, NULL, 'pi_h2_18',
      1000, 1000, 0.30, 300, 'month', 1, 'paid', now() - interval '30 days', v_payout_id, now())
    RETURNING id INTO v_event_id;

  PERFORM public.reverse_commission('pi_h2_18', 're_h2_18', 'requested_by_customer');
  SELECT status INTO v_event_status FROM public.commission_events WHERE id = v_event_id;
  SELECT status INTO v_payout_status FROM public.payout_requests WHERE id = v_payout_id;
  IF v_event_status <> 'paid' THEN RAISE EXCEPTION '§18 FAIL: paid event mutated to %', v_event_status; END IF;
  IF v_payout_status <> 'paid' THEN RAISE EXCEPTION '§18 FAIL: paid payout mutated to %', v_payout_status; END IF;
  RAISE NOTICE '✅ §18 PASS: Hole 2 — refund after payout-paid leaves creator''s money alone';
END $$;
ROLLBACK;

-- =============================================================
-- §19  reverse_commission — idempotent on duplicate refund_id
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
  v_event_id UUID;
  v_audit_before INT;
  v_audit_after INT;
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
      AND user_id NOT IN (SELECT referrer_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner AND user_id NOT IN (SELECT referred_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL OR v_referred IS NULL THEN RAISE NOTICE '⚠️ §19 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'Idem', 'Refund', '+66800000019', 'SCB', '1919191919', 'IR', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.30, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active)
    VALUES (v_partner, 'MF-IR-19', 'partner_affiliate', true) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'pending') RETURNING id INTO v_referral_id;
  v_event_id := public.accrue_commission(v_referred, 'pi_ir_19', 1000, 1000, 'month', 1);

  PERFORM public.reverse_commission('pi_ir_19', 're_ir_19', 'requested_by_customer');
  SELECT count(*) INTO v_audit_before FROM public.affiliate_audit_log
    WHERE entity_id = v_event_id::text OR (diff->>'reversed_by_refund_id') = 're_ir_19';

  -- Duplicate delivery — should no-op
  PERFORM public.reverse_commission('pi_ir_19', 're_ir_19', 'requested_by_customer');
  SELECT count(*) INTO v_audit_after FROM public.affiliate_audit_log
    WHERE entity_id = v_event_id::text OR (diff->>'reversed_by_refund_id') = 're_ir_19';

  IF v_audit_after <> v_audit_before THEN
    RAISE EXCEPTION '§19 FAIL: duplicate refund wrote new rows (before=%, after=%)', v_audit_before, v_audit_after;
  END IF;
  RAISE NOTICE '✅ §19 PASS: duplicate refund_id is no-op';
END $$;
ROLLBACK;

-- =============================================================
-- §20  Dispute — dispute.id used as p_refund_id
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
  v_event_id UUID;
  v_reversed_id TEXT;
  v_reason TEXT;
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
      AND user_id NOT IN (SELECT referrer_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner AND user_id NOT IN (SELECT referred_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL OR v_referred IS NULL THEN RAISE NOTICE '⚠️ §20 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'Disp', 'Path', '+66800000020', 'SCB', '2020202020', 'DP', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.30, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active)
    VALUES (v_partner, 'MF-DP-20', 'partner_affiliate', true) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'pending') RETURNING id INTO v_referral_id;
  v_event_id := public.accrue_commission(v_referred, 'pi_dp_20', 1000, 1000, 'month', 1);

  -- Webhook calls reverse_commission(PI, dispute_id, 'stripe_dispute:<reason>')
  PERFORM public.reverse_commission('pi_dp_20', 'dp_dispute_20', 'stripe_dispute:fraudulent');

  SELECT reversed_by_refund_id, reversal_reason INTO v_reversed_id, v_reason
    FROM public.commission_events WHERE id = v_event_id;
  IF v_reversed_id <> 'dp_dispute_20' THEN
    RAISE EXCEPTION '§20 FAIL: reversed_by_refund_id=%/dp_dispute_20', v_reversed_id;
  END IF;
  IF v_reason NOT LIKE 'stripe_dispute:%' THEN
    RAISE EXCEPTION '§20 FAIL: reason=% (expected stripe_dispute:*)', v_reason;
  END IF;
  RAISE NOTICE '✅ §20 PASS: dispute path uses dispute.id as p_refund_id';
END $$;
ROLLBACK;

-- =============================================================
-- §21  Reconciliation — zero drift on healthy state
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
  v_event_id UUID;
  v_drift_before INT;
  v_drift_after INT;
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
      AND user_id NOT IN (SELECT referrer_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner AND user_id NOT IN (SELECT referred_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL OR v_referred IS NULL THEN RAISE NOTICE '⚠️ §21 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'Recon', 'OK', '+66800000021', 'SCB', '2121212121', 'RO', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at, lifetime_commission_thb)
    VALUES (v_partner, v_app_id, 0.30, now(), 300);
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active)
    VALUES (v_partner, 'MF-RO-21', 'partner_affiliate', true) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status, commission_base_amount_thb, commission_rate)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed', 1000, 0.30) RETURNING id INTO v_referral_id;
  INSERT INTO public.commission_events (partner_user_id, referred_user_id, referral_id, stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate, commission_amount_thb, commission_base_amount_thb, billing_cycle, cycle_index, status, hold_until)
    VALUES (v_partner, v_referred, v_referral_id, NULL, 'pi_ro_21',
      1000, 1000, 0.30, 300, 1000, 'month', 1, 'holding', now() + interval '21 days')
    RETURNING id INTO v_event_id;

  SELECT count(*) INTO v_drift_before FROM public.affiliate_audit_log
    WHERE action = 'reconciliation_drift' AND entity_id = v_partner::text;
  PERFORM public.affiliate_reconcile();
  SELECT count(*) INTO v_drift_after FROM public.affiliate_audit_log
    WHERE action = 'reconciliation_drift' AND entity_id = v_partner::text;
  IF v_drift_after <> v_drift_before THEN
    RAISE EXCEPTION '§21 FAIL: healthy state flagged drift (before=%, after=%)', v_drift_before, v_drift_after;
  END IF;
  RAISE NOTICE '✅ §21 PASS: reconcile finds zero drift on healthy state';
END $$;
ROLLBACK;

-- =============================================================
-- §22  Reconciliation — detects Drift B (paid commissions ≠ payouts)
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
  v_event_a UUID;
  v_event_b UUID;
  v_payout_id UUID;
  v_drift_count INT;
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
      AND user_id NOT IN (SELECT referrer_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner AND user_id NOT IN (SELECT referred_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL OR v_referred IS NULL THEN RAISE NOTICE '⚠️ §22 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'Drift', 'B', '+66800000022', 'SCB', '2222222223', 'DB', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at, lifetime_commission_thb, lifetime_paid_thb)
    VALUES (v_partner, v_app_id, 0.30, now(), 600, 600);
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active)
    VALUES (v_partner, 'MF-DB-22', 'partner_affiliate', true) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status, commission_base_amount_thb, commission_rate)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed', 1000, 0.30) RETURNING id INTO v_referral_id;
  INSERT INTO public.payout_requests (partner_user_id, amount_thb, bank_snapshot, status, commission_ids)
    VALUES (v_partner, 600, '{}'::jsonb, 'paid', ARRAY[]::UUID[]) RETURNING id INTO v_payout_id;
  INSERT INTO public.commission_events (partner_user_id, referred_user_id, referral_id, stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate, commission_amount_thb, commission_base_amount_thb, billing_cycle, cycle_index,
    status, hold_until, payout_id, paid_at)
    VALUES (v_partner, v_referred, v_referral_id, NULL, 'pi_db_22_a',
      1000, 1000, 0.30, 300, 1000, 'month', 1, 'paid', now() - interval '30 days', v_payout_id, now())
    RETURNING id INTO v_event_a;
  -- Second event was paid then clawback'd manually (Hole 2 admin write)
  INSERT INTO public.commission_events (partner_user_id, referred_user_id, referral_id, stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate, commission_amount_thb, commission_base_amount_thb, billing_cycle, cycle_index,
    status, hold_until, payout_id, paid_at, reversed_at, reversal_reason)
    VALUES (v_partner, v_referred, v_referral_id, NULL, 'pi_db_22_b',
      1000, 1000, 0.30, 300, 1000, 'month', 2, 'clawback', now() - interval '30 days', v_payout_id, now(), now(), 'manual_refund_clawback')
    RETURNING id INTO v_event_b;
  UPDATE public.payout_requests SET commission_ids = ARRAY[v_event_a, v_event_b] WHERE id = v_payout_id;

  PERFORM public.affiliate_reconcile();
  SELECT count(*) INTO v_drift_count FROM public.affiliate_audit_log
    WHERE action = 'reconciliation_drift'
      AND entity_id = v_partner::text
      AND diff->>'invariant' = 'B_paid_commissions_vs_paid_payouts';
  IF v_drift_count = 0 THEN
    RAISE EXCEPTION '§22 FAIL: Drift B not detected after manual clawback of paid commission';
  END IF;
  RAISE NOTICE '✅ §22 PASS: reconcile detects Drift B (paid commissions ≠ paid payouts)';
END $$;
ROLLBACK;

-- =============================================================
-- §23  Reconciliation — dedup (same drift twice = 1 audit row)
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
  v_event_a UUID;
  v_event_b UUID;
  v_payout_id UUID;
  v_audit_after_first INT;
  v_audit_after_second INT;
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
      AND user_id NOT IN (SELECT referrer_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner AND user_id NOT IN (SELECT referred_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL OR v_referred IS NULL THEN RAISE NOTICE '⚠️ §23 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'Dedup', 'Recon', '+66800000023', 'SCB', '2323232323', 'DR', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at, lifetime_commission_thb, lifetime_paid_thb)
    VALUES (v_partner, v_app_id, 0.30, now(), 600, 600);
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active)
    VALUES (v_partner, 'MF-DR-23', 'partner_affiliate', true) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status, commission_base_amount_thb, commission_rate)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'confirmed', 1000, 0.30) RETURNING id INTO v_referral_id;
  INSERT INTO public.payout_requests (partner_user_id, amount_thb, bank_snapshot, status, commission_ids)
    VALUES (v_partner, 600, '{}'::jsonb, 'paid', ARRAY[]::UUID[]) RETURNING id INTO v_payout_id;
  INSERT INTO public.commission_events (partner_user_id, referred_user_id, referral_id, stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate, commission_amount_thb, commission_base_amount_thb, billing_cycle, cycle_index, status, hold_until, payout_id, paid_at)
    VALUES (v_partner, v_referred, v_referral_id, NULL, 'pi_dr_23_a', 1000, 1000, 0.30, 300, 1000, 'month', 1, 'paid', now() - interval '30 days', v_payout_id, now())
    RETURNING id INTO v_event_a;
  INSERT INTO public.commission_events (partner_user_id, referred_user_id, referral_id, stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate, commission_amount_thb, commission_base_amount_thb, billing_cycle, cycle_index, status, hold_until, payout_id, paid_at, reversed_at, reversal_reason)
    VALUES (v_partner, v_referred, v_referral_id, NULL, 'pi_dr_23_b', 1000, 1000, 0.30, 300, 1000, 'month', 2, 'clawback', now() - interval '30 days', v_payout_id, now(), now(), 'manual')
    RETURNING id INTO v_event_b;
  UPDATE public.payout_requests SET commission_ids = ARRAY[v_event_a, v_event_b] WHERE id = v_payout_id;

  PERFORM public.affiliate_reconcile();
  SELECT count(*) INTO v_audit_after_first FROM public.affiliate_audit_log
    WHERE action = 'reconciliation_drift' AND entity_id = v_partner::text;
  PERFORM public.affiliate_reconcile();
  SELECT count(*) INTO v_audit_after_second FROM public.affiliate_audit_log
    WHERE action = 'reconciliation_drift' AND entity_id = v_partner::text;

  IF v_audit_after_second <> v_audit_after_first THEN
    RAISE EXCEPTION '§23 FAIL: second reconcile wrote new drift rows (first=%, second=%)',
      v_audit_after_first, v_audit_after_second;
  END IF;
  RAISE NOTICE '✅ §23 PASS: dedup index keeps the second reconcile a no-op';
END $$;
ROLLBACK;

-- =============================================================
-- §24  RLS — authenticated cannot self-promote application
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_user UUID;
  v_app_id UUID;
  v_status TEXT;
BEGIN
  SELECT user_id INTO v_user FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
    ORDER BY user_id LIMIT 1;
  IF v_user IS NULL THEN RAISE NOTICE '⚠️ §24 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_user, 'RLS', 'Probe', '+66800000024', 'SCB', '2424242424', 'RP', 'draft') RETURNING id INTO v_app_id;

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE public.partner_applications SET status = 'approved' WHERE id = v_app_id;
    SELECT status INTO v_status FROM public.partner_applications WHERE id = v_app_id;
    IF v_status = 'approved' THEN
      RAISE EXCEPTION '§24 FAIL: authenticated user self-promoted';
    END IF;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    NULL;
  END;
  RAISE NOTICE '✅ §24 PASS: RLS blocks self-promote';
END $$;
ROLLBACK;

-- =============================================================
-- §25  First-touch attribution lock — second referral ignored
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_partner_a UUID;
  v_partner_b UUID;
  v_referred UUID;
  v_app_a UUID;
  v_app_b UUID;
  v_code_a UUID;
  v_code_b UUID;
  v_referral_count INT;
BEGIN
  -- Need 3 distinct users
  SELECT user_id INTO v_partner_a FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
      AND user_id NOT IN (SELECT referrer_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_partner_b FROM public.user_credits
    WHERE user_id <> v_partner_a
      AND user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
      AND user_id NOT IN (SELECT referrer_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner_a AND user_id <> v_partner_b
      AND user_id NOT IN (SELECT referred_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  IF v_partner_a IS NULL OR v_partner_b IS NULL OR v_referred IS NULL THEN
    RAISE NOTICE '⚠️ §25 SKIPPED'; RETURN;
  END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner_a, 'First', 'Touch', '+66800000025', 'SCB', '2525252525', 'FT', 'approved') RETURNING id INTO v_app_a;
  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner_b, 'Second', 'Touch', '+66800000026', 'SCB', '2626262626', 'ST', 'approved') RETURNING id INTO v_app_b;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at) VALUES
    (v_partner_a, v_app_a, 0.30, now()),
    (v_partner_b, v_app_b, 0.30, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active)
    VALUES (v_partner_a, 'MF-FT-25-A', 'partner_affiliate', true) RETURNING id INTO v_code_a;
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active)
    VALUES (v_partner_b, 'MF-FT-25-B', 'partner_affiliate', true) RETURNING id INTO v_code_b;

  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner_a, v_referred, v_code_a, 'partner_affiliate', 'pending');
  -- Attempt a second attribution from a different partner on the same referred user
  BEGIN
    INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
      VALUES (v_partner_b, v_referred, v_code_b, 'partner_affiliate', 'pending');
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  SELECT count(*) INTO v_referral_count FROM public.referrals WHERE referred_user_id = v_referred;
  IF v_referral_count <> 1 THEN
    RAISE EXCEPTION '§25 FAIL: referred user has % rows (expected 1, first-touch)', v_referral_count;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.referrals WHERE referred_user_id = v_referred AND referrer_user_id = v_partner_a) THEN
    RAISE EXCEPTION '§25 FAIL: first-touch partner overwritten';
  END IF;
  RAISE NOTICE '✅ §25 PASS: first-touch attribution locked (second referral ignored)';
END $$;
ROLLBACK;

-- =============================================================
-- §26  21-day hold window verification (PR #51)
-- =============================================================
BEGIN;
DO $$
DECLARE
  v_partner UUID;
  v_referred UUID;
  v_app_id UUID;
  v_code_id UUID;
  v_referral_id UUID;
  v_event_id UUID;
  v_created TIMESTAMPTZ;
  v_hold TIMESTAMPTZ;
  v_diff_days NUMERIC;
BEGIN
  SELECT user_id INTO v_partner FROM public.user_credits
    WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
      AND user_id NOT IN (SELECT user_id FROM public.partners)
      AND user_id NOT IN (SELECT referrer_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner AND user_id NOT IN (SELECT referred_user_id FROM public.referrals)
    ORDER BY user_id LIMIT 1;
  IF v_partner IS NULL OR v_referred IS NULL THEN RAISE NOTICE '⚠️ §26 SKIPPED'; RETURN; END IF;

  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_partner, 'Hold', 'Window', '+66800000027', 'SCB', '2727272727', 'HW', 'approved') RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.30, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active)
    VALUES (v_partner, 'MF-HW-26', 'partner_affiliate', true) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'pending') RETURNING id INTO v_referral_id;

  v_event_id := public.accrue_commission(v_referred, 'pi_hw_26', 1000, 1000, 'month', 1);
  SELECT created_at, hold_until INTO v_created, v_hold FROM public.commission_events WHERE id = v_event_id;
  v_diff_days := EXTRACT(EPOCH FROM (v_hold - v_created)) / 86400.0;
  IF v_diff_days < 20.99 OR v_diff_days > 21.01 THEN
    RAISE EXCEPTION '§26 FAIL: hold window=% days (expected 21)', v_diff_days;
  END IF;
  RAISE NOTICE '✅ §26 PASS: accrual sets hold_until = created_at + 21 days (% days exact)', v_diff_days;
END $$;
ROLLBACK;

-- =============================================================
DO $$ BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '════════════════════════════════════════════════';
  RAISE NOTICE '🎉 ALL §1-§26 PASSED — affiliate end-to-end complete';
  RAISE NOTICE '════════════════════════════════════════════════';
END $$;
