-- Drop tier column from flows
ALTER TABLE public.flows DROP COLUMN IF EXISTS tier;

-- Drop tier columns from flow_reviews
ALTER TABLE public.flow_reviews DROP COLUMN IF EXISTS suggested_tier;
ALTER TABLE public.flow_reviews DROP COLUMN IF EXISTS assigned_tier;

-- Update calculate_flow_pricing to use flat pricing (no tier parameter needed but keep signature for compatibility)
CREATE OR REPLACE FUNCTION public.calculate_flow_pricing(p_api_cost integer, p_tier text DEFAULT 'standard')
 RETURNS TABLE(selling_price integer, contribution_margin integer, creator_payout integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_multiplier numeric := 2.5;
  v_revshare numeric := 0.20;
BEGIN
  selling_price := CEIL(p_api_cost * v_multiplier);
  contribution_margin := selling_price - p_api_cost;
  creator_payout := CEIL(contribution_margin * v_revshare);
  RETURN NEXT;
END;
$function$;