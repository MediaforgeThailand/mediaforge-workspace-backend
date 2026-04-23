-- Fix 1: Add input validation to check_rate_limit function
CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_user_id uuid,
  p_endpoint text,
  p_max_requests integer DEFAULT 30,
  p_window_seconds integer DEFAULT 60
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  request_count integer;
BEGIN
  -- Validate inputs
  IF p_max_requests < 1 OR p_max_requests > 1000 THEN
    RAISE EXCEPTION 'Invalid max_requests: must be 1-1000';
  END IF;
  
  IF p_window_seconds < 1 OR p_window_seconds > 3600 THEN
    RAISE EXCEPTION 'Invalid window_seconds: must be 1-3600';
  END IF;
  
  IF length(p_endpoint) > 100 THEN
    RAISE EXCEPTION 'Endpoint name too long';
  END IF;

  -- Count requests in the window using make_interval (safer than string concat)
  SELECT count(*) INTO request_count
  FROM public.rate_limits
  WHERE user_id = p_user_id
    AND endpoint = p_endpoint
    AND created_at > now() - make_interval(secs => p_window_seconds);

  IF request_count >= p_max_requests THEN
    RETURN false;
  END IF;

  -- Record this request
  INSERT INTO public.rate_limits (user_id, endpoint) VALUES (p_user_id, p_endpoint);
  RETURN true;
END;
$$;

-- Fix 2: Restrict credit_costs to authenticated users only
DROP POLICY IF EXISTS "Anyone can view costs" ON public.credit_costs;
CREATE POLICY "Authenticated users can view costs"
  ON public.credit_costs
  FOR SELECT
  USING (auth.uid() IS NOT NULL);