
-- ═══════════════════════════════════════════════════════════
-- 1. Create subscription_plans table
-- ═══════════════════════════════════════════════════════════

CREATE TABLE public.subscription_plans (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  target text NOT NULL DEFAULT 'user',
  billing_cycle text NOT NULL DEFAULT 'monthly',
  price_thb integer NOT NULL DEFAULT 0,
  upfront_credits integer NOT NULL DEFAULT 0,
  flow_quota integer,
  discount_official numeric(5,2) NOT NULL DEFAULT 0,
  discount_community numeric(5,2) NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view active plans"
  ON public.subscription_plans FOR SELECT
  USING (auth.uid() IS NOT NULL AND is_active = true);

CREATE POLICY "Admins can manage plans"
  ON public.subscription_plans FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role));

-- ═══════════════════════════════════════════════════════════
-- 2. Seed User tiers (4) — Monthly pricing (1 THB = 25 credits)
-- ═══════════════════════════════════════════════════════════

INSERT INTO public.subscription_plans (name, target, billing_cycle, price_thb, upfront_credits, flow_quota, discount_official, discount_community, sort_order) VALUES
  ('Starter',     'user', 'monthly',   0,      0,     5,   0,    0,   1),
  ('Basic',       'user', 'monthly', 299,   7475,    20,  10,    5,   2),
  ('Pro',         'user', 'monthly', 799,  19975,   100,  15,   10,   3),
  ('Enterprise',  'user', 'monthly', 1999, 49975,  NULL,  20,   15,   4),
  ('Starter',     'user', 'annual',    0,      0,     5,   0,    0,   5),
  ('Basic',       'user', 'annual',  2690,  67250,   20,  10,    5,   6),
  ('Pro',         'user', 'annual',  7190, 179750,  100,  15,   10,   7),
  ('Enterprise',  'user', 'annual', 17990, 449750, NULL,  20,   15,   8);

-- Seed Creator tiers (3) — Monthly
INSERT INTO public.subscription_plans (name, target, billing_cycle, price_thb, upfront_credits, flow_quota, discount_official, discount_community, sort_order) VALUES
  ('Hobbyist',  'creator', 'monthly',    0,     0,   3,  0,   0,   9),
  ('Pro',       'creator', 'monthly',  499, 12475,  25, 10,   5,  10),
  ('Studio',    'creator', 'monthly', 1499, 37475, NULL, 15,  10,  11),
  ('Hobbyist',  'creator', 'annual',     0,     0,   3,  0,   0,  12),
  ('Pro',       'creator', 'annual',   4490, 112250, 25, 10,   5,  13),
  ('Studio',    'creator', 'annual',  13490, 337250, NULL, 15, 10,  14);

-- ═══════════════════════════════════════════════════════════
-- 3. Update profiles table — add subscription_plan_id and creator_rank
-- ═══════════════════════════════════════════════════════════

CREATE TYPE public.creator_rank AS ENUM ('novice', 'rising_star', 'top_rated', 'elite');

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS subscription_plan_id uuid REFERENCES public.subscription_plans(id),
  ADD COLUMN IF NOT EXISTS creator_rank public.creator_rank NOT NULL DEFAULT 'novice';

-- ═══════════════════════════════════════════════════════════
-- 4. Update flows table — add is_official flag
-- ═══════════════════════════════════════════════════════════

ALTER TABLE public.flows
  ADD COLUMN IF NOT EXISTS is_official boolean NOT NULL DEFAULT false;

-- ═══════════════════════════════════════════════════════════
-- 5. Create creator_stats materialized view
-- ═══════════════════════════════════════════════════════════

CREATE MATERIALIZED VIEW public.creator_stats AS
SELECT
  f.user_id AS creator_id,
  COUNT(DISTINCT f.id) AS total_flows,
  COUNT(fr.id) AS total_uses,
  COALESCE(SUM(fr.credits_used), 0)::integer AS total_credits_earned,
  ROUND(AVG(CASE WHEN fr.status = 'completed' THEN 1.0 ELSE 0.0 END) * 5, 2) AS avg_rating
FROM public.flows f
LEFT JOIN public.flow_runs fr ON fr.flow_id = f.id AND fr.user_id != f.user_id
GROUP BY f.user_id;

CREATE UNIQUE INDEX idx_creator_stats_creator_id ON public.creator_stats (creator_id);

-- ═══════════════════════════════════════════════════════════
-- 6. Updated_at trigger for subscription_plans
-- ═══════════════════════════════════════════════════════════

CREATE TRIGGER update_subscription_plans_updated_at
  BEFORE UPDATE ON public.subscription_plans
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
