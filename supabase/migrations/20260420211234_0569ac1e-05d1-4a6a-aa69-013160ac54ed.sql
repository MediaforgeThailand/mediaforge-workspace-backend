-- ── 1. fraud_flags table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fraud_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN (
    'self_referral',
    'velocity_signup',
    'velocity_refund',
    'bogus_email',
    'ip_collision',
    'manual_review'
  )),
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
  partner_id UUID REFERENCES public.partners(user_id) ON DELETE SET NULL,
  referred_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  payment_intent_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','dismissed','actioned')),
  action_taken TEXT,
  actioned_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actioned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fraud_flags_status_severity ON public.fraud_flags(status, severity);
CREATE INDEX IF NOT EXISTS idx_fraud_flags_partner ON public.fraud_flags(partner_id);
CREATE INDEX IF NOT EXISTS idx_fraud_flags_created_at ON public.fraud_flags(created_at DESC);

ALTER TABLE public.fraud_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_fraud_all" ON public.fraud_flags;
CREATE POLICY "service_role_fraud_all" ON public.fraud_flags
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "admins_read_fraud" ON public.fraud_flags;
CREATE POLICY "admins_read_fraud" ON public.fraud_flags
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "admins_update_fraud" ON public.fraud_flags;
CREATE POLICY "admins_update_fraud" ON public.fraud_flags
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- ── 2. Patch accrue_commission with self-referral guard ───────────
CREATE OR REPLACE FUNCTION public.accrue_commission(
  p_referred_user_id uuid,
  p_stripe_invoice_id text,
  p_gross_amount_thb numeric,
  p_net_amount_thb numeric,
  p_billing_cycle text,
  p_cycle_index integer
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
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

  -- Idempotency
  IF NOT v_is_pi THEN
    SELECT id INTO v_existing_id FROM public.commission_events
      WHERE stripe_invoice_id = p_stripe_invoice_id LIMIT 1;
    IF v_existing_id IS NOT NULL THEN RETURN v_existing_id; END IF;
  ELSE
    SELECT id INTO v_existing_id FROM public.commission_events
      WHERE stripe_payment_intent_id = p_stripe_invoice_id LIMIT 1;
    IF v_existing_id IS NOT NULL THEN RETURN v_existing_id; END IF;
  END IF;

  -- Look up active referral
  SELECT id, referrer_user_id, code_type, attribution_status, commission_window_ends_at
    INTO v_referral
  FROM public.referrals
  WHERE referred_user_id = p_referred_user_id
    AND attribution_status IN ('pending', 'confirmed')
  LIMIT 1;

  IF v_referral.id IS NULL THEN RETURN NULL; END IF;

  -- ★ SELF-REFERRAL GUARD ★
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

  -- 12-month window check
  IF v_referral.commission_window_ends_at IS NOT NULL
     AND now() > v_referral.commission_window_ends_at THEN
    RETURN NULL;
  END IF;

  IF v_referral.code_type <> 'partner_affiliate' THEN RETURN NULL; END IF;

  SELECT user_id, commission_rate INTO v_partner
  FROM public.partners
  WHERE user_id = v_referral.referrer_user_id AND suspended_at IS NULL
  LIMIT 1;

  IF v_partner.user_id IS NULL THEN RETURN NULL; END IF;

  v_commission := ROUND(p_net_amount_thb * v_partner.commission_rate, 2);
  IF v_commission <= 0 THEN RETURN NULL; END IF;

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
  ) RETURNING id INTO v_event_id;

  IF v_referral.attribution_status = 'pending' THEN
    UPDATE public.referrals
    SET attribution_status = 'confirmed', confirmed_at = now()
    WHERE id = v_referral.id;
  END IF;

  UPDATE public.partners
  SET lifetime_commission_thb = COALESCE(lifetime_commission_thb, 0) + v_commission
  WHERE user_id = v_partner.user_id;

  RETURN v_event_id;
END;
$function$;

-- ── 3. Velocity detection ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.detect_refund_velocity()
RETURNS TABLE(partner_user_id UUID, refund_rate NUMERIC, total_paying BIGINT)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH partner_stats AS (
    SELECT
      r.referrer_user_id AS partner_user_id,
      COUNT(*) FILTER (WHERE r.attribution_status = 'confirmed') AS total_paying,
      COUNT(*) FILTER (WHERE pt.status = 'refunded') AS total_refunded
    FROM public.referrals r
    LEFT JOIN public.payment_transactions pt ON pt.user_id = r.referred_user_id
    WHERE r.created_at >= now() - interval '30 days'
      AND r.code_type = 'partner_affiliate'
    GROUP BY r.referrer_user_id
  )
  SELECT
    partner_user_id,
    (total_refunded::NUMERIC / NULLIF(total_paying, 0)) AS refund_rate,
    total_paying
  FROM partner_stats
  WHERE total_paying >= 5
    AND (total_refunded::NUMERIC / NULLIF(total_paying, 0)) > 0.30;
$$;

CREATE OR REPLACE FUNCTION public.flag_high_refund_partners()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count INTEGER := 0;
  r RECORD;
BEGIN
  FOR r IN SELECT * FROM public.detect_refund_velocity() LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.fraud_flags
      WHERE partner_id = r.partner_user_id
        AND kind = 'velocity_refund'
        AND status = 'open'
    ) THEN
      INSERT INTO public.fraud_flags (kind, severity, partner_id, details)
      VALUES (
        'velocity_refund', 'high', r.partner_user_id,
        jsonb_build_object('refund_rate', r.refund_rate, 'total_paying', r.total_paying, 'window_days', 30)
      );
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.detect_refund_velocity() TO service_role;
GRANT EXECUTE ON FUNCTION public.flag_high_refund_partners() TO service_role;

-- ── 4. Cron: daily fraud detection ────────────────────────────────
DO $$ BEGIN
  PERFORM cron.unschedule('fraud-detection-velocity-daily');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'fraud-detection-velocity-daily',
  '30 2 * * *',
  $$ SELECT public.flag_high_refund_partners(); $$
);