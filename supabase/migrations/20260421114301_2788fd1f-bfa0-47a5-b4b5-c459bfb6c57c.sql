DO $$
BEGIN
  PERFORM cron.unschedule('retry-worker-30s-a');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('retry-worker-30s-b');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'retry-worker-30s-a',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_project_url')
           || '/functions/v1/retry-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'retry_worker_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 395000
  );
  $cron$
);

SELECT cron.schedule(
  'retry-worker-30s-b',
  '* * * * *',
  $cron$
  SELECT pg_sleep(30);
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_project_url')
           || '/functions/v1/retry-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'retry_worker_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 395000
  );
  $cron$
);