
CREATE OR REPLACE FUNCTION public.cleanup_old_analytics_rpc()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM public.analytics_events WHERE created_at < now() - interval '180 days';
  DELETE FROM public.api_usage_logs WHERE created_at < now() - interval '90 days';
  DELETE FROM public.rate_limits WHERE created_at < now() - interval '5 minutes';
END;
$$;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
