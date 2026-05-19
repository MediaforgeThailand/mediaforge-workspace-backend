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
-- Three invariants per partner (rounded to 2 decimal THB, drift threshold > 0.01):
--   A. partners.lifetime_paid_thb == SUM(payout_requests.amount_thb
--      WHERE status='paid' AND partner_user_id = X)
--   B. SUM(commission_events.commission_amount_thb WHERE status='paid' AND partner_user_id = X)
--      == SUM(payout_requests.amount_thb WHERE status='paid' AND partner_user_id = X)
--   C. partners.lifetime_commission_thb == SUM(commission_events.commission_amount_thb
--      WHERE status IN ('holding','available','paid') AND partner_user_id = X)
--      — i.e., everything that hasn't been clawed back or voided.
--
-- A drift writes a row to affiliate_audit_log with action='reconciliation_drift',
-- entity_type='partner', entity_id=user_id, and a diff payload that names the
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
