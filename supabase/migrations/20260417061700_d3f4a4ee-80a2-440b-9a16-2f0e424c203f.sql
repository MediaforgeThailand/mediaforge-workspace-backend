-- ============== EXTENSIONS ==============
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============== REFERRAL CODES ==============
CREATE TABLE IF NOT EXISTS public.referral_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  code_type TEXT NOT NULL CHECK (code_type IN ('user_referral','partner_affiliate')),
  is_active BOOLEAN DEFAULT TRUE,
  campaign_label TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON public.referral_codes(code);
CREATE INDEX IF NOT EXISTS idx_referral_codes_user ON public.referral_codes(user_id);

-- ============== CLICK TRACKING ==============
CREATE TABLE IF NOT EXISTS public.referral_clicks (
  id BIGSERIAL PRIMARY KEY,
  code_id UUID REFERENCES public.referral_codes(id),
  code TEXT NOT NULL,
  ip_hash TEXT,
  device_fp TEXT,
  user_agent TEXT,
  referrer_url TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
  country_code TEXT,
  clicked_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clicks_code ON public.referral_clicks(code);
CREATE INDEX IF NOT EXISTS idx_clicks_fp ON public.referral_clicks(device_fp);

-- ============== REFERRALS ==============
CREATE TABLE IF NOT EXISTS public.referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id UUID NOT NULL REFERENCES auth.users(id),
  referred_user_id UUID NOT NULL REFERENCES auth.users(id) UNIQUE,
  code_id UUID NOT NULL REFERENCES public.referral_codes(id),
  code_type TEXT NOT NULL,
  attribution_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (attribution_status IN ('pending','confirmed','rejected','fraud')),
  signup_ip_hash TEXT, signup_device_fp TEXT, signup_country TEXT,
  risk_score INT DEFAULT 0,
  risk_flags JSONB DEFAULT '[]'::jsonb,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============== CREDIT GRANTS ==============
CREATE TABLE IF NOT EXISTS public.referral_credit_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id UUID NOT NULL REFERENCES public.referrals(id) UNIQUE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  credits_amount INT NOT NULL DEFAULT 1000,
  granted_at TIMESTAMPTZ,
  status TEXT DEFAULT 'locked' CHECK (status IN ('locked','granted','revoked')),
  locked_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============== CASH WALLETS ==============
CREATE TABLE IF NOT EXISTS public.cash_wallets (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance_thb NUMERIC(12,2) NOT NULL DEFAULT 0,
  lifetime_earned NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.cash_wallet_transactions (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  amount_thb NUMERIC(12,2) NOT NULL,
  tx_type TEXT NOT NULL CHECK (tx_type IN ('referral_bonus','topup_discount','admin_adjust','refund')),
  reference_id TEXT,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============== KYC / PARTNER APPLICATIONS ==============
CREATE TABLE IF NOT EXISTS public.partner_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) UNIQUE,
  legal_first_name TEXT NOT NULL,
  legal_last_name TEXT NOT NULL,
  national_id TEXT NOT NULL,
  phone_e164 TEXT NOT NULL,
  address_line1 TEXT, address_line2 TEXT,
  city TEXT, postal_code TEXT, country_code TEXT DEFAULT 'TH',
  bank_name TEXT NOT NULL,
  bank_account_no TEXT NOT NULL,
  bank_account_name TEXT NOT NULL,
  id_card_front_url TEXT NOT NULL,
  id_card_back_url TEXT,
  bank_book_url TEXT NOT NULL,
  selfie_with_id_url TEXT,
  social_profile_url TEXT,
  social_platform TEXT,
  follower_count INT,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('draft','submitted','in_review','approved','rejected','needs_info')),
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  needs_info_message TEXT,
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============== PARTNERS ==============
CREATE TABLE IF NOT EXISTS public.partners (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id),
  application_id UUID NOT NULL REFERENCES public.partner_applications(id),
  commission_rate NUMERIC(5,4) NOT NULL DEFAULT 0.3000,
  tier TEXT DEFAULT 'standard',
  approved_at TIMESTAMPTZ NOT NULL,
  suspended_at TIMESTAMPTZ,
  suspended_reason TEXT,
  lifetime_commission_thb NUMERIC(14,2) DEFAULT 0,
  lifetime_paid_thb NUMERIC(14,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============== COMMISSION EVENTS ==============
CREATE TABLE IF NOT EXISTS public.commission_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_user_id UUID NOT NULL REFERENCES public.partners(user_id),
  referred_user_id UUID NOT NULL REFERENCES auth.users(id),
  referral_id UUID NOT NULL REFERENCES public.referrals(id),
  stripe_invoice_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  gross_amount_thb NUMERIC(12,2) NOT NULL,
  net_amount_thb NUMERIC(12,2) NOT NULL,
  commission_rate NUMERIC(5,4) NOT NULL,
  commission_amount_thb NUMERIC(12,2) NOT NULL,
  billing_cycle TEXT,
  cycle_index INT DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'holding'
    CHECK (status IN ('holding','available','paid','clawback','void')),
  hold_until TIMESTAMPTZ NOT NULL,
  available_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  payout_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_comm_partner ON public.commission_events(partner_user_id);
CREATE INDEX IF NOT EXISTS idx_comm_status ON public.commission_events(status);

-- ============== PAYOUT REQUESTS ==============
CREATE TABLE IF NOT EXISTS public.payout_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_user_id UUID NOT NULL REFERENCES public.partners(user_id),
  amount_thb NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','paid','failed','cancelled')),
  commission_ids UUID[] NOT NULL,
  bank_snapshot JSONB NOT NULL,
  processed_by UUID REFERENCES auth.users(id),
  processed_at TIMESTAMPTZ,
  proof_url TEXT,
  failure_reason TEXT,
  requested_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============== AUDIT LOG ==============
CREATE TABLE IF NOT EXISTS public.affiliate_audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id UUID,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  diff JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============== MERGE INTO EXISTING handle_new_user() ==============
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_code TEXT;
BEGIN
  -- Existing logic: profile, role, credits
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email));

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'user');

  INSERT INTO public.user_credits (user_id, balance, total_purchased)
  VALUES (NEW.id, 0, 0);

  -- New: generate unique referral code
  LOOP
    v_new_code := 'MF-' || UPPER(substr(md5(random()::text || NEW.id::text), 1, 6));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.referral_codes WHERE code = v_new_code);
  END LOOP;

  INSERT INTO public.referral_codes (user_id, code, code_type)
  VALUES (NEW.id, v_new_code, 'user_referral');

  -- New: create empty cash wallet
  INSERT INTO public.cash_wallets (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- Backfill referral codes & cash wallets for existing users
INSERT INTO public.referral_codes (user_id, code, code_type)
SELECT u.id,
       'MF-' || UPPER(substr(md5(random()::text || u.id::text), 1, 6)),
       'user_referral'
FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM public.referral_codes rc
  WHERE rc.user_id = u.id AND rc.code_type = 'user_referral'
);

