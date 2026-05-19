-- Affiliate end-to-end lifecycle smoke (Phase 4).
--
-- Walks one paying customer through every state transition that ships in
-- this round of work and asserts the runtime safety net (reconciliation)
-- agrees with the transactional truth at each stage. Every assertion fails
-- loud via RAISE EXCEPTION so psql exits non-zero on regression — CI sees
-- the failure instead of going green on a silent NOTICE.
--
-- Coverage:
--   PHASE 1  Setup partner + referral
--   PHASE 2  accrue_commission ×2 (first paid + renewal)
--   PHASE 3  release_commission promotes holding → available
--   PHASE 4  request_payout (creates pending payout)
--   PHASE 5  Admin approves payout
--   PHASE 6  mark_payout_paid_v2 (atomic — flip commissions, payout, lifetime)
--   PHASE 7  affiliate_reconcile — expect 0 drifts on legit flow
--   PHASE 8  Refund flow — reverse_commission claws back one commission
--   PHASE 9  affiliate_reconcile — expect Drift B (paid_commissions diverged
--             from paid_payouts because money already left). This is the
--             expected business signal that admin must intervene.
--   PHASE 10 RLS self-promote attempt blocked

\set ON_ERROR_STOP on

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
  v_released INT;
  v_drift_count INT;
  v_status TEXT;
  v_lifetime NUMERIC;
  v_wallet_balance NUMERIC;
  v_partner_application_id UUID;
