-- Optimize realtime publication for scale (10k+ users)
-- Only keep tables essential for core UX:
--   flow_runs     — live execution status
--   notifications — real-time notification badges
--   user_credits  — balance updates after runs/topups
--
-- Removed credit_costs (admin-only, rare changes) and
-- processing_jobs (no frontend subscriber).

-- Remove non-essential tables
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime DROP TABLE public.credit_costs;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime DROP TABLE public.processing_jobs;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- Ensure essential tables are present
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.flow_runs;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.user_credits;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Ensure REPLICA IDENTITY FULL for realtime tables
ALTER TABLE public.flow_runs REPLICA IDENTITY FULL;
ALTER TABLE public.notifications REPLICA IDENTITY FULL;
ALTER TABLE public.user_credits REPLICA IDENTITY FULL;
