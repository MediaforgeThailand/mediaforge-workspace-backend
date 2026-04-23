
-- Schedule daily cleanup at 3:00 AM UTC via pg_cron
-- Replaces the per-insert trigger which was inefficient (DELETE scan on every insert)

-- 1. Drop the per-insert trigger (no longer needed)
DROP TRIGGER IF EXISTS trigger_cleanup_old_api_logs ON public.api_usage_logs;
DROP FUNCTION IF EXISTS public.cleanup_old_api_logs();

-- 2. Schedule the existing RPC to run daily at 3 AM UTC
SELECT cron.schedule(
  'cleanup-old-analytics',
  '0 3 * * *',
  $$SELECT public.cleanup_old_analytics_rpc()$$
);
