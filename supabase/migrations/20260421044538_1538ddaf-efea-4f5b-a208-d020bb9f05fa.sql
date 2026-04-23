-- ============================================================
-- Migration 1: Extend payout_requests schema
-- ============================================================
ALTER TABLE public.payout_requests
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS paid_by uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS rejection_reason text;

-- payout_requests uses requested_at (not created_at)
CREATE INDEX IF NOT EXISTS idx_payout_requests_status
  ON public.payout_requests(status, requested_at DESC);

-- ============================================================
-- Migration 2: v2 RPCs (service_role only, coexist with v1)
-- ============================================================

-- approve_payout_v2 -----------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_payout_v2(
  p_payout_id uuid,
  p_admin_id uuid,
  p_note text DEFAULT NULL
) RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM 1 FROM public.payout_requests
    WHERE id = p_payout_id AND status = 'pending'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payout_not_pending';
  END IF;

  UPDATE public.payout_requests SET
    status      = 'approved',
    approved_at = now(),
    approved_by = p_admin_id,
    notes       = COALESCE(p_note, notes)
  WHERE id = p_payout_id;

  RETURN jsonb_build_object('status','approved','payout_id', p_payout_id);
END;
$$;

-- mark_payout_paid_v2 ---------------------------------------------
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

  UPDATE public.payout_requests SET
    status         = 'paid',
    paid_at        = COALESCE(p_paid_at, now()),
    bank_reference = p_bank_ref,
    paid_by        = p_admin_id
  WHERE id = p_payout_id;

  WITH upd AS (
    UPDATE public.commission_events
       SET status = 'paid', paid_at = now()
     WHERE id = ANY(v_commission_ids)
       AND status = 'available'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_flipped FROM upd;

  RETURN jsonb_build_object(
    'status','paid',
    'payout_id', p_payout_id,
    'commissions_paid', v_flipped
  );
END;
$$;

-- reject_payout_v2 ------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_payout_v2(
  p_payout_id uuid,
  p_admin_id uuid,
  p_reason text
) RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM 1 FROM public.payout_requests
    WHERE id = p_payout_id AND status IN ('pending','approved')
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payout_not_rejectable';
  END IF;

  UPDATE public.payout_requests SET
    status            = 'rejected',
    rejected_at       = now(),
    rejected_by       = p_admin_id,
    rejection_reason  = p_reason
  WHERE id = p_payout_id;

  RETURN jsonb_build_object('status','rejected','payout_id', p_payout_id);
END;
$$;

-- ============================================================
-- Migration 3: Permissions (service_role only for all v2)
-- ============================================================
REVOKE ALL ON FUNCTION public.approve_payout_v2(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.approve_payout_v2(uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.mark_payout_paid_v2(uuid, uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.mark_payout_paid_v2(uuid, uuid, text, timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.reject_payout_v2(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reject_payout_v2(uuid, uuid, text) TO service_role;