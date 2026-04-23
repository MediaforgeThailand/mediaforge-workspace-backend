DO $$
DECLARE
  v_existing UUID;
BEGIN
  SELECT id INTO v_existing FROM vault.secrets WHERE name = 'retry_worker_cron_secret';
  IF v_existing IS NULL THEN
    PERFORM vault.create_secret(
      gen_random_uuid()::TEXT,
      'retry_worker_cron_secret',
      'Shared secret between pg_cron and retry-worker edge function'
    );
  END IF;

  SELECT id INTO v_existing FROM vault.secrets WHERE name = 'supabase_project_url';
  IF v_existing IS NULL THEN
    PERFORM vault.create_secret(
      'https://qywqanfbmnhcleojzwtq.supabase.co',
      'supabase_project_url',
      'Supabase project URL for internal cron calls'
    );
  END IF;
END $$;