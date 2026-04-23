
-- ============================================================
-- P5: Commission Engine RPCs
-- ============================================================

-- Idempotency: prevent duplicate commissions per Stripe invoice
CREATE UNIQUE INDEX IF NOT EXISTS commission_events_stripe_invoice_uniq
  ON public.commission_events (stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;

-- Performance indexes
CREATE INDEX IF NOT EXISTS commission_events_partner_status_idx
  ON public.commission_events (partner_user_id, status);

CREATE INDEX IF NOT EXISTS commission_events_holding_release_idx
  ON public.commission_events (hold_until)
  WHERE status = 'holding';

-- ============================================================
-- RPC 1: accrue_commission
-- Called by stripe-webhook on invoice.paid / checkout.session.completed
-- Returns commission_event id, or NULL if not eligible
-- ============================================================
CREATE OR REPLACE FUNCTION public.accrue_commission(
  p_referred_user_id UUID,
  p_stripe_invoice_id TEXT,
  p_gross_amount_thb NUMERIC,
  p_net_amount_thb NUMERIC,
  p_billing_cycle TEXT,
  p_cycle_index INT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_referral RECORD;
  v_partner RECORD;
  v_commission NUMERIC;
  v_event_id UUID;
  v_existing_id UUID;
BEGIN
  -- Validate inputs
  IF p_referred_user_id IS NULL OR p_stripe_invoice_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_net_amount_thb <= 0 THEN
    RETURN NULL;
  END IF;

  -- Cycle cap (rule: 1-12 = full rate, 13+ = no commission)
  IF p_cycle_index IS NULL OR p_cycle_index < 1 OR p_cycle_index > 12 THEN
    RETURN NULL;
  END IF;

  -- Idempotency: already processed?
  SELECT id INTO v_existing_id
  FROM public.commission_events
  WHERE stripe_invoice_id = p_stripe_invoice_id
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    RETURN v_existing_id;
  END IF;

  -- Lookup referral attribution
  SELECT id, referrer_user_id, code_type, attribution_status
    INTO v_referral
  FROM public.referrals
  WHERE referred_user_id = p_referred_user_id
    AND attribution_status IN ('pending', 'converted')
  LIMIT 1;

  IF v_referral.id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Only partner_referral earns commission
  IF v_referral.code_type <> 'partner_referral' THEN
    RETURN NULL;
  END IF;

  -- Lookup active partner (active = approved AND not suspended)
  SELECT user_id, commission_rate
    INTO v_partner
  FROM public.partners
  WHERE user_id = v_referral.referrer_user_id
    AND suspended_at IS NULL
  LIMIT 1;

  IF v_partner.user_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Calculate commission
  v_commission := ROUND(p_net_amount_thb * v_partner.commission_rate, 2);

  IF v_commission <= 0 THEN
    RETURN NULL;
  END IF;

  -- Insert commission event
  INSERT INTO public.commission_events (
    partner_user_id,
    referred_user_id,
    referral_id,
    stripe_invoice_id,
    gross_amount_thb,
    net_amount_thb,
    commission_rate,
    commission_amount_thb,
    billing_cycle,
    cycle_index,
    status,
    hold_until
  ) VALUES (
    v_partner.user_id,
    p_referred_user_id,
    v_referral.id,
    p_stripe_invoice_id,
    p_gross_amount_thb,
    p_net_amount_thb,
    v_partner.commission_rate,
    v_commission,
    p_billing_cycle,
    p_cycle_index,
    'holding',
    now() + INTERVAL '30 days'
  )
  RETURNING id INTO v_event_id;

  -- Promote referral to converted (first paid conversion)
  IF v_referral.attribution_status = 'pending' THEN
    UPDATE public.referrals
    SET attribution_status = 'converted',
        confirmed_at = now()
    WHERE id = v_referral.id;
  END IF;

  -- Track lifetime accrued (running total, not yet paid)
  UPDATE public.partners
  SET lifetime_commission_thb = COALESCE(lifetime_commission_thb, 0) + v_commission
  WHERE user_id = v_partner.user_id;

  RETURN v_event_id;
END;
$$;

-- ============================================================
-- RPC 2: release_commission
-- Called by pg_cron daily at 00:00 UTC
-- Moves matured holds → available + credits wallet
-- ============================================================
CREATE OR REPLACE FUNCTION public.release_commission()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event RECORD;
  v_count INT := 0;
  v_lock_key BIGINT;
BEGIN
  FOR v_event IN
    SELECT id, partner_user_id, commission_amount_thb
    FROM public.commission_events
    WHERE status = 'holding'
      AND hold_until <= now()
    FOR UPDATE SKIP LOCKED
  LOOP
    -- Per-user advisory lock for wallet update
    v_lock_key := ('x' || left(replace(v_event.partner_user_id::text, '-', ''), 15))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- Mark released
    UPDATE public.commission_events
    SET status = 'available',
        available_at = now()
    WHERE id = v_event.id;

    -- Ensure wallet exists
    INSERT INTO public.cash_wallets (user_id, balance_thb, lifetime_earned)
    VALUES (v_event.partner_user_id, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;

    -- Credit wallet
    UPDATE public.cash_wallets
    SET balance_thb = balance_thb + v_event.commission_amount_thb,
        lifetime_earned = lifetime_earned + v_event.commission_amount_thb,
        updated_at = now()
    WHERE user_id = v_event.partner_user_id;

    -- Wallet ledger
    INSERT INTO public.cash_wallet_transactions (
      user_id, amount_thb, tx_type, reference_id, note
    ) VALUES (
      v_event.partner_user_id,
      v_event.commission_amount_thb,
      'commission_released',
      v_event.id::text,
      'Commission released after 30-day hold'
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- ============================================================
-- RPC 3: refund_commission
-- Called by stripe-webhook on charge.refunded / invoice.payment_failed
-- ============================================================
CREATE OR REPLACE FUNCTION public.refund_commission(
  p_commission_event_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event RECORD;
  v_lock_key BIGINT;
BEGIN
  SELECT id, partner_user_id, commission_amount_thb, status
    INTO v_event
  FROM public.commission_events
  WHERE id = p_commission_event_id
  FOR UPDATE;

  IF v_event.id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF v_event.status IN ('refunded', 'paid') THEN
    -- Already refunded, or paid out (cannot claw back automatically)
    RETURN FALSE;
  END IF;

  -- If commission was already released to wallet, reverse it
  IF v_event.status = 'available' THEN
    v_lock_key := ('x' || left(replace(v_event.partner_user_id::text, '-', ''), 15))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_lock_key);

    UPDATE public.cash_wallets
    SET balance_thb = GREATEST(balance_thb - v_event.commission_amount_thb, 0),
        updated_at = now()
    WHERE user_id = v_event.partner_user_id;

    INSERT INTO public.cash_wallet_transactions (
      user_id, amount_thb, tx_type, reference_id, note
    ) VALUES (
      v_event.partner_user_id,
      -v_event.commission_amount_thb,
      'commission_refunded',
      v_event.id::text,
      'Commission reversed due to Stripe refund'
    );
  END IF;

  -- Decrement partner lifetime accrued
  UPDATE public.partners
  SET lifetime_commission_thb = GREATEST(
    COALESCE(lifetime_commission_thb, 0) - v_event.commission_amount_thb,
    0
  )
  WHERE user_id = v_event.partner_user_id;

  -- Mark refunded
  UPDATE public.commission_events
  SET status = 'refunded'
  WHERE id = v_event.id;

  RETURN TRUE;
END;
$$;

-- Lock down direct execution (only service_role / postgres should call these)
REVOKE EXECUTE ON FUNCTION public.accrue_commission FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_commission FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refund_commission FROM anon, authenticated;
