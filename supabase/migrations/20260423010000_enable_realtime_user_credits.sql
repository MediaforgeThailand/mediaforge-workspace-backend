-- Enable realtime on user_credits so balance changes are pushed to clients
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'user_credits'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_credits;
  END IF;
END $$;
