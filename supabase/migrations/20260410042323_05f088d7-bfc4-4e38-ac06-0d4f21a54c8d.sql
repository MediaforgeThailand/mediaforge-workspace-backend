ALTER TABLE public.flows ALTER COLUMN markup_multiplier SET DEFAULT 4.0;

CREATE OR REPLACE FUNCTION public.calculate_flow_pricing(p_api_cost integer, p_tier text DEFAULT 'standard'::text)
 RETURNS TABLE(selling_price integer, contribution_margin integer, creator_payout integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_multiplier numeric := 4.0;
  v_revshare numeric := 0.20;
BEGIN
  selling_price := CEIL(p_api_cost * v_multiplier);
  contribution_margin := selling_price - p_api_cost;
  creator_payout := CEIL(contribution_margin * v_revshare);
  RETURN NEXT;
END;
$function$;