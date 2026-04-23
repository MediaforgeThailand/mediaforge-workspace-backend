DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.credit_costs;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;