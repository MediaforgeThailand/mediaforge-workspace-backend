-- Extend reverse_commission to clawback renewal commissions.
--
-- `accrue_commission` v2 stores either `stripe_invoice_id` OR
-- `stripe_payment_intent_id` based on which prefix the caller passed —
-- never both. Renewal accruals from `invoice.paid` pass an `in_*` id and
-- leave the PI column NULL. `reverse_commission` previously only matched
-- by `stripe_payment_intent_id`, so refunds (which arrive with a PI) found
-- 0 rows for every renewal and the commission stayed in `holding` /
-- `available` forever. Partner kept commission on a refunded subscription.
--
-- Fix: before iterating commission_events, resolve the invoice id for the
-- refunded PI via payment_transactions (the same table the webhook writes
-- for every Stripe payment we receive). Match by either column.

CREATE OR REPLACE FUNCTION public.reverse_commission(
  p_payment_intent_id TEXT,
  p_refund_id TEXT,
  p_reason TEXT DEFAULT 'stripe_refund'
)
RETURNS TABLE(commission_event_id UUID, partner_user_id UUID, reversed_amount_thb NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event RECORD;
  v_lock_key BIGINT;
  v_invoice_id TEXT;
BEGIN
  -- Idempotency: if any event already reversed by this refund_id, no-op
  IF EXISTS (
    SELECT 1 FROM public.commission_events
    WHERE reversed_by_refund_id = p_refund_id
  ) THEN
    RETURN;
  END IF;

  -- Resolve the invoice id for this PI so we can reach commission_events
  -- rows that were accrued from `invoice.paid` (renewal path) and only
  -- have stripe_invoice_id populated, not stripe_payment_intent_id.
  SELECT stripe_invoice_id INTO v_invoice_id
  FROM public.payment_transactions
  WHERE stripe_payment_intent_id = p_payment_intent_id
    AND stripe_invoice_id IS NOT NULL
  ORDER BY created_at DESC
  LIMIT 1;

  -- Iterate commission events matched by EITHER stripe id column.
  -- `ce` alias avoids ambiguity with the RETURNS TABLE OUT parameter
  -- `partner_user_id` under PG 17 plpgsql strict resolution.
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
    -- If commission was already released to wallet, reverse the wallet credit too
    IF v_event.status = 'available' THEN
      v_lock_key := ('x' || left(replace(v_event.p_uid::text, '-', ''), 15))::bit(64)::bigint;
      PERFORM pg_advisory_xact_lock(v_lock_key);

      UPDATE public.cash_wallets
      SET balance_thb = GREATEST(balance_thb - v_event.commission_amount_thb, 0),
          updated_at = now()
      WHERE user_id = v_event.p_uid;

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

    UPDATE public.commission_events
    SET status = 'clawback',
        reversed_at = now(),
        reversal_reason = p_reason,
        reversed_by_refund_id = p_refund_id
    WHERE id = v_event.id;

    UPDATE public.partners
    SET lifetime_commission_thb = GREATEST(0, COALESCE(lifetime_commission_thb, 0) - v_event.commission_amount_thb)
    WHERE user_id = v_event.p_uid;

    commission_event_id := v_event.id;
    partner_user_id := v_event.p_uid;
    reversed_amount_thb := v_event.commission_amount_thb;
    RETURN NEXT;
  END LOOP;

  RETURN;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reverse_commission(TEXT, TEXT, TEXT) TO service_role;
