-- Add dismissed_at column to allow users to hide failed processing cards from Library
ALTER TABLE public.flow_runs
ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;

-- Index for efficient querying of active processing cards (running OR recent failed not dismissed)
CREATE INDEX IF NOT EXISTS idx_flow_runs_user_processing
ON public.flow_runs (user_id, status, started_at DESC)
WHERE status IN ('running', 'pending', 'failed') AND dismissed_at IS NULL;

-- Enable realtime so all devices for the same account see live updates
ALTER TABLE public.flow_runs REPLICA IDENTITY FULL;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.flow_runs;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;