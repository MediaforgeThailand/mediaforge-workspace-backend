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

  SELECT id INTO v_existing_id
  FROM public.commission_events
  WHERE stripe_invoice_id = p_stripe_invoice_id
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    RETURN v_existing_id;
  END IF;

  -- Use 'confirmed' (DB term), not 'converted'
  SELECT id, referrer_user_id, code_type, attribution_status
    INTO v_referral
  FROM public.referrals
  WHERE referred_user_id = p_referred_user_id
    AND attribution_status IN ('pending', 'confirmed')
  LIMIT 1;

  IF v_referral.id IS NULL THEN
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
    partner_user_id, referred_user_id, referral_id, stripe_invoice_id,
    gross_amount_thb, net_amount_thb, commission_rate, commission_amount_thb,
    billing_cycle, cycle_index, status, hold_until
  ) VALUES (
    v_partner.user_id, p_referred_user_id, v_referral.id, p_stripe_invoice_id,
    p_gross_amount_thb, p_net_amount_thb, v_partner.commission_rate, v_commission,
    p_billing_cycle, p_cycle_index, 'holding', now() + INTERVAL '30 days'
  )
  RETURNING id INTO v_event_id;

  -- Promote pending → confirmed (DB term, not 'converted')
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

REVOKE EXECUTE ON FUNCTION public.accrue_commission(uuid, text, numeric, numeric, text, integer) FROM anon, authenticated;