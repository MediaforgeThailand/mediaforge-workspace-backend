-- Affiliate reconciliation: detect drift between the partner-level totals
-- (partners.lifetime_paid_thb / lifetime_commission_thb) and the underlying
-- transactional truth (payout_requests + commission_events).
--
-- Why this exists:
--   Code review at every level can miss bugs in financial state machines.
--   Phase-2 fixes added atomic RPCs and tighter FKs, but a future regression
--   (or a manual SQL fix gone wrong) can still corrupt the partner-level
--   counters. This cron is the runtime safety net: if review misses a bug,
--   reconciliation catches it within 24 hours and writes to
--   affiliate_audit_log so the admin team sees the drift.
--
-- Six invariants (rounded to 2 decimal THB, drift threshold > 0.01):
--   Partner-level (entity_type='partner'):
--     A. partners.lifetime_paid_thb == SUM(payout_requests.amount_thb
--        WHERE status='paid' AND partner_user_id = X)
--     B. SUM(commission_events.commission_amount_thb WHERE status='paid' AND partner_user_id = X)
--        == SUM(payout_requests.amount_thb WHERE status='paid' AND partner_user_id = X)
--     C. partners.lifetime_commission_thb == SUM(commission_events.commission_amount_thb
--        WHERE status IN ('holding','available','paid') AND partner_user_id = X)
--        — i.e., everything that hasn't been clawed back or voided.
--   Payout-level (entity_type='payout'):
--     D. payout_requests.amount_thb == SUM(commission_events.commission_amount_thb
--        WHERE id = ANY(commission_ids)) for each paid payout.
--   Commission-level — attribution & locked-base correctness (entity_type='commission_event'):
--     E. For each commission_event ce: the referrals row pointed to by
--        ce.referral_id must have (referrer_user_id, referred_user_id) ==
--        (ce.partner_user_id, ce.referred_user_id). Catches attribution
--        corruption — commission credited to the wrong partner — which the
--        A/B/C/D invariants would not detect because per-partner totals
--        still self-balance even when attribution is wrong.
--     G. For each commission_event ce where its referrals row has
--        commission_base_amount_thb IS NOT NULL: ce.commission_base_amount_thb
--        must equal r.commission_base_amount_thb. Enforces the "lock the
--        first-paid amount" semantic the affiliate program is built on —
--        if anyone (a future bug, a manual SQL fix) wrote a per-event base
--        that diverges from the referral's locked value, this catches it.
--
-- A drift writes a row to affiliate_audit_log with action='reconciliation_drift',
-- the appropriate entity_type/entity_id, and a diff payload that names the
-- invariant, expected, actual, and signed delta. No data is mutated.

CREATE OR REPLACE FUNCTION public.affiliate_reconcile()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_drift_count integer := 0;
  v_sum_paid_payouts numeric;
  v_sum_paid_commissions numeric;
  v_sum_active_commissions numeric;
  v_stored_paid numeric;
  v_stored_commission numeric;
