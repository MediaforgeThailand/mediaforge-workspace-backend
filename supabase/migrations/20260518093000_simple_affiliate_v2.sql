BEGIN;

ALTER TABLE public.referral_codes
  ADD COLUMN IF NOT EXISTS discount_percent numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stripe_coupon_id text,
  ADD COLUMN IF NOT EXISTS stripe_promotion_code_id text,
  ADD COLUMN IF NOT EXISTS discount_duration text NOT NULL DEFAULT 'once',
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.referral_codes
  DROP CONSTRAINT IF EXISTS referral_codes_discount_percent_check,
  ADD CONSTRAINT referral_codes_discount_percent_check
    CHECK (discount_percent >= 0 AND discount_percent <= 100);

ALTER TABLE public.referral_codes
  DROP CONSTRAINT IF EXISTS referral_codes_discount_duration_check,
  ADD CONSTRAINT referral_codes_discount_duration_check
    CHECK (discount_duration IN ('once', 'forever'));

ALTER TABLE public.partner_applications
  ALTER COLUMN national_id DROP NOT NULL,
  ALTER COLUMN id_card_front_url DROP NOT NULL,
  ALTER COLUMN bank_book_url DROP NOT NULL;

ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS attribution_source text,
  ADD COLUMN IF NOT EXISTS first_paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS commission_base_amount_thb numeric(12,2),
  ADD COLUMN IF NOT EXISTS commission_rate numeric(5,4);

ALTER TABLE public.commission_events
  ADD COLUMN IF NOT EXISTS commission_base_amount_thb numeric(12,2);

CREATE INDEX IF NOT EXISTS idx_referral_codes_partner_active
  ON public.referral_codes (user_id, is_active, code_type);

CREATE INDEX IF NOT EXISTS idx_referrals_affiliate_lookup
  ON public.referrals (referred_user_id, code_type, attribution_status);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ref_code_used text;
  v_ref_code record;
BEGIN
  INSERT INTO public.profiles (user_id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      split_part(COALESCE(NEW.email, ''), '@', 1),
      'New user'
    ),
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'user')
  ON CONFLICT (user_id, role) DO NOTHING;

  INSERT INTO public.user_credits (user_id, balance, total_purchased, total_used)
  VALUES (NEW.id, 0, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  BEGIN
    v_ref_code_used := upper(trim(COALESCE(NEW.raw_user_meta_data->>'referral_code_used', '')));

    IF v_ref_code_used <> '' THEN
      SELECT id, user_id, code_type
        INTO v_ref_code
      FROM public.referral_codes
      WHERE upper(code) = v_ref_code_used
        AND is_active = true
      LIMIT 1;

      IF v_ref_code.id IS NOT NULL AND v_ref_code.user_id <> NEW.id THEN
        INSERT INTO public.referrals (
          referrer_user_id,
          referred_user_id,
          code_id,
          code_type,
          attribution_status,
          signup_device_fp,
          attribution_source
        )
        VALUES (
          v_ref_code.user_id,
          NEW.id,
          v_ref_code.id,
          v_ref_code.code_type,
          'pending',
          NEW.raw_user_meta_data->>'device_fingerprint',
          'signup_ref'
        )
        ON CONFLICT (referred_user_id) DO NOTHING;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[handle_new_user] affiliate attribution failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user() IS
  'Workspace signup handler: profiles + roles + credits row, with safe affiliate/referral attribution from raw_user_meta_data.referral_code_used.';

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

COMMIT;
