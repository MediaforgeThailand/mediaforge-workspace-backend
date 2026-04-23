
-- Fix: Revoke direct API access to creator_stats materialized view
REVOKE ALL ON public.creator_stats FROM anon, authenticated;

-- Grant read-only access only to authenticated users
GRANT SELECT ON public.creator_stats TO authenticated;
