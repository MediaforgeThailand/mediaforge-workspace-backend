-- Structured payout transfer proof.
--
-- Keep this backward-compatible:
--   - historical rows in proof_url stay untouched
--   - new rows can store a slip URL, bank reference, or manual audit note
--   - proof_url remains as a legacy mirror so older admin/export screens do
--     not lose the operator-entered proof text

BEGIN;

ALTER TABLE public.payout_requests
  ADD COLUMN IF NOT EXISTS bank_reference TEXT,
  ADD COLUMN IF NOT EXISTS proof_type TEXT,
  ADD COLUMN IF NOT EXISTS proof_note TEXT;

UPDATE public.payout_requests
SET proof_type = CASE
  WHEN proof_type IS NOT NULL THEN proof_type
  WHEN proof_url IS NULL OR length(btrim(proof_url)) = 0 THEN NULL
  WHEN proof_url ~* '^https?://' THEN 'url'
  WHEN bank_reference IS NOT NULL AND length(btrim(bank_reference)) > 0 THEN 'bank_reference'
  ELSE 'legacy'
END
WHERE proof_type IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'payout_requests_proof_type_check'
      AND conrelid = 'public.payout_requests'::regclass
  ) THEN
    ALTER TABLE public.payout_requests
      ADD CONSTRAINT payout_requests_proof_type_check
      CHECK (
        proof_type IS NULL
        OR proof_type IN ('url', 'bank_reference', 'note', 'mixed', 'legacy')
      );
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.admin_settle_partner(uuid, uuid, text, numeric);

CREATE OR REPLACE FUNCTION public.admin_settle_partner(
  p_partner_user_id uuid,
  p_processor_id uuid,
  p_proof_url text DEFAULT NULL,
  p_expected_amount_thb numeric DEFAULT NULL,
  p_proof_type text DEFAULT NULL,
  p_bank_reference text DEFAULT NULL,
  p_proof_note text DEFAULT NULL
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
  v_proof_url text := NULLIF(btrim(COALESCE(p_proof_url, '')), '');
  v_bank_reference text := NULLIF(btrim(COALESCE(p_bank_reference, '')), '');
  v_proof_note text := NULLIF(btrim(COALESCE(p_proof_note, '')), '');
  v_proof_type text := lower(NULLIF(btrim(COALESCE(p_proof_type, '')), ''));
  v_legacy_proof text;
BEGIN
  IF p_partner_user_id IS NULL OR p_processor_id IS NULL THEN
    RAISE EXCEPTION 'missing_parameters';
  END IF;

  IF v_proof_type IS NULL THEN
    IF v_proof_url IS NOT NULL AND v_proof_url ~* '^https?://' THEN
      v_proof_type := 'url';
    ELSIF v_bank_reference IS NOT NULL THEN
      v_proof_type := 'bank_reference';
    ELSIF v_proof_note IS NOT NULL THEN
      v_proof_type := 'note';
    ELSIF v_proof_url IS NOT NULL THEN
      v_proof_type := 'legacy';
    END IF;
  END IF;

  IF v_proof_type NOT IN ('url', 'bank_reference', 'note', 'mixed', 'legacy') THEN
    RAISE EXCEPTION 'invalid_proof_type';
  END IF;

  IF v_proof_type = 'url'
     AND (v_proof_url IS NULL OR v_proof_url !~* '^https?://[^[:space:]]+$') THEN
    RAISE EXCEPTION 'invalid_proof_url';
  END IF;

  IF v_proof_type = 'bank_reference' AND v_bank_reference IS NULL THEN
    v_bank_reference := v_proof_url;
  END IF;

  IF v_proof_type = 'note' AND v_proof_note IS NULL THEN
    v_proof_note := v_proof_url;
  END IF;

  v_legacy_proof := COALESCE(v_proof_url, v_bank_reference, v_proof_note);
  IF v_legacy_proof IS NULL OR length(v_legacy_proof) < 3 THEN
    RAISE EXCEPTION 'missing_transfer_proof';
  END IF;

  SELECT p.user_id, p.suspended_at, COALESCE(p.lifetime_paid_thb, 0) AS lifetime_paid_thb
    INTO v_partner
  FROM public.partners p
  WHERE p.user_id = p_partner_user_id
  FOR UPDATE;

  IF v_partner.user_id IS NULL THEN
    RAISE EXCEPTION 'partner_not_found';
  END IF;
  IF v_partner.suspended_at IS NOT NULL THEN
    RAISE EXCEPTION 'partner_suspended';
  END IF;

  SELECT pa.bank_name, pa.bank_account_no, pa.bank_account_name
    INTO v_app
  FROM public.partner_applications pa
  WHERE pa.user_id = p_partner_user_id;

  IF v_app.bank_name IS NULL OR length(btrim(v_app.bank_name)) = 0
     OR v_app.bank_account_no IS NULL OR length(btrim(v_app.bank_account_no)) = 0
     OR v_app.bank_account_name IS NULL OR length(btrim(v_app.bank_account_name)) = 0 THEN
    RAISE EXCEPTION 'bank_details_incomplete';
  END IF;

  v_bank_snapshot := jsonb_build_object(
    'bank_name', v_app.bank_name,
    'bank_account_no', v_app.bank_account_no,
    'bank_account_name', v_app.bank_account_name,
    'snapshot_at', v_now
  );

  FOR v_event IN
    SELECT ce.id, ce.commission_amount_thb
    FROM public.commission_events ce
    WHERE ce.partner_user_id = p_partner_user_id
      AND ce.status = 'available'
      AND NOT EXISTS (
        SELECT 1 FROM public.payout_requests pr
        WHERE ce.id = ANY(pr.commission_ids)
          AND pr.status NOT IN ('failed','rejected','cancelled')
      )
    ORDER BY ce.created_at ASC
    FOR UPDATE
  LOOP
    v_commission_ids := array_append(v_commission_ids, v_event.id);
    v_total := v_total + v_event.commission_amount_thb;
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'nothing_to_settle: no available commissions for partner %', p_partner_user_id;
  END IF;

  IF p_expected_amount_thb IS NOT NULL
     AND ABS(v_total - p_expected_amount_thb) > 0.01 THEN
    RAISE EXCEPTION 'amount_changed: expected %, actual %', p_expected_amount_thb, v_total;
  END IF;

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
    proof_url,
    proof_type,
    proof_note,
    bank_reference
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
    v_legacy_proof,
    v_proof_type,
    v_proof_note,
    v_bank_reference
  )
  RETURNING id INTO v_payout_id;

  UPDATE public.commission_events ce
  SET status = 'paid',
      paid_at = v_now,
      payout_id = v_payout_id
  WHERE ce.id = ANY(v_commission_ids);

  UPDATE public.partners p
  SET lifetime_paid_thb = COALESCE(p.lifetime_paid_thb, 0) + v_total
  WHERE p.user_id = p_partner_user_id;

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
      'proof_type', v_proof_type,
      'proof_url', v_proof_url,
      'bank_reference', v_bank_reference,
      'proof_note', v_proof_note,
      'legacy_proof', v_legacy_proof,
      'expected_amount_thb', p_expected_amount_thb
    )
  );

  RETURN jsonb_build_object(
    'payout_id', v_payout_id,
    'amount_thb', v_total,
    'commission_count', v_count,
    'commission_ids', to_jsonb(v_commission_ids),
    'proof_type', v_proof_type,
    'status', 'paid'
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_settle_partner(uuid, uuid, text, numeric, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_settle_partner(uuid, uuid, text, numeric, text, text, text)
  TO service_role;

COMMIT;
