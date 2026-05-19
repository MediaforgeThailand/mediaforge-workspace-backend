-- Restore the self-referral fraud_flag insert that v1 accrue_commission
-- had (migration 20260420211234) but v2 (20260518093000_simple_affiliate_v2)
-- dropped. v2 still rejects self-referrals via `RETURN NULL`, but does so
-- silently — admins have no signal that a partner is trying to pay
-- themselves through a second account.
--
-- Restore the fraud_flags INSERT before RETURN NULL so the daily fraud-
-- detection cron + the affiliate drift notifier (when wired up) see the
-- attempt at the moment it happens.
--
-- Also adds a CHECK constraint that commission_rate must be 0–1 on both
-- `partners` and `commission_events`. Service-role inserters could write
-- a value outside that range today; the constraint is cheap defense in
-- depth.

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
  v_locked_base NUMERIC;
  v_locked_rate NUMERIC;
  v_commission NUMERIC;
  v_event_id UUID;
  v_existing_id UUID;
  v_is_pi BOOLEAN;
BEGIN
  IF p_referred_user_id IS NULL OR p_stripe_invoice_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_net_amount_thb IS NULL OR p_net_amount_thb <= 0 THEN
    RETURN NULL;
  END IF;

  v_is_pi := p_stripe_invoice_id LIKE 'pi_%';

  IF NOT v_is_pi THEN
    SELECT id INTO v_existing_id
    FROM public.commission_events
    WHERE stripe_invoice_id = p_stripe_invoice_id
    LIMIT 1;
  ELSE
    SELECT id INTO v_existing_id
    FROM public.commission_events
    WHERE stripe_payment_intent_id = p_stripe_invoice_id
    LIMIT 1;
  END IF;

  IF v_existing_id IS NOT NULL THEN
    RETURN v_existing_id;
  END IF;

  SELECT
    id,
    referrer_user_id,
    code_type,
    attribution_status,
    commission_base_amount_thb,
    commission_rate
    INTO v_referral
  FROM public.referrals
  WHERE referred_user_id = p_referred_user_id
    AND attribution_status IN ('pending', 'confirmed')
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_referral.id IS NULL OR v_referral.code_type <> 'partner_affiliate' THEN
    RETURN NULL;
  END IF;

  -- ★ SELF-REFERRAL GUARD (RESTORED) ★
  -- Partner trying to pay themselves through a second account. Log to
  -- fraud_flags so the daily detection cron + drift notifier surface it,
  -- then refuse to accrue.
  IF v_referral.referrer_user_id = p_referred_user_id THEN
    INSERT INTO public.fraud_flags (kind, severity, partner_id, referred_user_id, payment_intent_id, details)
    VALUES (
      'self_referral', 'high',
      v_referral.referrer_user_id, p_referred_user_id,
      CASE WHEN v_is_pi THEN p_stripe_invoice_id ELSE NULL END,
      jsonb_build_object(
        'referral_id', v_referral.id,
        'gross_amount_thb', p_gross_amount_thb,
        'net_amount_thb', p_net_amount_thb,
        'stripe_ref', p_stripe_invoice_id
      )
    );
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

  v_locked_base := COALESCE(v_referral.commission_base_amount_thb, ROUND(p_net_amount_thb, 2));
  v_locked_rate := COALESCE(v_referral.commission_rate, v_partner.commission_rate, 0.3000);
  v_commission := ROUND(v_locked_base * v_locked_rate, 2);

  IF v_commission <= 0 THEN
    RETURN NULL;
  END IF;

  IF v_referral.commission_base_amount_thb IS NULL OR v_referral.commission_rate IS NULL THEN
    UPDATE public.referrals
    SET
      commission_base_amount_thb = v_locked_base,
      commission_rate = v_locked_rate,
      attribution_status = 'confirmed',
      confirmed_at = COALESCE(confirmed_at, now()),
      first_paid_at = COALESCE(first_paid_at, now())
    WHERE id = v_referral.id;
  ELSIF v_referral.attribution_status = 'pending' THEN
    UPDATE public.referrals
    SET
      attribution_status = 'confirmed',
      confirmed_at = COALESCE(confirmed_at, now()),
      first_paid_at = COALESCE(first_paid_at, now())
    WHERE id = v_referral.id;
  END IF;

  INSERT INTO public.commission_events (
    partner_user_id,
    referred_user_id,
    referral_id,
    stripe_invoice_id,
    stripe_payment_intent_id,
    gross_amount_thb,
    net_amount_thb,
    commission_base_amount_thb,
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
    CASE WHEN v_is_pi THEN NULL ELSE p_stripe_invoice_id END,
    CASE WHEN v_is_pi THEN p_stripe_invoice_id ELSE NULL END,
    ROUND(p_gross_amount_thb, 2),
    ROUND(p_net_amount_thb, 2),
    v_locked_base,
    v_locked_rate,
    v_commission,
    p_billing_cycle,
    GREATEST(COALESCE(p_cycle_index, 1), 1),
    'holding',
    now() + interval '30 days'
  )
  RETURNING id INTO v_event_id;

  UPDATE public.partners
  SET lifetime_commission_thb = COALESCE(lifetime_commission_thb, 0) + v_commission
  WHERE user_id = v_partner.user_id;

  RETURN v_event_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.accrue_commission(uuid, text, numeric, numeric, text, integer) FROM anon, authenticated;

-- CHECK constraints on commission_rate (0 ≤ rate ≤ 1) for both tables.
-- Sanitize any out-of-range values first (should be zero rows in a healthy
-- DB) so the constraint adds without error.

UPDATE public.partners SET commission_rate = LEAST(GREATEST(commission_rate, 0), 1)
 WHERE commission_rate < 0 OR commission_rate > 1;

UPDATE public.commission_events SET commission_rate = LEAST(GREATEST(commission_rate, 0), 1)
 WHERE commission_rate < 0 OR commission_rate > 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partners_commission_rate_check'
      AND conrelid = 'public.partners'::regclass
  ) THEN
    ALTER TABLE public.partners
      ADD CONSTRAINT partners_commission_rate_check
      CHECK (commission_rate >= 0 AND commission_rate <= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commission_events_commission_rate_check'
      AND conrelid = 'public.commission_events'::regclass
  ) THEN
    ALTER TABLE public.commission_events
      ADD CONSTRAINT commission_events_commission_rate_check
      CHECK (commission_rate >= 0 AND commission_rate <= 1);
  END IF;
END $$;
