-- Fix: trigger must also fire when markup_multiplier_override changes,
-- otherwise ERP overrides don't recompute selling_price.
DROP TRIGGER IF EXISTS trg_compute_flow_pricing ON public.flows;

CREATE TRIGGER trg_compute_flow_pricing
  BEFORE INSERT OR UPDATE OF api_cost, markup_multiplier, markup_multiplier_override, performance_bonus_percent
  ON public.flows
  FOR EACH ROW
  EXECUTE FUNCTION public.compute_flow_pricing();

-- Backfill: recompute every flow that has an override but stale selling_price
UPDATE public.flows
SET api_cost = api_cost
WHERE markup_multiplier_override IS NOT NULL;