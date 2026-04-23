-- ── 1. Schema additions to payout_requests ─────────────────────────
ALTER TABLE public.payout_requests
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS bank_reference TEXT,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Allow 'approved' status
ALTER TABLE public.payout_requests DROP CONSTRAINT IF EXISTS payout_requests_status_check;
ALTER TABLE public.payout_requests ADD CONSTRAINT payout_requests_status_check
  CHECK (status IN ('pending','approved','processing','paid','failed','rejected','cancelled'));

CREATE INDEX IF NOT EXISTS idx_payout_requests_partner_status ON public.payout_requests(partner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_payout_requests_status_requested ON public.payout_requests(status, requested_at);

-- ── 2. RLS: allow admins full access ───────────────────────────────
DROP POLICY IF EXISTS "admins_manage_payouts" ON public.payout_requests;
CREATE POLICY "admins_manage_payouts" ON public.payout_requests
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- ── 3. RPC: request_payout ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.request_payout(
  p_amount_thb NUMERIC,
  p_bank_snapshot JSONB
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_partner_user_id UUID := auth.uid();
  v_available NUMERIC;
  v_payout_id UUID;
  v_picked_ids UUID[];
  v_picked_total NUMERIC := 0;
  v_event RECORD;
BEGIN
  IF v_partner_user_id IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;

  -- Verify partner is active
  IF NOT EXISTS (SELECT 1 FROM partners WHERE user_id = v_partner_user_id AND suspended_at IS NULL) THEN
    RAISE EXCEPTION 'partner_not_active';
  END IF;

  IF p_amount_thb < 500 THEN
    RAISE EXCEPTION 'below_minimum_threshold: 500 THB';
  END IF;

  -- Available = released ('available') events not already linked to a non-failed/rejected/cancelled payout
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

  -- Pick oldest commissions FIFO until we cover p_amount_thb (collect IDs first)
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

  INSERT INTO payout_requests (partner_user_id, amount_thb, bank_snapshot, status, commission_ids)
  VALUES (v_partner_user_id, p_amount_thb, p_bank_snapshot, 'pending', v_picked_ids)
  RETURNING id INTO v_payout_id;

  RETURN v_payout_id;
END; $$;

-- ── 4. RPC: approve_payout (admin) ────────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_payout(p_payout_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  UPDATE payout_requests
  SET status = 'approved', approved_at = now(), approved_by = auth.uid()
  WHERE id = p_payout_id AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payout_not_pending_or_not_found';
  END IF;
END; $$;

-- ── 5. RPC: mark_payout_paid (admin) ──────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_payout_paid(
  p_payout_id UUID,
  p_bank_reference TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_partner_user_id UUID;
  v_amount NUMERIC;
  v_commission_ids UUID[];
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  -- Lock + fetch
  SELECT partner_user_id, amount_thb, commission_ids
    INTO v_partner_user_id, v_amount, v_commission_ids
  FROM payout_requests
  WHERE id = p_payout_id AND status = 'approved'
  FOR UPDATE;

  IF v_partner_user_id IS NULL THEN
    RAISE EXCEPTION 'payout_not_approved_or_not_found';
  END IF;

  -- Mark payout paid
  UPDATE payout_requests
  SET status = 'paid', processed_at = now(), processed_by = auth.uid(), bank_reference = p_bank_reference
  WHERE id = p_payout_id;

  -- Flip linked commission events to 'paid'
  UPDATE commission_events
  SET status = 'paid', paid_at = now(), payout_id = p_payout_id
  WHERE id = ANY(v_commission_ids);

  -- Update partner lifetime paid
  UPDATE partners
  SET lifetime_paid_thb = COALESCE(lifetime_paid_thb, 0) + v_amount
  WHERE user_id = v_partner_user_id;
END; $$;

-- ── 6. RPC: reject_payout (admin) ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.reject_payout(
  p_payout_id UUID,
  p_reason TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  UPDATE payout_requests
  SET status = 'rejected',
      processed_by = auth.uid(),
      processed_at = now(),
      rejection_reason = p_reason,
      commission_ids = ARRAY[]::UUID[]  -- unlink so events are eligible again
  WHERE id = p_payout_id AND status IN ('pending','approved');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payout_not_rejectable_or_not_found';
  END IF;
END; $$;

GRANT EXECUTE ON FUNCTION public.request_payout(NUMERIC, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_payout(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_payout_paid(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_payout(UUID, TEXT) TO authenticated;

-- ── 7. pg_cron: daily commission release at 02:00 UTC ─────────────
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  PERFORM cron.unschedule('release-commissions-daily');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'release-commissions-daily',
  '0 2 * * *',
  $$ SELECT public.release_commission(); $$
);