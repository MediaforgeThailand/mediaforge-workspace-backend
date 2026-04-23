
-- 1. Make ai-media bucket private
UPDATE storage.buckets SET public = false WHERE id = 'ai-media';

-- 2. Revoke direct API access to creator_stats materialized view
REVOKE SELECT ON public.creator_stats FROM anon, authenticated;

-- 3. Create a secure RPC to access creator stats (own stats only or admin)
CREATE OR REPLACE FUNCTION public.get_my_creator_stats()
RETURNS TABLE(
  creator_id uuid,
  total_flows bigint,
  total_uses bigint,
  total_credits_earned integer,
  avg_rating numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  SELECT cs.creator_id, cs.total_flows, cs.total_uses, cs.total_credits_earned, cs.avg_rating
  FROM public.creator_stats cs
  WHERE cs.creator_id = auth.uid();
END;
$$;
