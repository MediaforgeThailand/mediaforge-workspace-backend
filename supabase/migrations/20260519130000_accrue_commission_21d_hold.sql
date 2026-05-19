-- Align commission hold window with the 21-day business commitment.
--
-- The original accrue_commission used a 30-day hold (now() + interval '30 days')
-- but marketing/business has always committed to "creators paid within 21 days".
-- That 9-day gap was a silent contract breach for every cohort that ever ran
-- through the system.
--
-- This migration:
--   1. CREATE OR REPLACE accrue_commission with '21 days' (future accruals).
--   2. UPDATE existing rows still in 'holding' to slide hold_until earlier
--      by 9 days so creators currently waiting also get the corrected SLA.
--      We only touch status='holding' so already-released or clawback'd rows
--      are untouched. Rows whose remaining hold is < 9 days will become
--      eligible immediately on the next release_commission cron pass.

BEGIN;

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

  IF v_referral.referrer_user_id = p_referred_user_id THEN
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
    now() + interval '21 days'
  )
  RETURNING id INTO v_event_id;

  UPDATE public.partners
  SET lifetime_commission_thb = COALESCE(lifetime_commission_thb, 0) + v_commission
  WHERE user_id = v_partner.user_id;

  RETURN v_event_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.accrue_commission(uuid, text, numeric, numeric, text, integer) FROM anon, authenticated;

-- Retroactively grant existing creators the 21-day SLA. release_commission
-- (the daily cron) only checks `hold_until <= now()`, so subtracting 9 days
-- naturally fast-forwards any holding row that should already be released.
-- We log the bulk shift to affiliate_audit_log for traceability — one row
-- per shifted event so a future drift check can correlate.
WITH shifted AS (
  UPDATE public.commission_events
     SET hold_until = hold_until - interval '9 days'
   WHERE status = 'holding'
  RETURNING id, partner_user_id, commission_amount_thb, hold_until
)
INSERT INTO public.affiliate_audit_log (actor_id, action, entity_type, entity_id, diff)
SELECT
  NULL,
  'hold_window_retroactively_shifted',
  'commission_event',
  id::text,
  jsonb_build_object(
    'partner_user_id', partner_user_id,
    'commission_amount_thb', commission_amount_thb,
    'new_hold_until', hold_until,
    'shift_days', 9,
    'reason', 'align with 21-day business commitment'
  )
FROM shifted;

COMMIT;
