
-- 1. เพิ่ม columns ให้ redemption_codes
ALTER TABLE public.redemption_codes 
  ADD COLUMN IF NOT EXISTS customer_email text,
  ADD COLUMN IF NOT EXISTS stripe_session_id text;

CREATE INDEX IF NOT EXISTS idx_redemption_codes_session 
  ON public.redemption_codes(stripe_session_id);

-- 2. สร้างตาราง demo_links
CREATE TABLE IF NOT EXISTS public.demo_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  credits_budget integer NOT NULL DEFAULT 5000,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_by uuid,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  redeemed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.demo_links ENABLE ROW LEVEL SECURITY;

-- RLS: Admin can manage, service_role bypasses RLS automatically
CREATE POLICY "Admins can manage demo_links"
  ON public.demo_links FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Anyone can read active demo_links by token"
  ON public.demo_links FOR SELECT
  TO anon, authenticated
  USING (is_active = true AND expires_at > now());

-- 3. สร้างตาราง demo_budget
CREATE TABLE IF NOT EXISTS public.demo_budget (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month text NOT NULL UNIQUE,
  total_credits_granted integer NOT NULL DEFAULT 0,
  max_monthly_credits integer NOT NULL DEFAULT 100000,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.demo_budget ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage demo_budget"
  ON public.demo_budget FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Service role full access demo_budget"
  ON public.demo_budget FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role full access demo_links"
  ON public.demo_links FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