INSERT INTO public.cash_wallets (user_id)
SELECT u.id FROM auth.users u
ON CONFLICT (user_id) DO NOTHING;

-- ============== ROW-LEVEL SECURITY ==============
ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_referral_codes" ON public.referral_codes
  FOR SELECT USING (auth.uid() = user_id);

ALTER TABLE public.referral_clicks ENABLE ROW LEVEL SECURITY;
-- No public policies — service role only (edge function /track-click)

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_referrals" ON public.referrals
  FOR SELECT USING (auth.uid() = referrer_user_id);

ALTER TABLE public.referral_credit_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_credit_grants" ON public.referral_credit_grants
  FOR SELECT USING (auth.uid() = user_id);

ALTER TABLE public.cash_wallets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_wallet" ON public.cash_wallets
  FOR SELECT USING (auth.uid() = user_id);

ALTER TABLE public.cash_wallet_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_wallet_tx" ON public.cash_wallet_transactions
  FOR SELECT USING (auth.uid() = user_id);

ALTER TABLE public.partner_applications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_kyc_select" ON public.partner_applications
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own_kyc_insert" ON public.partner_applications
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own_kyc_update_draft" ON public.partner_applications
  FOR UPDATE USING (auth.uid() = user_id AND status IN ('draft','needs_info'));

ALTER TABLE public.partners ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_partner" ON public.partners
  FOR SELECT USING (auth.uid() = user_id);

ALTER TABLE public.commission_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_commissions" ON public.commission_events
  FOR SELECT USING (auth.uid() = partner_user_id);

ALTER TABLE public.payout_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_payouts_select" ON public.payout_requests
  FOR SELECT USING (auth.uid() = partner_user_id);
CREATE POLICY "own_payouts_insert" ON public.payout_requests
  FOR INSERT WITH CHECK (auth.uid() = partner_user_id);

ALTER TABLE public.affiliate_audit_log ENABLE ROW LEVEL SECURITY;
-- No public policies — service role only

-- ============== KYC STORAGE BUCKET ==============
INSERT INTO storage.buckets (id, name, public)
VALUES ('kyc-docs','kyc-docs', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Users upload own KYC" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'kyc-docs' AND auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "Users read own KYC" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'kyc-docs' AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- updated_at trigger for partner_applications
CREATE TRIGGER trg_partner_applications_updated
  BEFORE UPDATE ON public.partner_applications
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER trg_cash_wallets_updated
  BEFORE UPDATE ON public.cash_wallets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();