-- Enable realtime on flow_runs for progress streaming
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.flow_runs;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;