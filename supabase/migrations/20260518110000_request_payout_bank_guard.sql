-- Block payout requests when the partner's bank info is missing or
-- still a placeholder. Defense-in-depth alongside the admin function
-- fix that stops 'Pending' from being written in the first place.

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
  v_bank_name TEXT;
  v_bank_account_no TEXT;
BEGIN
  IF v_partner_user_id IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;

  -- Verify partner is active
  IF NOT EXISTS (SELECT 1 FROM partners WHERE user_id = v_partner_user_id AND suspended_at IS NULL) THEN
    RAISE EXCEPTION 'partner_not_active';
  END IF;

  -- Verify the partner's KYC bank info is real, not a placeholder.
  -- A row should always exist because the partner only reaches "active"
  -- after partner_applications was approved.
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

COMMENT ON FUNCTION public.request_payout(NUMERIC, JSONB) IS
  'Partner-facing payout request. Rejects when the partner_applications bank fields are empty or still contain the legacy "Pending" placeholder admin tooling used to write before 2026-05-18.';
