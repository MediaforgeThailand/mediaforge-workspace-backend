
-- Table for redemption codes created by ERP
CREATE TABLE public.redemption_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  plan_id uuid REFERENCES public.subscription_plans(id),
  plan_name text NOT NULL DEFAULT 'Redemption',
  billing_cycle text NOT NULL DEFAULT '1_month',
  credits integer NOT NULL DEFAULT 1000,
  price_thb numeric(10,2) DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'redeemed', 'expired')),
  redeemed_by uuid,
  redeemed_at timestamptz,
  expires_at timestamptz DEFAULT (now() + interval '30 days'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for fast code lookup
CREATE INDEX idx_redemption_codes_code ON public.redemption_codes(code);
CREATE INDEX idx_redemption_codes_status ON public.redemption_codes(status);

-- RLS: only service role can access (edge functions use service role key)
ALTER TABLE public.redemption_codes ENABLE ROW LEVEL SECURITY;

-- No public policies = only service_role can read/write
