-- ─── payment_transactions: refund tracking columns ───
ALTER TABLE public.payment_transactions
  ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refund_amount_thb INTEGER,
  ADD COLUMN IF NOT EXISTS refund_reason TEXT,
  ADD COLUMN IF NOT EXISTS stripe_refund_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_tx_refund_id
  ON public.payment_transactions(stripe_refund_id)
  WHERE stripe_refund_id IS NOT NULL;

-- ─── commission_events: reversal tracking columns ───
ALTER TABLE public.commission_events
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT,
  ADD COLUMN IF NOT EXISTS reversed_by_refund_id TEXT;

CREATE INDEX IF NOT EXISTS idx_commission_events_reversed_refund
  ON public.commission_events(reversed_by_refund_id)
  WHERE reversed_by_refund_id IS NOT NULL;

-- ─── RPC: reverse_commission ───
-- NOTE: Schema uses partner_user_id (not partner_id) and partners.user_id is the PK.
-- commission_events.status CHECK allows: holding, available, paid, clawback, void.
-- We use 'clawback' as the terminal reversed status (no new enum value needed).
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
BEGIN
  -- Idempotency: if any event already reversed by this refund_id, no-op
  IF EXISTS (
    SELECT 1 FROM public.commission_events
    WHERE reversed_by_refund_id = p_refund_id
  ) THEN
    RETURN;
  END IF;

  -- Iterate commission events linked to this PI that are still active
  FOR v_event IN
    SELECT id, partner_user_id AS p_uid, commission_amount_thb, status
    FROM public.commission_events
    WHERE stripe_payment_intent_id = p_payment_intent_id
      AND status IN ('holding', 'available')
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

    -- Flip status to 'clawback' (terminal reversed state in existing schema)
    UPDATE public.commission_events
    SET status = 'clawback',
        reversed_at = now(),
        reversal_reason = p_reason,
        reversed_by_refund_id = p_refund_id
    WHERE id = v_event.id;

    -- Decrement partner lifetime
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