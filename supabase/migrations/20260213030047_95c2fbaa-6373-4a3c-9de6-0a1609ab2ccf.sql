
-- 1) User Credits table
CREATE TABLE public.user_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  balance integer NOT NULL DEFAULT 0,
  total_purchased integer NOT NULL DEFAULT 0,
  total_used integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.user_credits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own credits" ON public.user_credits FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own credits" ON public.user_credits FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own credits" ON public.user_credits FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Admins can view all credits" ON public.user_credits FOR SELECT USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins can update all credits" ON public.user_credits FOR UPDATE USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_user_credits_updated_at BEFORE UPDATE ON public.user_credits
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2) Credit Transactions log
CREATE TABLE public.credit_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  amount integer NOT NULL,
  type text NOT NULL CHECK (type IN ('purchase', 'usage', 'bonus', 'refund', 'admin_adjustment')),
  description text,
  feature text,
  reference_id text,
  balance_after integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own transactions" ON public.credit_transactions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own transactions" ON public.credit_transactions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Admins can view all transactions" ON public.credit_transactions FOR SELECT USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins can insert transactions" ON public.credit_transactions FOR INSERT WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- 3) Credit Packages (purchasable)
CREATE TABLE public.credit_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  credits integer NOT NULL,
  price_thb numeric(10,2) NOT NULL,
  stripe_price_id text,
  is_popular boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.credit_packages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view active packages" ON public.credit_packages FOR SELECT USING (is_active = true);
CREATE POLICY "Admins can manage packages" ON public.credit_packages FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- 4) Credit Costs (per feature)
CREATE TABLE public.credit_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature text NOT NULL UNIQUE,
  cost integer NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.credit_costs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view costs" ON public.credit_costs FOR SELECT USING (true);
CREATE POLICY "Admins can manage costs" ON public.credit_costs FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- 5) Payment Transactions (Stripe)
CREATE TABLE public.payment_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  package_id uuid REFERENCES public.credit_packages(id),
  stripe_session_id text,
  stripe_payment_intent_id text,
  amount_thb numeric(10,2) NOT NULL,
  credits_added integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  payment_method text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.payment_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own payments" ON public.payment_transactions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own payments" ON public.payment_transactions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Admins can view all payments" ON public.payment_transactions FOR SELECT USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins can update payments" ON public.payment_transactions FOR UPDATE USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_payment_transactions_updated_at BEFORE UPDATE ON public.payment_transactions
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 6) Update handle_new_user to grant 50 welcome credits
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email));
  
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'user');
  
  -- Grant 50 welcome credits
  INSERT INTO public.user_credits (user_id, balance, total_purchased)
  VALUES (NEW.id, 50, 0);
  
  INSERT INTO public.credit_transactions (user_id, amount, type, description, balance_after)
  VALUES (NEW.id, 50, 'bonus', 'Welcome bonus credits', 50);
  
  RETURN NEW;
END;
$function$;

-- 7) Insert default credit costs
INSERT INTO public.credit_costs (feature, cost, label) VALUES
  ('text_to_video', 10, 'Text to Video'),
  ('image_to_video', 15, 'Image to Video'),
  ('generate_image', 3, 'Generate Image'),
  ('upscale_image', 5, 'Upscale Image'),
  ('remove_background', 2, 'Remove Background'),
  ('lip_sync', 20, 'Lip Sync'),
  ('text_to_speech', 1, 'Text to Speech');

-- 8) Insert default credit packages
INSERT INTO public.credit_packages (name, credits, price_thb, is_popular, sort_order) VALUES
  ('Starter', 100, 99.00, false, 1),
  ('Popular', 500, 399.00, true, 2),
  ('Pro', 1500, 999.00, false, 3),
  ('Agency', 5000, 2999.00, false, 4);
