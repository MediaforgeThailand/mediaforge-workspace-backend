-- ── 1. Add audit columns to payout_requests ────────────────────
ALTER TABLE public.payout_requests
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID,
  ADD COLUMN IF NOT EXISTS bank_reference TEXT,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  ALTER TABLE public.payout_requests DROP CONSTRAINT IF EXISTS payout_requests_status_check;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

ALTER TABLE public.payout_requests
  ADD CONSTRAINT payout_requests_status_check
  CHECK (status IN ('pending','approved','processing','paid','rejected','cancelled','failed'));

-- ── 2. RPCs ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.request_payout(
  p_amount_thb INTEGER,
  p_bank_snapshot JSONB
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_partner_user_id UUID := auth.uid();
  v_picked_ids UUID[] := ARRAY[]::UUID[];
  v_picked_total NUMERIC := 0;
  v_event RECORD;
  v_payout_id UUID;
  v_available NUMERIC;
BEGIN
  IF v_partner_user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF p_amount_thb < 500 THEN
    RAISE EXCEPTION 'below_minimum_threshold: 500 THB';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.partners WHERE user_id = v_partner_user_id AND suspended_at IS NULL) THEN
    RAISE EXCEPTION 'not_an_active_partner';
  END IF;

  SELECT COALESCE(SUM(commission_amount_thb), 0) INTO v_available
  FROM public.commission_events ce
  WHERE ce.partner_user_id = v_partner_user_id
    AND ce.status = 'available'
    AND NOT EXISTS (
      SELECT 1 FROM public.payout_requests pr
      WHERE ce.id = ANY(pr.commission_ids)
        AND pr.status NOT IN ('failed','rejected','cancelled')
    );

  IF v_available < p_amount_thb THEN
    RAISE EXCEPTION 'insufficient_balance: available=%, requested=%', v_available, p_amount_thb;
  END IF;

  FOR v_event IN
    SELECT id, commission_amount_thb FROM public.commission_events ce
    WHERE ce.partner_user_id = v_partner_user_id
      AND ce.status = 'available'
      AND NOT EXISTS (
        SELECT 1 FROM public.payout_requests pr
        WHERE ce.id = ANY(pr.commission_ids)
          AND pr.status NOT IN ('failed','rejected','cancelled')
      )
    ORDER BY created_at ASC
  LOOP
    v_picked_ids := array_append(v_picked_ids, v_event.id);
    v_picked_total := v_picked_total + v_event.commission_amount_thb;
    EXIT WHEN v_picked_total >= p_amount_thb;
  END LOOP;

  INSERT INTO public.payout_requests (
    partner_user_id, amount_thb, status, commission_ids, bank_snapshot
  ) VALUES (
    v_partner_user_id, p_amount_thb, 'pending', v_picked_ids, p_bank_snapshot
  ) RETURNING id INTO v_payout_id;

  RETURN v_payout_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_payout(p_payout_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'forbidden_admin_only';
  END IF;
  UPDATE public.payout_requests
  SET status = 'approved', approved_at = now(), approved_by = auth.uid()
  WHERE id = p_payout_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'payout_not_pending_or_not_found'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_payout_paid(p_payout_id UUID, p_bank_reference TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_partner_user_id UUID;
  v_amount NUMERIC;
  v_commission_ids UUID[];
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'forbidden_admin_only';
  END IF;

  UPDATE public.payout_requests
  SET status = 'paid', processed_at = now(), processed_by = auth.uid(), bank_reference = p_bank_reference
  WHERE id = p_payout_id AND status = 'approved'
  RETURNING partner_user_id, amount_thb, commission_ids
  INTO v_partner_user_id, v_amount, v_commission_ids;

  IF v_partner_user_id IS NULL THEN
    RAISE EXCEPTION 'payout_not_approved_or_not_found';
  END IF;

  UPDATE public.commission_events
  SET status = 'paid', paid_at = now(), payout_id = p_payout_id
  WHERE id = ANY(v_commission_ids);

  UPDATE public.partners
  SET lifetime_paid_thb = COALESCE(lifetime_paid_thb, 0) + v_amount
  WHERE user_id = v_partner_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_payout(p_payout_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'forbidden_admin_only';
  END IF;
  UPDATE public.payout_requests
  SET status = 'rejected', processed_at = now(), processed_by = auth.uid(), rejection_reason = p_reason
  WHERE id = p_payout_id AND status IN ('pending','approved');
  IF NOT FOUND THEN RAISE EXCEPTION 'payout_not_pending_or_not_found'; END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.request_payout(INTEGER, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_payout(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_payout_paid(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_payout(UUID, TEXT) TO authenticated;

-- RLS
DO $$ BEGIN
  ALTER TABLE public.payout_requests ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DROP POLICY IF EXISTS "partners_read_own_payouts" ON public.payout_requests;
CREATE POLICY "partners_read_own_payouts" ON public.payout_requests
  FOR SELECT TO authenticated USING (auth.uid() = partner_user_id);

DROP POLICY IF EXISTS "admins_manage_payouts" ON public.payout_requests;
CREATE POLICY "admins_manage_payouts" ON public.payout_requests
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

-- Cron
DO $$ BEGIN
  PERFORM cron.unschedule('release-commissions-daily');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'release-commissions-daily',
  '0 2 * * *',
  $$ SELECT public.release_commission(); $$
);