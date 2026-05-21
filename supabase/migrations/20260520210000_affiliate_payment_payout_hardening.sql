-- Affiliate payment/payout hardening (2026-05-20)
--
-- This is a corrective migration for functions that may already exist on
-- preview/prod. Keep it additive: redefine SECURITY DEFINER functions in
-- their final form and tighten grants instead of editing historical files.

BEGIN;

ALTER TABLE public.payout_requests
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

-- ─────────────────────────────────────────────────────────────────────────
-- Idempotent credit grants
-- ─────────────────────────────────────────────────────────────────────────
-- Stripe can retry the same paid event. The webhook already pre-checks, but
-- the database operation itself must be idempotent under concurrent delivery.
-- The per-user advisory lock serialises all grants for the same wallet; the
-- reference guard then makes repeated paid events no-op safely.
CREATE OR REPLACE FUNCTION public.grant_credits(
  p_user_id uuid,
  p_amount integer,
  p_source_type text DEFAULT 'cashback'::text,
  p_expiry_days integer DEFAULT 90,
  p_description text DEFAULT 'Credit grant'::text,
  p_reference_id text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_lock_key bigint;
  v_new_balance integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Grant user is required';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Grant amount must be positive';
  END IF;

  IF p_amount > 5000000 THEN
    RAISE EXCEPTION 'Grant amount exceeds safety limit (5,000,000)';
  END IF;

  v_lock_key := ('x' || left(replace(p_user_id::text, '-', ''), 15))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  IF p_reference_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.credit_batches cb
    WHERE cb.user_id = p_user_id
      AND cb.source_type = p_source_type
      AND cb.reference_id = p_reference_id
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.credit_batches (user_id, amount, remaining, source_type, reference_id, expires_at)
  VALUES (
    p_user_id,
    p_amount,
    p_amount,
    p_source_type,
    p_reference_id,
    now() + make_interval(days => p_expiry_days)
  );

  INSERT INTO public.user_credits (user_id, balance, total_purchased, updated_at)
  VALUES (p_user_id, p_amount, 0, now())
  ON CONFLICT (user_id) DO UPDATE
  SET balance = COALESCE(user_credits.balance, 0) + EXCLUDED.balance,
      updated_at = now();

  SELECT balance INTO v_new_balance
  FROM public.user_credits
  WHERE user_id = p_user_id;

  INSERT INTO public.credit_transactions (user_id, amount, type, feature, description, reference_id, balance_after)
  VALUES (
    p_user_id,
    p_amount,
    p_source_type,
    'credit_grant',
    p_description,
    p_reference_id,
    COALESCE(v_new_balance, 0)
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.grant_credits(uuid, integer, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_credits(uuid, integer, text, integer, text, text) TO service_role;

-- Paid grants need the same once-only guard, while also counting toward the
-- wallet's purchased total. Keep it separate from grant_credits because
-- cashback/manual/bonus grants should not all inflate total_purchased.
CREATE OR REPLACE FUNCTION public.grant_purchased_credits_once(
  p_user_id uuid,
  p_amount integer,
  p_source_type text DEFAULT 'purchase'::text,
  p_expiry_days integer DEFAULT 90,
  p_description text DEFAULT 'Purchased credits'::text,
  p_reference_id text DEFAULT NULL::text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_lock_key bigint;
  v_new_balance integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Grant user is required';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Grant amount must be positive';
  END IF;

  IF p_amount > 5000000 THEN
    RAISE EXCEPTION 'Grant amount exceeds safety limit (5,000,000)';
  END IF;

  v_lock_key := ('x' || left(replace(p_user_id::text, '-', ''), 15))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  IF p_reference_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.credit_batches cb
    WHERE cb.user_id = p_user_id
      AND cb.source_type = p_source_type
      AND cb.reference_id = p_reference_id
  ) THEN
    RETURN false;
  END IF;

  INSERT INTO public.credit_batches (user_id, amount, remaining, source_type, reference_id, expires_at)
  VALUES (
    p_user_id,
    p_amount,
    p_amount,
    p_source_type,
    p_reference_id,
    now() + make_interval(days => p_expiry_days)
  );

  INSERT INTO public.user_credits (user_id, balance, total_purchased, updated_at)
  VALUES (p_user_id, p_amount, p_amount, now())
  ON CONFLICT (user_id) DO UPDATE
  SET balance = COALESCE(user_credits.balance, 0) + EXCLUDED.balance,
      total_purchased = COALESCE(user_credits.total_purchased, 0) + EXCLUDED.total_purchased,
      updated_at = now();

  SELECT balance INTO v_new_balance
  FROM public.user_credits
  WHERE user_id = p_user_id;

  INSERT INTO public.credit_transactions (user_id, amount, type, feature, description, reference_id, balance_after)
  VALUES (
    p_user_id,
    p_amount,
    p_source_type,
    'credit_grant',
    p_description,
    p_reference_id,
    COALESCE(v_new_balance, 0)
  );

  RETURN true;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.grant_purchased_credits_once(uuid, integer, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_purchased_credits_once(uuid, integer, text, integer, text, text) TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_completed_session_uniq
  ON public.payment_transactions (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL AND status = 'completed';

CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_completed_intent_uniq
  ON public.payment_transactions (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL AND status = 'completed';

-- ─────────────────────────────────────────────────────────────────────────
-- Reverse commission: qualify payout columns to avoid PL/pgSQL ambiguity
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reverse_commission(
  p_payment_intent_id TEXT,
  p_refund_id TEXT,
  p_reason TEXT DEFAULT 'stripe_refund'
)
RETURNS TABLE(commission_event_id UUID, partner_user_id UUID, reversed_amount_thb NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_event RECORD;
  v_lock_key BIGINT;
  v_invoice_id TEXT;
  v_clawbacked_ids UUID[] := ARRAY[]::UUID[];
  v_payout RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.commission_events ce
    WHERE ce.reversed_by_refund_id = p_refund_id
  ) THEN
    RETURN;
  END IF;

  SELECT pt.stripe_invoice_id INTO v_invoice_id
  FROM public.payment_transactions pt
  WHERE pt.stripe_payment_intent_id = p_payment_intent_id
    AND pt.stripe_invoice_id IS NOT NULL
  ORDER BY pt.created_at DESC
  LIMIT 1;

  FOR v_event IN
    SELECT ce.id, ce.partner_user_id AS p_uid, ce.commission_amount_thb, ce.status
    FROM public.commission_events ce
    WHERE (
      ce.stripe_payment_intent_id = p_payment_intent_id
      OR (v_invoice_id IS NOT NULL AND ce.stripe_invoice_id = v_invoice_id)
    )
      AND ce.status IN ('holding', 'available')
    FOR UPDATE
  LOOP
    IF v_event.status = 'available' THEN
      v_lock_key := ('x' || left(replace(v_event.p_uid::text, '-', ''), 15))::bit(64)::bigint;
      PERFORM pg_advisory_xact_lock(v_lock_key);

      UPDATE public.cash_wallets cw
      SET balance_thb = GREATEST(cw.balance_thb - v_event.commission_amount_thb, 0),
          updated_at = now()
      WHERE cw.user_id = v_event.p_uid;

      INSERT INTO public.cash_wallet_transactions (
        user_id, amount_thb, tx_type, reference_id, note
      ) VALUES (
        v_event.p_uid,
        -v_event.commission_amount_thb,
        'commission_refunded',
        v_event.id::text,
        'Commission reversed (refund ' || p_refund_id || ')'
      );
    END IF;

    UPDATE public.commission_events ce
    SET status = 'clawback',
        reversed_at = now(),
        reversal_reason = p_reason,
        reversed_by_refund_id = p_refund_id
    WHERE ce.id = v_event.id;

    UPDATE public.partners p
    SET lifetime_commission_thb = GREATEST(0, COALESCE(p.lifetime_commission_thb, 0) - v_event.commission_amount_thb)
    WHERE p.user_id = v_event.p_uid;

    v_clawbacked_ids := array_append(v_clawbacked_ids, v_event.id);

    commission_event_id := v_event.id;
    partner_user_id := v_event.p_uid;
    reversed_amount_thb := v_event.commission_amount_thb;
    RETURN NEXT;
  END LOOP;

  IF cardinality(v_clawbacked_ids) > 0 THEN
    FOR v_payout IN
      SELECT pr.id, pr.partner_user_id AS p_uid, pr.amount_thb, pr.status
      FROM public.payout_requests pr
      WHERE pr.status IN ('pending', 'approved', 'processing')
        AND pr.commission_ids && v_clawbacked_ids
      FOR UPDATE
    LOOP
      UPDATE public.payout_requests pr
      SET status = 'cancelled',
          cancelled_at = now(),
          cancellation_reason = 'commission_refunded: refund ' || p_refund_id
      WHERE pr.id = v_payout.id;

      INSERT INTO public.affiliate_audit_log (
        actor_id, action, entity_type, entity_id, diff
      ) VALUES (
        NULL,
        'payout_cancelled_on_refund',
        'payout_request',
        v_payout.id::text,
        jsonb_build_object(
          'refund_id', p_refund_id,
          'reason', p_reason,
          'amount_thb', v_payout.amount_thb,
          'previous_status', v_payout.status,
          'partner_user_id', v_payout.p_uid,
          'clawbacked_commission_ids', to_jsonb(v_clawbacked_ids)
        )
      );
    END LOOP;
  END IF;

  RETURN;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reverse_commission(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_commission(TEXT, TEXT, TEXT) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Legacy creator payout request is disabled for manual admin settlement.
-- Keep a fixed service-role-only implementation for historical/admin tooling.
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

  IF NOT EXISTS (SELECT 1 FROM public.partners p WHERE p.user_id = v_partner_user_id AND p.suspended_at IS NULL) THEN
    RAISE EXCEPTION 'partner_not_active';
  END IF;

  SELECT pa.bank_name, pa.bank_account_no
    INTO v_bank_name, v_bank_account_no
  FROM public.partner_applications pa
  WHERE pa.user_id = v_partner_user_id;

  IF v_bank_name IS NULL OR length(btrim(v_bank_name)) = 0
     OR v_bank_account_no IS NULL OR length(btrim(v_bank_account_no)) = 0
     OR lower(btrim(v_bank_account_no)) = 'pending'
     OR lower(btrim(v_bank_name)) = 'pending' THEN
    RAISE EXCEPTION 'bank_details_incomplete';
  END IF;

  IF p_amount_thb < 500 THEN
    RAISE EXCEPTION 'below_minimum_threshold: 500 THB';
  END IF;

  SELECT COALESCE(SUM(ce.commission_amount_thb), 0) INTO v_available
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

  v_picked_ids := ARRAY[]::UUID[];
  FOR v_event IN
    SELECT ce.id, ce.commission_amount_thb
    FROM public.commission_events ce
    WHERE ce.partner_user_id = v_partner_user_id
      AND ce.status = 'available'
      AND NOT EXISTS (
        SELECT 1 FROM public.payout_requests pr
        WHERE ce.id = ANY(pr.commission_ids)
          AND pr.status NOT IN ('failed','rejected','cancelled')
      )
    ORDER BY ce.created_at ASC
  LOOP
    v_picked_ids := array_append(v_picked_ids, v_event.id);
    v_picked_total := v_picked_total + v_event.commission_amount_thb;
    EXIT WHEN v_picked_total >= p_amount_thb;
  END LOOP;

  INSERT INTO public.payout_requests (partner_user_id, amount_thb, bank_snapshot, status, commission_ids)
  VALUES (v_partner_user_id, v_picked_total, p_bank_snapshot, 'pending', v_picked_ids)
  RETURNING id INTO v_payout_id;

  RETURN v_payout_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.request_payout(integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_payout(integer, jsonb) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Admin manual settlement: qualify commission id in payout overlap check.
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

REVOKE EXECUTE ON FUNCTION public.admin_settle_partner(uuid, uuid, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_settle_partner(uuid, uuid, text, numeric) TO service_role;

COMMIT;