BEGIN
  FOR r IN
    SELECT user_id, COALESCE(lifetime_paid_thb, 0)::numeric AS stored_paid,
                    COALESCE(lifetime_commission_thb, 0)::numeric AS stored_commission
    FROM public.partners
  LOOP
    v_stored_paid := ROUND(r.stored_paid, 2);
    v_stored_commission := ROUND(r.stored_commission, 2);

    SELECT COALESCE(SUM(amount_thb), 0)::numeric
      INTO v_sum_paid_payouts
    FROM public.payout_requests
    WHERE partner_user_id = r.user_id
      AND status = 'paid';

    SELECT COALESCE(SUM(commission_amount_thb), 0)::numeric
      INTO v_sum_paid_commissions
    FROM public.commission_events
    WHERE partner_user_id = r.user_id
      AND status = 'paid';

    SELECT COALESCE(SUM(commission_amount_thb), 0)::numeric
      INTO v_sum_active_commissions
    FROM public.commission_events
    WHERE partner_user_id = r.user_id
      AND status IN ('holding','available','paid');

    v_sum_paid_payouts := ROUND(v_sum_paid_payouts, 2);
    v_sum_paid_commissions := ROUND(v_sum_paid_commissions, 2);
    v_sum_active_commissions := ROUND(v_sum_active_commissions, 2);

    -- Invariant A: lifetime_paid_thb == sum of paid payouts
    IF ABS(v_stored_paid - v_sum_paid_payouts) > 0.01 THEN
      INSERT INTO public.affiliate_audit_log (actor_id, action, entity_type, entity_id, diff)
      VALUES (
        NULL,
        'reconciliation_drift',
        'partner',
        r.user_id::text,
        jsonb_build_object(
          'invariant', 'A_lifetime_paid_vs_paid_payouts',
          'partner_user_id', r.user_id,
          'expected', v_sum_paid_payouts,
          'actual', v_stored_paid,
          'delta', v_stored_paid - v_sum_paid_payouts
        )
      );
      v_drift_count := v_drift_count + 1;
    END IF;

    -- Invariant B: paid commissions == paid payouts (per partner)
    IF ABS(v_sum_paid_commissions - v_sum_paid_payouts) > 0.01 THEN
      INSERT INTO public.affiliate_audit_log (actor_id, action, entity_type, entity_id, diff)
      VALUES (
        NULL,
        'reconciliation_drift',
        'partner',
        r.user_id::text,
        jsonb_build_object(
          'invariant', 'B_paid_commissions_vs_paid_payouts',
          'partner_user_id', r.user_id,
          'expected', v_sum_paid_payouts,
          'actual', v_sum_paid_commissions,
          'delta', v_sum_paid_commissions - v_sum_paid_payouts
        )
      );
      v_drift_count := v_drift_count + 1;
    END IF;

    -- Invariant C: lifetime_commission_thb == sum of non-reversed commissions
    IF ABS(v_stored_commission - v_sum_active_commissions) > 0.01 THEN
      INSERT INTO public.affiliate_audit_log (actor_id, action, entity_type, entity_id, diff)
      VALUES (
        NULL,
        'reconciliation_drift',
        'partner',
        r.user_id::text,
        jsonb_build_object(
          'invariant', 'C_lifetime_commission_vs_active_commissions',
          'partner_user_id', r.user_id,
          'expected', v_sum_active_commissions,
          'actual', v_stored_commission,
          'delta', v_stored_commission - v_sum_active_commissions
        )
      );
      v_drift_count := v_drift_count + 1;
    END IF;
  END LOOP;

  -- Invariants E + G: per commission_event attribution and locked-base.
  -- One pass over commission_events joined to its referrals row.
  FOR r IN
    SELECT ce.id AS event_id,
           ce.partner_user_id     AS ce_partner,
           ce.referred_user_id    AS ce_referred,
           ce.referral_id,
           ce.commission_base_amount_thb AS ce_base,
           ref.referrer_user_id   AS ref_partner,
           ref.referred_user_id   AS ref_referred,
           ref.commission_base_amount_thb AS ref_base
    FROM public.commission_events ce
    JOIN public.referrals ref ON ref.id = ce.referral_id
  LOOP
    -- Invariant E: attribution match (partner + referred customer)
    IF r.ce_partner IS DISTINCT FROM r.ref_partner
       OR r.ce_referred IS DISTINCT FROM r.ref_referred THEN
      INSERT INTO public.affiliate_audit_log (actor_id, action, entity_type, entity_id, diff)
      VALUES (
        NULL,
        'reconciliation_drift',
        'commission_event',
        r.event_id::text,
        jsonb_build_object(
          'invariant', 'E_attribution_mismatch',
          'event_id', r.event_id,
          'referral_id', r.referral_id,
          'expected_partner_user_id', r.ref_partner,
          'actual_partner_user_id', r.ce_partner,
          'expected_referred_user_id', r.ref_referred,
          'actual_referred_user_id', r.ce_referred
        )
      );
      v_drift_count := v_drift_count + 1;
    END IF;

    -- Invariant G: locked-base preserved. Only check when the referral has
    -- been locked (ref_base IS NOT NULL); skip legacy events from before
    -- the v2 migration that have ce_base IS NULL.
    IF r.ref_base IS NOT NULL
       AND r.ce_base IS NOT NULL
       AND ABS(ROUND(r.ce_base, 2) - ROUND(r.ref_base, 2)) > 0.01 THEN
      INSERT INTO public.affiliate_audit_log (actor_id, action, entity_type, entity_id, diff)
      VALUES (
        NULL,
        'reconciliation_drift',
        'commission_event',
        r.event_id::text,
        jsonb_build_object(
          'invariant', 'G_locked_base_mismatch',
          'event_id', r.event_id,
          'referral_id', r.referral_id,
          'expected', ROUND(r.ref_base, 2),
          'actual', ROUND(r.ce_base, 2),
          'delta', ROUND(r.ce_base - r.ref_base, 2)
        )
      );
      v_drift_count := v_drift_count + 1;
    END IF;
  END LOOP;

  -- Invariant D: per-paid-payout integrity — each payout's amount_thb must
  -- equal the sum of its commission_ids' commission_amount_thb. Aggregate
  -- invariant B can be fooled by two opposite-direction per-payout errors
  -- cancelling out; D pins the drift to the specific payout row.
  --
  -- We sum across all matching commission_events regardless of current
  -- status — the integrity check is "what was paid out matches what the
  -- payout was built from", not "what's the current status of those
  -- commissions". A clawback after payout is a separate event.
  FOR r IN
    SELECT pr.id AS payout_id,
           pr.partner_user_id,
           pr.amount_thb,
           pr.commission_ids,
           COALESCE((
             SELECT SUM(ce.commission_amount_thb)
             FROM public.commission_events ce
             WHERE ce.id = ANY(pr.commission_ids)
           ), 0) AS commissions_sum
    FROM public.payout_requests pr
    WHERE pr.status = 'paid'
  LOOP
    IF ABS(ROUND(r.amount_thb, 2) - ROUND(r.commissions_sum, 2)) > 0.01 THEN
      INSERT INTO public.affiliate_audit_log (actor_id, action, entity_type, entity_id, diff)
      VALUES (
        NULL,
        'reconciliation_drift',
        'payout',
        r.payout_id::text,
        jsonb_build_object(
          'invariant', 'D_per_payout_integrity',
          'payout_id', r.payout_id,
          'partner_user_id', r.partner_user_id,
          'expected', ROUND(r.commissions_sum, 2),
          'actual', ROUND(r.amount_thb, 2),
          'delta', ROUND(r.amount_thb - r.commissions_sum, 2)
        )
      );
      v_drift_count := v_drift_count + 1;
    END IF;
  END LOOP;

  RETURN v_drift_count;
END;
$$;

COMMENT ON FUNCTION public.affiliate_reconcile() IS
  'Daily reconciliation of partner-level totals against transactional truth. Drifts logged to affiliate_audit_log as reconciliation_drift; no data mutated.';

REVOKE ALL ON FUNCTION public.affiliate_reconcile() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.affiliate_reconcile() TO service_role;

-- Schedule daily at 03:00 UTC — after release-commissions-daily (02:00) and
-- fraud-detection-velocity-daily (02:30), so the data the cron snapshots has
-- already been promoted holding → available.
DO $$ BEGIN
  PERFORM cron.unschedule('affiliate-reconcile-daily');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'affiliate-reconcile-daily',
  '0 3 * * *',
  $$ SELECT public.affiliate_reconcile(); $$
);