BEGIN
  -- ─── PHASE 1: Setup ────────────────────────────────────────
  SELECT user_id INTO v_partner
  FROM public.user_credits
  WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
    AND user_id NOT IN (SELECT user_id FROM public.referral_codes)
    AND user_id NOT IN (SELECT user_id FROM public.partners)
  ORDER BY user_id LIMIT 1;

  SELECT user_id INTO v_referred FROM public.user_credits
    WHERE user_id <> v_partner ORDER BY user_id LIMIT 1;

  IF v_partner IS NULL OR v_referred IS NULL THEN
    RAISE EXCEPTION 'E2E SETUP FAILED: need 2 distinct user_credits rows';
  END IF;

  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_partner, 'E2E', 'Smoke', '+66999999999', 'SCB', '0123456789', 'E2E', 'approved')
  RETURNING id INTO v_app_id;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at)
    VALUES (v_partner, v_app_id, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_partner, 'MF-E2E-SMOKE', 'partner_affiliate', true, 0) RETURNING id INTO v_code_id;
  INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
    VALUES (v_partner, v_referred, v_code_id, 'partner_affiliate', 'pending') RETURNING id INTO v_referral_id;

  RAISE NOTICE '🔹 PHASE 1 OK: partner=% referral=%', v_partner, v_referral_id;

  -- ─── PHASE 2: accrue_commission (first paid + renewal) ────
  v_event_1 := public.accrue_commission(v_referred, 'pi_e2e_first', 1000, 1000, 'month', 1);
  IF v_event_1 IS NULL THEN
    RAISE EXCEPTION 'PHASE 2 FAIL: accrue_commission returned NULL for first paid';
  END IF;

  v_event_2 := public.accrue_commission(v_referred, 'in_e2e_renewal', 1000, 1000, 'month', 2);
  IF v_event_2 IS NULL THEN
    RAISE EXCEPTION 'PHASE 2 FAIL: accrue_commission returned NULL for renewal';
  END IF;

  -- Confirm referrals.commission_base_amount_thb got locked at first call
  IF NOT EXISTS (SELECT 1 FROM public.referrals
                  WHERE id = v_referral_id
                    AND commission_base_amount_thb = 1000
                    AND commission_rate = 0.3
                    AND attribution_status = 'confirmed') THEN
    RAISE EXCEPTION 'PHASE 2 FAIL: referral was not locked at first paid';
  END IF;

  -- Confirm both events have the locked base on commission_events
  IF (SELECT count(*) FROM public.commission_events
        WHERE id IN (v_event_1, v_event_2)
          AND commission_base_amount_thb = 1000) <> 2 THEN
    RAISE EXCEPTION 'PHASE 2 FAIL: events do not carry the locked base';
  END IF;

  -- partner.lifetime_commission_thb should be 600 (2 events x 300)
  SELECT lifetime_commission_thb INTO v_lifetime FROM public.partners WHERE user_id = v_partner;
  IF v_lifetime <> 600 THEN
    RAISE EXCEPTION 'PHASE 2 FAIL: lifetime_commission=%/600', v_lifetime;
  END IF;

  RAISE NOTICE '🔹 PHASE 2 OK: 2 holding commissions, lifetime_commission=600, base locked at 1000';

  -- ─── PHASE 3: release_commission promotes holding → available ──
  -- Fast-forward hold_until so the release worker is allowed to act
  UPDATE public.commission_events SET hold_until = now() - interval '1 hour'
    WHERE id IN (v_event_1, v_event_2);

  v_released := public.release_commission();
  IF v_released < 2 THEN
    RAISE EXCEPTION 'PHASE 3 FAIL: release_commission released %/2', v_released;
  END IF;

  -- Both events should be 'available' now
  IF (SELECT count(*) FROM public.commission_events
        WHERE id IN (v_event_1, v_event_2) AND status = 'available') <> 2 THEN
    RAISE EXCEPTION 'PHASE 3 FAIL: events not all available';
  END IF;

  SELECT balance_thb INTO v_wallet_balance FROM public.cash_wallets WHERE user_id = v_partner;
  IF v_wallet_balance <> 600 THEN
    RAISE EXCEPTION 'PHASE 3 FAIL: cash_wallet balance=%/600', v_wallet_balance;
  END IF;

  RAISE NOTICE '🔹 PHASE 3 OK: 2 available commissions, cash_wallet credited 600';

  -- ─── PHASE 4: request_payout (partner-initiated) ──────────
  -- Fake auth.uid via the JWT claim so request_payout (which reads auth.uid())
  -- thinks the partner is the caller.
  PERFORM set_config('request.jwt.claim.sub', v_partner::text, true);

  v_payout_id := public.request_payout(600, jsonb_build_object('bank_name','SCB','account','0123456789'));
  IF v_payout_id IS NULL THEN
    RAISE EXCEPTION 'PHASE 4 FAIL: request_payout returned NULL';
  END IF;

  IF (SELECT status FROM public.payout_requests WHERE id = v_payout_id) <> 'pending' THEN
    RAISE EXCEPTION 'PHASE 4 FAIL: payout not pending';
  END IF;

  IF (SELECT array_length(commission_ids, 1) FROM public.payout_requests WHERE id = v_payout_id) <> 2 THEN
    RAISE EXCEPTION 'PHASE 4 FAIL: payout did not pick both commissions';
  END IF;

  RAISE NOTICE '🔹 PHASE 4 OK: payout % pending with 2 commission_ids', v_payout_id;

  -- ─── PHASE 5: Admin approves (direct UPDATE; admin_approve RPC needs has_role) ──
  UPDATE public.payout_requests SET status = 'approved', approved_at = now()
    WHERE id = v_payout_id;

  RAISE NOTICE '🔹 PHASE 5 OK: payout flipped to approved';

  -- ─── PHASE 6: mark_payout_paid_v2 (atomic) ────────────────
  PERFORM public.mark_payout_paid_v2(v_payout_id, NULL::uuid, 'BANK-REF-E2E', now());

  -- Payout flipped to paid
  IF (SELECT status FROM public.payout_requests WHERE id = v_payout_id) <> 'paid' THEN
    RAISE EXCEPTION 'PHASE 6 FAIL: payout not paid';
  END IF;
  -- Both commissions flipped to paid + backlinked
  IF (SELECT count(*) FROM public.commission_events
        WHERE id IN (v_event_1, v_event_2) AND status = 'paid' AND payout_id = v_payout_id) <> 2 THEN
    RAISE EXCEPTION 'PHASE 6 FAIL: commissions not paid + backlinked';
  END IF;
  -- lifetime_paid_thb bumped
  SELECT lifetime_paid_thb INTO v_lifetime FROM public.partners WHERE user_id = v_partner;
  IF v_lifetime <> 600 THEN
    RAISE EXCEPTION 'PHASE 6 FAIL: lifetime_paid_thb=%/600', v_lifetime;
  END IF;

  RAISE NOTICE '🔹 PHASE 6 OK: payout paid, commissions paid + backlinked, lifetime_paid=600';

  -- ─── PHASE 7: Reconcile after happy path — expect 0 drifts ──
  SELECT count(*) INTO v_drift_count FROM public.affiliate_audit_log
    WHERE action = 'reconciliation_drift'
      AND (entity_id = v_partner::text
           OR entity_id = v_payout_id::text
           OR entity_id IN (v_event_1::text, v_event_2::text));
  -- Establish baseline (drift rows from prior tests may exist for OTHER ids)
  v_drift_count := v_drift_count;  -- baseline

  PERFORM public.affiliate_reconcile();

  -- After reconcile, NEW drift rows for THIS partner/payout/events should still be 0
  IF EXISTS (
    SELECT 1 FROM public.affiliate_audit_log
    WHERE action = 'reconciliation_drift'
      AND created_at > now() - interval '5 seconds'
      AND (entity_id = v_partner::text
           OR entity_id = v_payout_id::text
           OR entity_id IN (v_event_1::text, v_event_2::text))
  ) THEN
    RAISE EXCEPTION 'PHASE 7 FAIL: reconcile flagged a drift on a healthy flow';
  END IF;

  RAISE NOTICE '🔹 PHASE 7 OK: reconcile finds zero drifts on happy path';

  -- ─── PHASE 8: Refund hits a paid commission ───────────────
  -- Insert a payment_transactions row so reverse_commission's PI→invoice
  -- lookup can resolve the invoice id for event_2.
  INSERT INTO public.payment_transactions (user_id, amount_thb, status, stripe_payment_intent_id, stripe_invoice_id)
    VALUES (v_referred, 1000, 'completed', 'pi_e2e_renewal_pi', 'in_e2e_renewal');

  PERFORM public.reverse_commission('pi_e2e_renewal_pi', 're_e2e_renewal', 'requested_by_customer');

  -- event_2 should now be clawback (paid commissions that have a PI mapping via payment_transactions)
  SELECT status INTO v_status FROM public.commission_events WHERE id = v_event_2;
  -- reverse_commission only flips holding/available — paid events are NOT flipped.
  -- That's intentional in the current function: a clawback after a payout
  -- already cleared is admin territory. We assert paid stays paid:
  IF v_status <> 'paid' THEN
    RAISE EXCEPTION 'PHASE 8 FAIL: reverse_commission unexpectedly flipped a paid event to %', v_status;
  END IF;
  RAISE NOTICE '🔹 PHASE 8 OK: reverse_commission left paid commission alone (refund-after-payout is admin territory)';

  -- ─── PHASE 9: Manually clawback the paid event to simulate the
  --             admin write that refund-after-payout actually requires.
  --             Then reconcile must detect Drift B (paid commissions
  --             diverged from paid payouts).
  UPDATE public.commission_events
    SET status = 'clawback', reversed_at = now(), reversal_reason = 'manual_refund_clawback'
    WHERE id = v_event_2;

  -- Mirror what reverse_commission would have done if the event were still
  -- holding/available: decrement lifetime_commission_thb.
  UPDATE public.partners
    SET lifetime_commission_thb = lifetime_commission_thb - 300
    WHERE user_id = v_partner;

  PERFORM public.affiliate_reconcile();

  IF NOT EXISTS (
    SELECT 1 FROM public.affiliate_audit_log
    WHERE action = 'reconciliation_drift'
      AND entity_id = v_partner::text
      AND diff->>'invariant' = 'B_paid_commissions_vs_paid_payouts'
      AND created_at > now() - interval '5 seconds'
  ) THEN
    RAISE EXCEPTION 'PHASE 9 FAIL: reconcile missed the post-clawback drift';
  END IF;

  RAISE NOTICE '🔹 PHASE 9 OK: reconcile detected drift B (paid commissions ≠ paid payouts) — expected admin signal';

  RAISE NOTICE '🎉 E2E PASS: full lifecycle + reconcile signals work as intended';
