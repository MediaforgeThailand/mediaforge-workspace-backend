-- Fix multiple bugs in mark_payout_paid_v2 surfaced by the round-2 audit
-- (+ review-round corrections).
--
-- 1. ATOMICITY: the previous body flipped payout_requests.status='paid' BEFORE
--    flipping the linked commission_events. The commission UPDATE used a
--    `WHERE status = 'available'` filter, so if any commission had drifted
--    into 'clawback', 'holding', or 'paid' (race with another payout that
--    already grabbed the same commission, or a refund-during-payout-approval
--    sequence), payout_requests was marked 'paid' while some commissions
--    silently stayed in their wrong state.
--
-- 2. MISSING payout_id BACKLINK: v1 functions set commission_events.payout_id
--    when flipping to paid; v2 dropped that. We restore it.
--
-- 3. EMPTY commission_ids ARRAY: array_length([], 1) returns NULL, so
--    COALESCE → 0, and 0=0 matched, letting an empty-array payout flip to
--    'paid' with no commissions moved. That's a corruption signal we should
--    reject loudly.
--
-- 4. CONCURRENT REFUND RACE: a parallel reverse_commission only matches
--    status IN ('holding','available') — if mark_payout_paid_v2 commits
--    first, the refund silently no-ops (paid commission is unreachable to
--    clawback). Lock the commission rows FOR UPDATE before flipping so a
--    concurrent reverse_commission either waits (then sees 'paid' and
--    misses, which is the original bug we're tracking under the refund-on-
--    paid follow-up) or wins the lock and clawbacks first (then this
--    function sees 'clawback' and aborts with the v_flipped check).
--
-- 5. BACKDATING: original v2 accepted any p_paid_at, letting a compromised
--    service-role caller backdate a payout into a prior reporting window.
--    Bound p_paid_at within [now - 30 days, now + 1 minute].
--
-- Same signature, same callers.

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

  -- Accept any non-terminal payable state. The original strict
  -- `status = 'approved'` check would reject pending/processing payouts —
  -- but the current ERP workflow goes pending → processing → paid
  -- without an intermediate 'approved' transition. Cancelled/failed/
  -- rejected/paid stay rejected (terminal or already-handled states).
  PERFORM 1 FROM public.payout_requests
    WHERE id = p_payout_id
      AND status IN ('pending', 'approved', 'processing')
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payout_not_in_payable_state';
  END IF;

  SELECT commission_ids INTO v_commission_ids
  FROM public.payout_requests
  WHERE id = p_payout_id;

  v_expected := COALESCE(array_length(v_commission_ids, 1), 0);

  IF v_expected = 0 THEN
    RAISE EXCEPTION 'payout_has_no_commissions';
  END IF;

  -- Lock the commission rows first to serialise against a concurrent
  -- reverse_commission. Anything not in 'available' (clawback, holding,
  -- already-paid via a different payout) will not match v_expected and we
  -- abort, leaving the underlying state untouched by way of the txn rollback.
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

  RETURN jsonb_build_object(
    'status','paid',
    'payout_id', p_payout_id,
    'commissions_paid', v_flipped
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mark_payout_paid_v2(uuid, uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.mark_payout_paid_v2(uuid, uuid, text, timestamptz) TO service_role;
