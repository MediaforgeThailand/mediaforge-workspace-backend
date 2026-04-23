
-- 1. Add governance columns to flows
ALTER TABLE public.flows
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS api_cost integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS selling_price integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS contribution_margin integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS creator_payout integer NOT NULL DEFAULT 0;

-- 2. Admin accounts (isolated from auth.users)
CREATE TABLE IF NOT EXISTS public.admin_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  admin_role text NOT NULL DEFAULT 'review_admin',
  is_active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.admin_accounts(id)
);
ALTER TABLE public.admin_accounts ENABLE ROW LEVEL SECURITY;
-- No public access at all — only service_role can touch this table
CREATE POLICY "No public access" ON public.admin_accounts FOR ALL USING (false);

-- 3. Flow reviews
CREATE TABLE IF NOT EXISTS public.flow_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL REFERENCES public.admin_accounts(id),
  output_quality integer NOT NULL DEFAULT 0,
  consistency integer NOT NULL DEFAULT 0,
  commercial_usability integer NOT NULL DEFAULT 0,
  originality integer NOT NULL DEFAULT 0,
  efficiency integer NOT NULL DEFAULT 0,
  workflow_clarity integer NOT NULL DEFAULT 0,
  safety integer NOT NULL DEFAULT 0,
  total_score integer GENERATED ALWAYS AS (
    output_quality + consistency + commercial_usability + originality + efficiency + workflow_clarity + safety
  ) STORED,
  suggested_tier text,
  assigned_tier text,
  decision text NOT NULL DEFAULT 'pending',
  reviewer_notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.flow_reviews ENABLE ROW LEVEL SECURITY;
-- No public access — only service_role (edge functions)
CREATE POLICY "No public access" ON public.flow_reviews FOR ALL USING (false);
-- Creators can read reviews of their own flows
CREATE POLICY "Creators can view own flow reviews" ON public.flow_reviews FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.flows WHERE flows.id = flow_reviews.flow_id AND flows.user_id = auth.uid()
  ));

-- 4. Flow badges
CREATE TABLE IF NOT EXISTS public.flow_badges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  badge text NOT NULL,
  assigned_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flow_id, badge)
);
ALTER TABLE public.flow_badges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read badges of published flows" ON public.flow_badges FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.flows WHERE flows.id = flow_badges.flow_id AND flows.status = 'published'
  ));
CREATE POLICY "No public write" ON public.flow_badges FOR ALL USING (false);

-- 5. Flow metrics
CREATE TABLE IF NOT EXISTS public.flow_metrics (
  flow_id uuid PRIMARY KEY REFERENCES public.flows(id) ON DELETE CASCADE,
  total_runs integer NOT NULL DEFAULT 0,
  total_revenue integer NOT NULL DEFAULT 0,
  avg_rating numeric DEFAULT 0,
  last_run_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.flow_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read metrics of published flows" ON public.flow_metrics FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.flows WHERE flows.id = flow_metrics.flow_id AND flows.status = 'published'
  ));
CREATE POLICY "No public write" ON public.flow_metrics FOR ALL USING (false);

-- 6. Pricing helper RPC
CREATE OR REPLACE FUNCTION public.calculate_flow_pricing(p_api_cost integer, p_tier text)
RETURNS TABLE(selling_price integer, contribution_margin integer, creator_payout integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_multiplier numeric;
  v_revshare numeric;
BEGIN
  v_multiplier := CASE p_tier
    WHEN 'standard' THEN 2.5
    WHEN 'pro' THEN 3.0
    WHEN 'signature' THEN 3.5
    ELSE 2.5
  END;
  v_revshare := CASE p_tier
    WHEN 'standard' THEN 0.20
    WHEN 'pro' THEN 0.25
    WHEN 'signature' THEN 0.30
    ELSE 0.20
  END;
  selling_price := CEIL(p_api_cost * v_multiplier);
  contribution_margin := selling_price - p_api_cost;
  creator_payout := CEIL(contribution_margin * v_revshare);
  RETURN NEXT;
END;
$$;

-- 7. Update delete_flow_with_dependencies to handle new tables
CREATE OR REPLACE FUNCTION public.delete_flow_with_dependencies(p_flow_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_owner_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  SELECT user_id INTO v_owner_id FROM public.flows WHERE id = p_flow_id;
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Flow not found';
  END IF;
  IF v_owner_id <> auth.uid() AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Not authorized to delete this flow';
  END IF;
  DELETE FROM public.flow_metrics WHERE flow_id = p_flow_id;
  DELETE FROM public.flow_badges WHERE flow_id = p_flow_id;
  DELETE FROM public.flow_reviews WHERE flow_id = p_flow_id;
  DELETE FROM public.flow_test_runs WHERE flow_id = p_flow_id;
  DELETE FROM public.flow_runs WHERE flow_id = p_flow_id;
  DELETE FROM public.flow_versions WHERE flow_id = p_flow_id;
  DELETE FROM public.flow_nodes WHERE flow_id = p_flow_id;
  DELETE FROM public.flows WHERE id = p_flow_id;
  RETURN true;
END;
$$;
