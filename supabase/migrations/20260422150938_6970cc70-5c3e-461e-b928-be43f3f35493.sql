-- Fraud scoring RPC for referrals
CREATE OR REPLACE FUNCTION public.compute_referral_risk_score(
  p_referral_id UUID
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ref RECORD;
  v_click RECORD;
  v_code_owner UUID;
  v_score INT := 0;
  v_signals JSONB := '[]'::jsonb;
BEGIN
  SELECT r.id, r.code_id, r.referrer_user_id, r.referred_user_id,
         r.attribution_status, r.signup_country,
         rc.user_id AS code_owner
    INTO v_ref
    FROM public.referrals r
    JOIN public.referral_codes rc ON rc.id = r.code_id
    WHERE r.id = p_referral_id;

  IF v_ref.id IS NULL THEN
    RETURN 0;
  END IF;

  v_code_owner := v_ref.code_owner;

  -- Latest click for this code (best-effort signal source)
  SELECT * INTO v_click
    FROM public.referral_clicks
    WHERE code_id = v_ref.code_id
    ORDER BY clicked_at DESC
    LIMIT 1;

  -- Rule 1: Self-referral (+60) — hard block
  IF v_ref.referred_user_id = v_code_owner THEN
    v_score := v_score + 60;
    v_signals := v_signals || '["self_referral"]'::jsonb;
  END IF;

  -- Rule 2: Device collision across different codes (+40)
  IF v_click.device_fp IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.referral_clicks
    WHERE device_fp = v_click.device_fp
      AND code_id <> v_ref.code_id
      AND clicked_at > now() - interval '24 hours'
  ) THEN
    v_score := v_score + 40;
    v_signals := v_signals || '["device_collision"]'::jsonb;
  END IF;

  -- Rule 3: IP collision — same IP hash >3 clicks in 24h (+20)
  IF v_click.ip_hash IS NOT NULL AND (
    SELECT COUNT(*) FROM public.referral_clicks
    WHERE ip_hash = v_click.ip_hash
      AND clicked_at > now() - interval '24 hours'
  ) > 3 THEN
    v_score := v_score + 20;
    v_signals := v_signals || '["ip_collision"]'::jsonb;
  END IF;

  -- Rule 4: Velocity — code owner has ≥5 referrals in 24h (+25)
  IF (
    SELECT COUNT(*) FROM public.referrals
    WHERE referrer_user_id = v_code_owner
      AND created_at > now() - interval '24 hours'
  ) >= 5 THEN
    v_score := v_score + 25;
    v_signals := v_signals || '["velocity"]'::jsonb;
  END IF;

  -- Rule 5: Country mismatch (+10) — compare signup country to click country
  IF v_ref.signup_country IS NOT NULL
     AND v_click.country_code IS NOT NULL
     AND v_ref.signup_country <> v_click.country_code THEN
    v_score := v_score + 10;
    v_signals := v_signals || '["country_mismatch"]'::jsonb;
  END IF;

  -- Rule 6: Cross-partner device (+15)
  IF v_click.device_fp IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.referral_clicks rc2
    JOIN public.referral_codes rcd ON rcd.id = rc2.code_id
    WHERE rc2.device_fp = v_click.device_fp
      AND rcd.code_type = 'partner_affiliate'
      AND rcd.id <> v_ref.code_id
      AND rc2.clicked_at > now() - interval '24 hours'
  ) THEN
    v_score := v_score + 15;
    v_signals := v_signals || '["cross_partner_device"]'::jsonb;
  END IF;

  -- Persist score + signals; hard-block at >=60
  UPDATE public.referrals
    SET risk_score = v_score,
        risk_flags = v_signals,
        attribution_status = CASE
          WHEN v_score >= 60 THEN 'fraud'
          ELSE attribution_status
        END
    WHERE id = p_referral_id;

  RETURN v_score;
END;
$$;

-- Trigger wrapper: auto-score every new referral
CREATE OR REPLACE FUNCTION public.trigger_score_referral()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.compute_referral_risk_score(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_referral_auto_score ON public.referrals;
CREATE TRIGGER trg_referral_auto_score
  AFTER INSERT ON public.referrals
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_score_referral();