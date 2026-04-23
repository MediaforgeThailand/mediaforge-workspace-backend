
-- 1. Add promo columns to topup_packages
ALTER TABLE public.topup_packages
  ADD COLUMN IF NOT EXISTS is_promo BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bonus_percent INTEGER,
  ADD COLUMN IF NOT EXISTS original_credits INTEGER,
  ADD COLUMN IF NOT EXISTS one_time_per_user BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS badge_label TEXT;

-- 2. Create redemptions tracking table
CREATE TABLE IF NOT EXISTS public.topup_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  topup_package_id UUID NOT NULL REFERENCES public.topup_packages(id) ON DELETE CASCADE,
  stripe_session_id TEXT,
  credits_granted INTEGER NOT NULL,
  price_thb NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, topup_package_id)
);

CREATE INDEX IF NOT EXISTS idx_topup_redemptions_user ON public.topup_redemptions(user_id);

ALTER TABLE public.topup_redemptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own redemptions" ON public.topup_redemptions;
CREATE POLICY "Users can view their own redemptions"
  ON public.topup_redemptions
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- 3. Insert the Welcome Promo package
INSERT INTO public.topup_packages (
  name, credits, price_thb, stripe_price_id, is_active, sort_order,
  is_promo, bonus_percent, original_credits, one_time_per_user, badge_label
) VALUES (
  'Welcome Promo', 12250, 49.00, 'price_1TOGtA97qpzc2aQt2cf16bby', true, 0,
  true, 200, 4083, true, 'WELCOME OFFER'
)
ON CONFLICT DO NOTHING;
