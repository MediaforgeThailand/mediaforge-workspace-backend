-- Hotfix: reverse_commission "column reference partner_user_id is ambiguous"
--
-- Background: PR #50 (20260519120000_reverse_commission_cancels_payout.sql)
-- added a FOR loop over public.payout_requests inside reverse_commission to
-- cancel any pending payout whose commission_ids array overlaps with the
-- just-clawbacked events. The SELECT referenced `partner_user_id` without
-- a table alias:
--
--   FOR v_payout IN
--     SELECT id, partner_user_id AS p_uid, amount_thb, status
--     FROM public.payout_requests
--     WHERE status IN ('pending', 'approved', 'processing')
--       AND commission_ids && v_clawbacked_ids
--     FOR UPDATE
--
-- PostgreSQL sees TWO candidates for `partner_user_id`:
--   1. The OUT parameter `partner_user_id UUID` declared by `RETURNS TABLE`
--      (introduced by PR #39 reverse_commission_renewal_lookup).
--   2. The column `payout_requests.partner_user_id`.
--
-- Under PG 17 plpgsql strict resolution this raises:
--   ERROR  42702: column reference "partner_user_id" is ambiguous
--
-- The fix is purely lexical: qualify the column with the `pr` table alias.
-- Behavior is identical; only the parser sees a difference.
--
-- Impact: every refund webhook (charge.refunded, refund.created,
-- charge.dispute.created) that finds ANY pending/approved/processing
-- payout overlap fails with this error today on prod. The commission flip
-- happens before the loop, so partial state is possible: commissions
-- clawback'd successfully but payouts NOT cancelled → admin can still
-- mark_payout_paid against refunded revenue. (PR #50's bridge guards
-- catch some but not all of this — they only check payout.status, which
-- never updated in this failure mode.)

BEGIN;

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
  v_clawbacked_ids UUID[] := ARRAY[]::UUID[];
  v_payout RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.commission_events
    WHERE reversed_by_refund_id = p_refund_id
  ) THEN
    RETURN;
  END IF;

  SELECT stripe_invoice_id INTO v_invoice_id
  FROM public.payment_transactions
  WHERE stripe_payment_intent_id = p_payment_intent_id
    AND stripe_invoice_id IS NOT NULL
  ORDER BY created_at DESC
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

    v_clawbacked_ids := array_append(v_clawbacked_ids, v_event.id);

    commission_event_id := v_event.id;
    partner_user_id := v_event.p_uid;
    reversed_amount_thb := v_event.commission_amount_thb;
    RETURN NEXT;
  END LOOP;

  -- Cancel any in-flight payout_request that references a commission
  -- we just clawed back. `pr` alias disambiguates `partner_user_id`
  -- from the RETURNS TABLE OUT parameter of the same name.
  IF cardinality(v_clawbacked_ids) > 0 THEN
    FOR v_payout IN
      SELECT pr.id, pr.partner_user_id AS p_uid, pr.amount_thb, pr.status
      FROM public.payout_requests pr
      WHERE pr.status IN ('pending', 'approved', 'processing')
        AND pr.commission_ids && v_clawbacked_ids
      FOR UPDATE
    LOOP
      UPDATE public.payout_requests
      SET status = 'cancelled',
          cancelled_at = now(),
          cancellation_reason = 'commission_refunded: refund ' || p_refund_id
      WHERE id = v_payout.id;

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
$$;

GRANT EXECUTE ON FUNCTION public.reverse_commission(TEXT, TEXT, TEXT) TO service_role;

COMMIT;