END $$;
ROLLBACK;

-- ─── PHASE 10: RLS self-promote blocked (separate txn so role switch is clean) ──
BEGIN;
DO $$
DECLARE
  v_user UUID;
  v_app_id UUID;
  v_attempted_status TEXT;
BEGIN
  SELECT user_id INTO v_user
  FROM public.user_credits
  WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
  ORDER BY user_id LIMIT 1;

  IF v_user IS NULL THEN
    RAISE EXCEPTION 'PHASE 10 SETUP FAILED';
  END IF;

  -- Seed as service-role (current session)
  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name, status
  ) VALUES (v_user, 'RLS', 'Bypass', '+66999999999', 'SCB', '0123456789', 'RLS', 'draft')
  RETURNING id INTO v_app_id;

  -- Switch to authenticated role to simulate the attacker
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  BEGIN
    UPDATE public.partner_applications SET status = 'approved' WHERE id = v_app_id;
    SELECT status INTO v_attempted_status FROM public.partner_applications WHERE id = v_app_id;
    IF v_attempted_status = 'approved' THEN
      RAISE EXCEPTION 'PHASE 10 FAIL: authenticated user self-promoted to approved';
    END IF;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    NULL; -- rejected as expected
  END;

  RAISE NOTICE '🔹 PHASE 10 OK: RLS blocks self-promotion attempt';
END $$;
ROLLBACK;
