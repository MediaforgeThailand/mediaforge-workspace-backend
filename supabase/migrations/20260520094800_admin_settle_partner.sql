-- Admin-driven manual payout flow (2026-05-20)
--
-- Business model: creators do NOT request payouts. Admin views per-partner
-- available balance, transfers manually via bank, then clicks "Paid" — a
-- single atomic action that creates the payout_request row AND marks it
-- paid AND flips commission_events AND increments lifetime_paid_thb.
--
-- Replaces the prior 2-step (request_payout by creator → mark_payout_paid
-- by admin) flow. The request_payout RPC is left in place but orphaned —
-- no edge function calls it now.

-- ─────────────────────────────────────────────────────────────────────────
-- DROP creator-side INSERT policy. Admin INSERTs go via service_role
-- through the bridge so they bypass RLS anyway. Removing the user-side
-- policy prevents a future regression where a re-enabled creator flow
-- accidentally bypasses validation.
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS own_payouts_insert ON public.payout_requests;

-- ─────────────────────────────────────────────────────────────────────────
-- admin_settle_partner: one-click "creator was paid" recording.
--
-- Atomically:
--   1. Locks partner row + validates active.
--   2. Locks all status='available' commissions for the partner.
--   3. Optional expected-amount guard (catches race: a new commission
--      released between admin viewing the dashboard and clicking pay).
--   4. Snapshots bank info from partner_applications.
--   5. INSERTs payout_requests with status='paid' directly.
--   6. Flips commission_events status='paid' + payout_id.
--   7. Increments partners.lifetime_paid_thb.
--   8. Audit log.
--
-- Returns jsonb {payout_id, amount_thb, commission_count, commission_ids}.
--
-- p_expected_amount_thb is optional. If passed and doesn't match the
-- actual sum, RAISE so the admin can refresh and retry. Pass NULL to
-- skip the check (admin has accepted whatever is available right now).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_settle_partner(
  p_partner_user_id uuid,
  p_processor_id uuid,
  p_proof_url text,
  p_expected_amount_thb numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := now();
  v_partner RECORD;
  v_app RECORD;
  v_commission_ids uuid[] := ARRAY[]::uuid[];
  v_total numeric := 0;
  v_count int := 0;
  v_event RECORD;
  v_payout_id uuid;
  v_bank_snapshot jsonb;
BEGIN
  IF p_partner_user_id IS NULL OR p_processor_id IS NULL OR p_proof_url IS NULL
     OR length(btrim(p_proof_url)) = 0 THEN
    RAISE EXCEPTION 'missing_parameters';
  END IF;

  -- Lock partner row.
  SELECT user_id, suspended_at, COALESCE(lifetime_paid_thb, 0) AS lifetime_paid_thb
    INTO v_partner
  FROM public.partners
  WHERE user_id = p_partner_user_id
  FOR UPDATE;

  IF v_partner.user_id IS NULL THEN
    RAISE EXCEPTION 'partner_not_found';
  END IF;
  IF v_partner.suspended_at IS NOT NULL THEN
    RAISE EXCEPTION 'partner_suspended';
  END IF;

  -- Snapshot bank info at time of payment. partner_applications row is
  -- guaranteed to exist for an approved partner.
  SELECT bank_name, bank_account_no, bank_account_name
    INTO v_app
  FROM public.partner_applications
  WHERE user_id = p_partner_user_id;

  IF v_app.bank_name IS NULL OR length(btrim(v_app.bank_name)) = 0
     OR v_app.bank_account_no IS NULL OR length(btrim(v_app.bank_account_no)) = 0 THEN
    RAISE EXCEPTION 'bank_details_incomplete';
  END IF;

  v_bank_snapshot := jsonb_build_object(
    'bank_name', v_app.bank_name,
    'bank_account_no', v_app.bank_account_no,
    'bank_account_name', v_app.bank_account_name,
    'snapshot_at', v_now
  );

  -- Lock all available commissions for this partner that are not already
  -- tied to a non-terminal payout. SKIP LOCKED would let another concurrent
  -- settle steal half — we want strict serialisation.
  FOR v_event IN
    SELECT id, commission_amount_thb
    FROM public.commission_events
    WHERE partner_user_id = p_partner_user_id
      AND status = 'available'
      AND NOT EXISTS (
        SELECT 1 FROM public.payout_requests pr
        WHERE id = ANY(pr.commission_ids)
          AND pr.status NOT IN ('failed','rejected','cancelled')
      )
    ORDER BY created_at ASC
    FOR UPDATE
  LOOP
    v_commission_ids := array_append(v_commission_ids, v_event.id);
    v_total := v_total + v_event.commission_amount_thb;
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'nothing_to_settle: no available commissions for partner %', p_partner_user_id;
  END IF;

  -- Optional optimistic-concurrency guard. If admin saw 1290 on the
  -- dashboard but a new commission released between view and click,
  -- v_total is now 1580 ≠ 1290 → refuse so admin can re-confirm.
  IF p_expected_amount_thb IS NOT NULL
     AND ABS(v_total - p_expected_amount_thb) > 0.01 THEN
    RAISE EXCEPTION 'amount_changed: expected %, actual %', p_expected_amount_thb, v_total;
  END IF;

  -- INSERT payout_request directly in 'paid' state. requested_at = paid_at
  -- because there's no separate "request" event in this flow.
  INSERT INTO public.payout_requests (
    partner_user_id,
    amount_thb,
    bank_snapshot,
    status,
    commission_ids,
    requested_at,
    approved_by,
    approved_at,
    processed_by,
    processed_at,
    paid_by,
    paid_at,
    proof_url
  ) VALUES (
    p_partner_user_id,
    v_total,
    v_bank_snapshot,
    'paid',
    v_commission_ids,
    v_now,
    p_processor_id,
    v_now,
    p_processor_id,
    v_now,
    p_processor_id,
    v_now,
    p_proof_url
  )
  RETURNING id INTO v_payout_id;

  -- Flip commissions to paid. No rowcount guard needed because we held
  -- FOR UPDATE locks above — another tx couldn't have changed them.
  UPDATE public.commission_events
  SET status = 'paid',
      paid_at = v_now,
      payout_id = v_payout_id
  WHERE id = ANY(v_commission_ids);

  -- Atomic increment of lifetime_paid_thb. The FOR UPDATE on partners
  -- above already serialised concurrent settles for the same partner.
  UPDATE public.partners
  SET lifetime_paid_thb = COALESCE(lifetime_paid_thb, 0) + v_total
  WHERE user_id = p_partner_user_id;

  INSERT INTO public.affiliate_audit_log (actor_id, action, entity_type, entity_id, diff)
  VALUES (
    p_processor_id,
    'admin_settle_partner',
    'payout_request',
    v_payout_id::text,
    jsonb_build_object(
      'partner_user_id', p_partner_user_id,
      'amount_thb', v_total,
      'commission_count', v_count,
      'commission_ids', to_jsonb(v_commission_ids),
      'proof_url', p_proof_url,
      'expected_amount_thb', p_expected_amount_thb
    )
  );

  RETURN jsonb_build_object(
    'payout_id', v_payout_id,
    'amount_thb', v_total,
    'commission_count', v_count,
    'commission_ids', to_jsonb(v_commission_ids),
    'status', 'paid'
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_settle_partner(uuid, uuid, text, numeric) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_settle_partner(uuid, uuid, text, numeric) TO service_role;
