
-- Credit batches: tracks individual credit allocations with source and expiry
CREATE TABLE public.credit_batches (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'subscription', -- 'subscription' or 'topup'
  amount INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  reference_id TEXT, -- stripe session id or package id
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Index for efficient consumption queries (use top-up first, then by expiry)
CREATE INDEX idx_credit_batches_consumption ON public.credit_batches (user_id, source_type, expires_at ASC)
  WHERE remaining > 0;

-- Enable RLS
ALTER TABLE public.credit_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own batches" ON public.credit_batches
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own batches" ON public.credit_batches
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own batches" ON public.credit_batches
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all batches" ON public.credit_batches
  FOR SELECT USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can manage all batches" ON public.credit_batches
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role));

-- Top-up packages
CREATE TABLE public.topup_packages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  credits INTEGER NOT NULL,
  price_thb NUMERIC NOT NULL,
  stripe_price_id TEXT,
  stripe_product_id TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.topup_packages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view active topup packages" ON public.topup_packages
  FOR SELECT USING (auth.uid() IS NOT NULL AND is_active = true);

CREATE POLICY "Admins can manage topup packages" ON public.topup_packages
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role));

-- Insert default top-up packages (monthly rate 0.04 THB/credit × 1.25 = 0.05 THB/credit)
INSERT INTO public.topup_packages (name, credits, price_thb, sort_order) VALUES
  ('Top-up S', 1000, 50, 1),
  ('Top-up M', 2500, 125, 2),
  ('Top-up L', 5000, 250, 3),
  ('Top-up XL', 10000, 500, 4),
  ('Top-up XXL', 25000, 1250, 5);
