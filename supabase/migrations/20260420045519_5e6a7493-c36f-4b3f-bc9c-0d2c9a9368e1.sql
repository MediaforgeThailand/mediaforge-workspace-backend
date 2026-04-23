-- =====================================================
-- Step 1.3 — Commission idempotency by payment_intent
-- =====================================================
DROP INDEX IF EXISTS public.idx_commission_events_payment_intent;
CREATE UNIQUE INDEX idx_commission_events_payment_intent
  ON public.commission_events (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- =====================================================
-- Step 1.4 — Commission window (12-month from referral creation)
-- Use plain column + trigger (generated columns can't use non-immutable interval math)
-- =====================================================
ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS commission_window_ends_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.set_referral_commission_window()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.commission_window_ends_at IS NULL THEN
    NEW.commission_window_ends_at := COALESCE(NEW.created_at, now()) + interval '12 months';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_referral_commission_window ON public.referrals;
CREATE TRIGGER trg_set_referral_commission_window
  BEFORE INSERT ON public.referrals
  FOR EACH ROW
  EXECUTE FUNCTION public.set_referral_commission_window();

-- Backfill existing rows
UPDATE public.referrals
SET commission_window_ends_at = created_at + interval '12 months'
WHERE commission_window_ends_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_referrals_window
  ON public.referrals (referred_user_id, commission_window_ends_at);

-- =====================================================
-- Step 1.2 — Insert 8 self-service pack rows (quarterly + semiannual)
-- =====================================================
INSERT INTO public.subscription_plans
  (name, target, billing_cycle, price_thb, upfront_credits, sort_order, is_active, cashback_percent)
VALUES
  ('Starter',      'user', 'quarterly',  1458,  182250,  9, true, 0),
  ('Starter',      'user', 'semiannual', 2754,  344250, 10, true, 0),
  ('Growth',       'user', 'quarterly',  3483,  435375, 11, true, 0),
  ('Growth',       'user', 'semiannual', 6579,  822375, 12, true, 0),
  ('Professional', 'user', 'quarterly',  5373,  671625, 13, true, 0),
  ('Professional', 'user', 'semiannual',10149, 1268625, 14, true, 0),
  ('Enterprise',   'user', 'quarterly',  8073, 1009125, 15, true, 0),
  ('Enterprise',   'user', 'semiannual',15249, 1906125, 16, true, 0);

-- =====================================================
-- Step 2 — Update accrue_commission (signature unchanged)
--   (a) 12-month commission window enforcement
--   (b) payment_intent idempotency for one-time pack purchases (pi_* invoice ids)
-- =====================================================
CREATE OR REPLACE FUNCTION public.accrue_commission(
  p_referred_user_id uuid,
  p_stripe_invoice_id text,
  p_gross_amount_thb numeric,
  p_net_amount_thb numeric,
  p_billing_cycle text,
  p_cycle_index integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_referral RECORD;
  v_partner RECORD;
  v_commission NUMERIC;
  v_event_id UUID;
  v_existing_id UUID;
  v_is_pi BOOLEAN;
BEGIN
  IF p_referred_user_id IS NULL OR p_stripe_invoice_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_net_amount_thb <= 0 THEN
    RETURN NULL;
  END IF;

  IF p_cycle_index IS NULL OR p_cycle_index < 1 OR p_cycle_index > 12 THEN
    RETURN NULL;
  END IF;

  v_is_pi := p_stripe_invoice_id LIKE 'pi_%';

  -- Idempotency: invoice id (legacy subscription)
  IF NOT v_is_pi THEN
    SELECT id INTO v_existing_id
    FROM public.commission_events
    WHERE stripe_invoice_id = p_stripe_invoice_id
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      RETURN v_existing_id;
    END IF;
  ELSE
    -- Idempotency: payment_intent (one-time pack)
    SELECT id INTO v_existing_id
    FROM public.commission_events
    WHERE stripe_payment_intent_id = p_stripe_invoice_id
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      RETURN v_existing_id;
    END IF;
  END IF;

  -- Look up active referral
  SELECT id, referrer_user_id, code_type, attribution_status, commission_window_ends_at
    INTO v_referral
  FROM public.referrals
  WHERE referred_user_id = p_referred_user_id
    AND attribution_status IN ('pending', 'confirmed')
  LIMIT 1;

  IF v_referral.id IS NULL THEN
    RETURN NULL;
  END IF;

  -- 12-month window check
  IF v_referral.commission_window_ends_at IS NOT NULL
     AND now() > v_referral.commission_window_ends_at THEN
    RETURN NULL;
  END IF;

  IF v_referral.code_type <> 'partner_affiliate' THEN
    RETURN NULL;
  END IF;

  SELECT user_id, commission_rate
    INTO v_partner
  FROM public.partners
  WHERE user_id = v_referral.referrer_user_id
    AND suspended_at IS NULL
  LIMIT 1;

  IF v_partner.user_id IS NULL THEN
    RETURN NULL;
  END IF;

  v_commission := ROUND(p_net_amount_thb * v_partner.commission_rate, 2);

  IF v_commission <= 0 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.commission_events (
    partner_user_id, referred_user_id, referral_id,
    stripe_invoice_id, stripe_payment_intent_id,
    gross_amount_thb, net_amount_thb, commission_rate, commission_amount_thb,
    billing_cycle, cycle_index, status, hold_until
  ) VALUES (
    v_partner.user_id, p_referred_user_id, v_referral.id,
    CASE WHEN v_is_pi THEN NULL ELSE p_stripe_invoice_id END,
    CASE WHEN v_is_pi THEN p_stripe_invoice_id ELSE NULL END,
    p_gross_amount_thb, p_net_amount_thb, v_partner.commission_rate, v_commission,
    p_billing_cycle, p_cycle_index, 'holding', now() + INTERVAL '30 days'
  )
  RETURNING id INTO v_event_id;

  IF v_referral.attribution_status = 'pending' THEN
    UPDATE public.referrals
    SET attribution_status = 'confirmed',
        confirmed_at = now()
    WHERE id = v_referral.id;
  END IF;

  UPDATE public.partners
  SET lifetime_commission_thb = COALESCE(lifetime_commission_thb, 0) + v_commission
  WHERE user_id = v_partner.user_id;

  RETURN v_event_id;
END;
$function$;