ALTER TABLE public.flows
  ADD COLUMN IF NOT EXISTS markup_multiplier_override numeric;

ALTER TABLE public.flows
  DROP CONSTRAINT IF EXISTS flows_markup_multiplier_override_min;
ALTER TABLE public.flows
  ADD CONSTRAINT flows_markup_multiplier_override_min
    CHECK (markup_multiplier_override IS NULL OR markup_multiplier_override >= 1.0);

CREATE OR REPLACE FUNCTION public.compute_flow_pricing()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_multiplier numeric;
  v_bonus numeric;
  v_effective_revshare numeric;
BEGIN
  IF NEW.api_cost IS NULL THEN
    NEW.selling_price := NULL;
    NEW.contribution_margin := NULL;
    NEW.creator_payout := NULL;
    RETURN NEW;
  END IF;

  v_multiplier := COALESCE(NEW.markup_multiplier_override, NEW.markup_multiplier, 4.0);
  v_bonus := COALESCE(NEW.performance_bonus_percent, 0);
  v_effective_revshare := LEAST(0.20 + v_bonus / 100.0, 0.50);

  NEW.selling_price := CEIL(NEW.api_cost * v_multiplier);
  NEW.contribution_margin := NEW.selling_price - NEW.api_cost;
  NEW.creator_payout := CEIL(NEW.contribution_margin * v_effective_revshare);

  RETURN NEW;
END;
$function$;

INSERT INTO public.subscription_settings (key, value)
VALUES ('nano_banana_tier_override', 'auto')
ON CONFLICT (key) DO NOTHING;

UPDATE public.flows SET api_cost = api_cost WHERE api_cost IS NOT NULL;