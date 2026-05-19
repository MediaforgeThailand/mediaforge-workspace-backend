-- Fix two related bugs in mark_payout_paid_v2 surfaced by the round-2 audit.
--
-- 1. ATOMICITY: the previous body flipped payout_requests.status='paid' BEFORE
--    flipping the linked commission_events. The commission UPDATE used a
--    `WHERE status = 'available'` filter, so if any commission had drifted
--    into 'clawback', 'holding', or 'paid' (race with another payout that
--    already grabbed the same commission, or a refund-during-payout-approval
--    sequence), payout_requests was marked 'paid' while some commissions
--    silently stayed in their wrong state. The function returned a
--    `commissions_paid` count that callers could ignore.
--
-- 2. MISSING payout_id BACKLINK: v1 functions (request_payout / mark_payout_paid)
--    set commission_events.payout_id = p_payout_id when flipping to paid, so
--    you could later trace which payout cleared which commission. The v2
--    function dropped that backlink — every paid commission has payout_id NULL,
--    making refund/clawback reconciliation against a paid payout impossible
--    without joining through payout_requests.commission_ids[] arrays.
--
-- Fix: flip the order, validate the flipped count, and write the backlink.
-- Same signature, same callers — no edge-function changes required.

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
BEGIN
  PERFORM 1 FROM public.payout_requests
    WHERE id = p_payout_id AND status = 'approved'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payout_not_approved';
  END IF;

  SELECT commission_ids INTO v_commission_ids
  FROM public.payout_requests
  WHERE id = p_payout_id;

  v_expected := COALESCE(array_length(v_commission_ids, 1), 0);

  -- Flip commissions FIRST + write the payout_id backlink. Anything not in
  -- 'available' state (clawback, holding, already-paid via a different
  -- payout) will not match, v_flipped < v_expected, and we abort.
  WITH upd AS (
    UPDATE public.commission_events
       SET status = 'paid',
           paid_at = now(),
           payout_id = p_payout_id
     WHERE id = ANY(v_commission_ids)
       AND status = 'available'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_flipped FROM upd;

  IF v_flipped <> v_expected THEN
    RAISE EXCEPTION 'commission_state_mismatch: % of % commissions were not in available state', v_flipped, v_expected;
  END IF;

  -- Only flip the payout request to 'paid' once every linked commission
  -- has been confirmed. A failure inside this UPDATE rolls back the
  -- commission flips above thanks to the implicit transaction.
  UPDATE public.payout_requests SET
    status         = 'paid',
    paid_at        = COALESCE(p_paid_at, now()),
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
