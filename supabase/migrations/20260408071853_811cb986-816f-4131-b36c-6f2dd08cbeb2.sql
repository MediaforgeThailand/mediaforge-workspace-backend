
CREATE OR REPLACE FUNCTION public.set_flow_official_from_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  -- On new flow insert, check if the creator's profile is marked as official
  SELECT p.is_official INTO NEW.is_official
  FROM public.profiles p
  WHERE p.user_id = NEW.user_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_set_flow_official
BEFORE INSERT ON public.flows
FOR EACH ROW
EXECUTE FUNCTION public.set_flow_official_from_profile();
