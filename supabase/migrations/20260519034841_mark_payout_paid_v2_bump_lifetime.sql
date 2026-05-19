-- Round-2 audit + review follow-up: also bump partner.lifetime_paid_thb
-- inside mark_payout_paid_v2 so the ERP bridge can drop its
-- read-modify-write.
--
-- Builds on 20260519032918_mark_payout_paid_v2_atomic.sql (PR #40) — this
-- migration is a complete CREATE OR REPLACE that preserves every guard
-- introduced there (empty-array reject, FOR UPDATE on commission rows,
-- p_paid_at bound, payout_id backlink) and adds the lifetime increment.
-- Applying this migration alone on top of vanilla main produces the
-- fully-correct function; applying it after #40 is a no-op-on-everything-
-- except-lifetime.
--
-- The bridge currently SELECTs lifetime_paid_thb, adds amount_thb in JS,
-- UPDATEs — a classic read-modify-write that loses an update under
-- concurrent calls. Moving the increment into this SECURITY DEFINER
-- function as a single UPDATE makes it atomic.

CREATE OR REPLACE FUNCTION public.mark_payout_paid_v2(
  p_payout_id uuid,
  p_admin_id uuid,
  p_bank_ref text,
  p_paid_at timestamptz DEFAULT NULL
) RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_partner_user_id uuid;
  v_amount_thb numeric;
  v_commission_ids uuid[];
  v_expected int;
  v_flipped int;
  v_effective_paid_at timestamptz;
BEGIN
  v_effective_paid_at := COALESCE(p_paid_at, now());
  IF v_effective_paid_at > now() + interval '1 minute'
     OR v_effective_paid_at < now() - interval '30 days' THEN
    RAISE EXCEPTION 'paid_at_out_of_range: % is outside [now-30d, now+1m]', v_effective_paid_at;
  END IF;

  PERFORM 1 FROM public.payout_requests
    WHERE id = p_payout_id AND status = 'approved'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payout_not_approved';
  END IF;

  SELECT partner_user_id, amount_thb, commission_ids
    INTO v_partner_user_id, v_amount_thb, v_commission_ids
  FROM public.payout_requests
  WHERE id = p_payout_id;

  v_expected := COALESCE(array_length(v_commission_ids, 1), 0);

  IF v_expected = 0 THEN
    RAISE EXCEPTION 'payout_has_no_commissions';
  END IF;

  PERFORM 1
  FROM public.commission_events
  WHERE id = ANY(v_commission_ids)
  FOR UPDATE;

  WITH upd AS (
    UPDATE public.commission_events
       SET status = 'paid',
           paid_at = v_effective_paid_at,
           payout_id = p_payout_id
     WHERE id = ANY(v_commission_ids)
       AND status = 'available'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_flipped FROM upd;

  IF v_flipped <> v_expected THEN
    RAISE EXCEPTION 'commission_state_mismatch: % of % commissions were not in available state', v_flipped, v_expected;
  END IF;

  UPDATE public.payout_requests SET
    status         = 'paid',
    paid_at        = v_effective_paid_at,
    bank_reference = p_bank_ref,
    paid_by        = p_admin_id
  WHERE id = p_payout_id;

  -- Atomic single-statement bump — concurrent payouts for the same partner
  -- cannot lose an update at the row level.
  UPDATE public.partners
     SET lifetime_paid_thb = COALESCE(lifetime_paid_thb, 0) + COALESCE(v_amount_thb, 0)
   WHERE user_id = v_partner_user_id;

  -- Debit the partner's cash wallet by the payout amount. release_commission
  -- credited the wallet when each commission moved from holding → available;
  -- reverse_commission debits on clawback. Mark-as-paid was the missing
  -- counterpart — without this UPDATE the wallet `balance_thb` keeps
  -- showing money that has already left to the partner's bank, and
  -- invariant H (added in the reconciliation cron) fires.
  --
  -- Use GREATEST(_, 0) defensive floor so we never go negative; a clawback
  -- post-release on the same partner could otherwise underflow.
  UPDATE public.cash_wallets
     SET balance_thb = GREATEST(COALESCE(balance_thb, 0) - COALESCE(v_amount_thb, 0), 0),
         updated_at = now()
   WHERE user_id = v_partner_user_id;

  -- Ledger entry so the wallet history shows the debit, not just the new
  -- balance. tx_type='payout_debit' is already in the CHECK list per
  -- migration 20260422105243.
  INSERT INTO public.cash_wallet_transactions (
    user_id, amount_thb, tx_type, reference_id, note
  ) VALUES (
    v_partner_user_id,
    -COALESCE(v_amount_thb, 0),
    'payout_debit',
    p_payout_id::text,
    'Payout paid out — bank ref ' || COALESCE(p_bank_ref, '(none)')
  );

  RETURN jsonb_build_object(
    'status','paid',
    'payout_id', p_payout_id,
    'commissions_paid', v_flipped,
    'lifetime_paid_thb_delta', v_amount_thb,
    'wallet_debit_thb', v_amount_thb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mark_payout_paid_v2(uuid, uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.mark_payout_paid_v2(uuid, uuid, text, timestamptz) TO service_role;
