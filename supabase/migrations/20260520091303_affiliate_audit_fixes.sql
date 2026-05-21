-- Affiliate system hardening (audit 2026-05-20)
-- Covers findings C1, C2, C3, C4, I2, I3 from the audit report.

-- ─────────────────────────────────────────────────────────────────────────
-- C4: debug_* RPCs were callable via anon role because the guard inside
-- them only ran when auth.uid() IS NOT NULL. Anyone holding the public
-- ANON_KEY (which is shipped in the frontend bundle) could call them and
-- prematurely release every partner's holding commissions, or mint
-- attribution. REVOKE so PostgREST refuses the call before it reaches
-- the function body. service_role still has access (admin tooling).
-- ─────────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.debug_create_test_referral(uuid, text, uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.debug_fast_forward_commissions(uuid, uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.debug_commission_timeline(uuid) FROM anon, authenticated, PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- C3: payout_requests INSERT RLS was effectively open — any authenticated
-- user could insert a row with status='paid', any amount, any
-- commission_ids (as long as partner_user_id matched their own uid).
-- Force users through request_payout() and only allow inserts in the
-- canonical initial state.
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS own_payouts_insert ON public.payout_requests;
CREATE POLICY own_payouts_insert ON public.payout_requests
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = partner_user_id
    AND status = 'pending'
    AND amount_thb >= 500
    AND bank_snapshot IS NOT NULL
  );

-- ─────────────────────────────────────────────────────────────────────────
-- C1: request_payout previously stored amount_thb = p_amount_thb (user's
-- request) but commission_ids could sum to more, because the FIFO pick
-- loop EXITs when v_picked_total >= p_amount_thb. mark_payout_paid then
-- flipped every commission in the array to 'paid' — paying the partner
-- p_amount_thb but marking v_picked_total worth as paid. The delta
-- vanished: stuck at status='paid' with no actual transfer, and the
-- partner can never re-request it.
-- Fix: store the actual picked total as amount_thb. UI must show the
-- snapped amount in the confirmation.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.request_payout(p_amount_thb integer, p_bank_snapshot jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_partner_user_id UUID := auth.uid();
  v_available NUMERIC;
  v_payout_id UUID;
  v_picked_ids UUID[];
  v_picked_total NUMERIC := 0;
  v_event RECORD;
  v_bank_name TEXT;
  v_bank_account_no TEXT;
BEGIN
  IF v_partner_user_id IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM partners WHERE user_id = v_partner_user_id AND suspended_at IS NULL) THEN
    RAISE EXCEPTION 'partner_not_active';
  END IF;

  SELECT bank_name, bank_account_no
    INTO v_bank_name, v_bank_account_no
  FROM partner_applications
  WHERE user_id = v_partner_user_id;

  IF v_bank_name IS NULL OR length(btrim(v_bank_name)) = 0
     OR v_bank_account_no IS NULL OR length(btrim(v_bank_account_no)) = 0
     OR lower(btrim(v_bank_account_no)) = 'pending'
     OR lower(btrim(v_bank_name)) = 'pending' THEN
    RAISE EXCEPTION 'bank_details_incomplete';
  END IF;

  IF p_amount_thb < 500 THEN
    RAISE EXCEPTION 'below_minimum_threshold: 500 THB';
  END IF;

  SELECT COALESCE(SUM(commission_amount_thb), 0) INTO v_available
  FROM commission_events ce
  WHERE ce.partner_user_id = v_partner_user_id
    AND ce.status = 'available'
    AND NOT EXISTS (
      SELECT 1 FROM payout_requests pr
      WHERE ce.id = ANY(pr.commission_ids)
        AND pr.status NOT IN ('failed','rejected','cancelled')
    );

  IF v_available < p_amount_thb THEN
    RAISE EXCEPTION 'insufficient_balance: available=%, requested=%', v_available, p_amount_thb;
  END IF;

  v_picked_ids := ARRAY[]::UUID[];
  FOR v_event IN
    SELECT id, commission_amount_thb
    FROM commission_events
    WHERE partner_user_id = v_partner_user_id
      AND status = 'available'
      AND NOT EXISTS (
        SELECT 1 FROM payout_requests pr
        WHERE id = ANY(pr.commission_ids)
          AND pr.status NOT IN ('failed','rejected','cancelled')
      )
    ORDER BY created_at ASC
  LOOP
    v_picked_ids := array_append(v_picked_ids, v_event.id);
    v_picked_total := v_picked_total + v_event.commission_amount_thb;
    EXIT WHEN v_picked_total >= p_amount_thb;
  END LOOP;

  -- amount_thb = actual picked total (NUMERIC), not the user's requested
  -- integer. Commissions are indivisible; snapping up keeps the payout in
  -- sync with the set of commission_ids that will be flipped to 'paid'.
  INSERT INTO payout_requests (partner_user_id, amount_thb, bank_snapshot, status, commission_ids)
  VALUES (v_partner_user_id, v_picked_total, p_bank_snapshot, 'pending', v_picked_ids)
  RETURNING id INTO v_payout_id;

  RETURN v_payout_id;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- C2 + I2: mark_payout_paid in erp-affiliate-bridge was 4 sequential HTTP
-- calls (payout flip → commission flip → lifetime_paid_thb read-modify-
-- write → audit). The read-modify-write on partners.lifetime_paid_thb is
-- not atomic and loses updates when two admins concurrently mark payouts
-- for the same partner. Crashes between steps also leave partial state.
-- Consolidate into a single SECURITY DEFINER RPC executed in one
-- transaction with FOR UPDATE on the payout row.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.process_payout_paid(
  p_payout_id uuid,
  p_processor_id uuid,
  p_proof_url text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payout RECORD;
  v_now timestamptz := now();
  v_flipped_count int := 0;
  v_expected_count int;
BEGIN
  IF p_payout_id IS NULL OR p_processor_id IS NULL OR p_proof_url IS NULL
     OR length(btrim(p_proof_url)) = 0 THEN
    RAISE EXCEPTION 'missing_parameters';
  END IF;

  SELECT * INTO v_payout
  FROM public.payout_requests
  WHERE id = p_payout_id
  FOR UPDATE;

  IF v_payout.id IS NULL THEN
    RAISE EXCEPTION 'payout_not_found';
  END IF;

  IF v_payout.status = 'paid' THEN
    RAISE EXCEPTION 'already_paid';
  END IF;

  -- Terminal states. `cancelled` is set by reverse_commission when a
  -- Stripe refund clawbacks one of this payout's commissions — paying
  -- would send creator money for revenue MediaForge has already
  -- refunded to the customer.
  IF v_payout.status IN ('cancelled', 'failed', 'rejected') THEN
    RAISE EXCEPTION 'cannot_pay_terminal: status=%', v_payout.status;
  END IF;

  -- Step 1: payout flip
  UPDATE public.payout_requests SET
    status = 'paid',
    processed_by = p_processor_id,
    processed_at = v_now,
    paid_by = p_processor_id,
    paid_at = v_now,
    proof_url = p_proof_url
  WHERE id = p_payout_id;

  -- Step 2: commission flip with rowcount guard. Filter by 'available'
  -- so a concurrent reverse_commission that flipped one to 'clawback'
  -- causes the count mismatch → RAISE rolls back the whole transaction.
  v_expected_count := COALESCE(cardinality(v_payout.commission_ids), 0);
  IF v_expected_count > 0 THEN
    WITH upd AS (
      UPDATE public.commission_events
      SET status = 'paid', paid_at = v_now, payout_id = p_payout_id
      WHERE id = ANY(v_payout.commission_ids) AND status = 'available'
      RETURNING 1
    )
    SELECT COUNT(*) INTO v_flipped_count FROM upd;

    IF v_flipped_count <> v_expected_count THEN
      RAISE EXCEPTION 'commission_state_changed: expected % available, found % (likely concurrent refund)',
        v_expected_count, v_flipped_count;
    END IF;
  END IF;

  -- Step 3: atomic increment of lifetime_paid_thb. Single SQL expression
  -- so concurrent admin actions on different payouts of the same
  -- partner can't lose-update each other.
  UPDATE public.partners
  SET lifetime_paid_thb = COALESCE(lifetime_paid_thb, 0) + v_payout.amount_thb
  WHERE user_id = v_payout.partner_user_id;

  -- Step 4: audit log
  INSERT INTO public.affiliate_audit_log (actor_id, action, entity_type, entity_id, diff)
  VALUES (
    p_processor_id,
    'mark_payout_paid',
    'payout_request',
    p_payout_id::text,
    jsonb_build_object(
      'amount_thb', v_payout.amount_thb,
      'proof_url', p_proof_url,
      'commission_ids', to_jsonb(v_payout.commission_ids),
      'commissions_flipped', v_flipped_count,
      'atomic_rpc', true
    )
  );

  RETURN jsonb_build_object(
    'id', p_payout_id,
    'status', 'paid',
    'amount_thb', v_payout.amount_thb,
    'commissions_flipped', v_flipped_count
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.process_payout_paid(uuid, uuid, text) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_payout_paid(uuid, uuid, text) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- I3: refund_commission (legacy single-commission refund) used status
-- 'refunded' while reverse_commission uses 'clawback', causing dashboards
-- that filter on status to give inconsistent counts. No edge function
-- calls it (grep confirmed). Drop.
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.refund_commission(uuid);
