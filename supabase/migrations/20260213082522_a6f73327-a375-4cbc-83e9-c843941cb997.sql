
-- Add subscription tracking fields to profiles
ALTER TABLE public.profiles 
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS billing_interval text DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS current_period_end timestamp with time zone,
  ADD COLUMN IF NOT EXISTS current_plan_id uuid;

-- Add Stripe price IDs for monthly and annual to credit_packages
ALTER TABLE public.credit_packages
  ADD COLUMN IF NOT EXISTS stripe_price_id_monthly text,
  ADD COLUMN IF NOT EXISTS stripe_price_id_annual text,
  ADD COLUMN IF NOT EXISTS stripe_product_id text,
  ADD COLUMN IF NOT EXISTS annual_discount_percent numeric DEFAULT 25;

-- Create subscription settings table for global settings
CREATE TABLE IF NOT EXISTS public.subscription_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  key text NOT NULL UNIQUE,
  value text NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.subscription_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view settings"
  ON public.subscription_settings FOR SELECT
  USING (true);

CREATE POLICY "Admins can manage settings"
  ON public.subscription_settings FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role));

-- Insert default annual discount
INSERT INTO public.subscription_settings (key, value) 
VALUES ('annual_discount_percent', '25')
ON CONFLICT (key) DO NOTHING;
