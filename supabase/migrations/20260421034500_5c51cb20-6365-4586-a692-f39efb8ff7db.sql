-- 1. Add CHECK constraints to guard against negative margins / over-cap revshare
ALTER TABLE public.flows
  ADD CONSTRAINT flows_markup_multiplier_min
    CHECK (markup_multiplier IS NULL OR markup_multiplier >= 1.0);

ALTER TABLE public.flows
  ADD CONSTRAINT flows_performance_bonus_range
    CHECK (performance_bonus_percent IS NULL OR performance_bonus_percent BETWEEN 0 AND 30);

-- 2. Trigger function: compute 3 derived pricing fields from api_cost
CREATE OR REPLACE FUNCTION public.compute_flow_pricing()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_multiplier numeric;
  v_bonus numeric;
  v_effective_revshare numeric;
BEGIN
  -- If api_cost is NULL, null out the 3 derived columns
  IF NEW.api_cost IS NULL THEN
    NEW.selling_price := NULL;
    NEW.contribution_margin := NULL;
    NEW.creator_payout := NULL;
    RETURN NEW;
  END IF;

  v_multiplier := COALESCE(NEW.markup_multiplier, 4.0);
  v_bonus := COALESCE(NEW.performance_bonus_percent, 0);

  -- Cap effective revshare at 0.50
  v_effective_revshare := LEAST(0.20 + v_bonus / 100.0, 0.50);

  NEW.selling_price := CEIL(NEW.api_cost * v_multiplier);
  NEW.contribution_margin := NEW.selling_price - NEW.api_cost;
  NEW.creator_payout := CEIL(NEW.contribution_margin * v_effective_revshare);

  RETURN NEW;
END;
$$;

-- 3. BEFORE INSERT OR UPDATE trigger on flows
DROP TRIGGER IF EXISTS trg_compute_flow_pricing ON public.flows;
CREATE TRIGGER trg_compute_flow_pricing
  BEFORE INSERT OR UPDATE OF api_cost, markup_multiplier, performance_bonus_percent
  ON public.flows
  FOR EACH ROW
  EXECUTE FUNCTION public.compute_flow_pricing();

-- 4. Backfill: fire trigger on every existing row to recompute derived fields
UPDATE public.flows SET api_cost = api_cost WHERE api_cost IS NOT NULL;