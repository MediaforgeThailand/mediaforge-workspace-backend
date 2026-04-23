
-- Drop the analytics_events table and its related trigger/function
-- (table may already be dropped by 20260414120000_drop_analytics_events.sql)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'analytics_events') THEN
    DROP TRIGGER IF EXISTS trigger_cleanup_analytics ON public.analytics_events;
    DROP TABLE IF EXISTS public.analytics_events;
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.cleanup_old_analytics();
