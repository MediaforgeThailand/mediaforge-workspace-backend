-- ═══════════════════════════════════════════════════════════════════
-- Fix: prevent cron from invoking retry-worker on the wrong env
-- ═══════════════════════════════════════════════════════════════════

-- 1. Remove the (possibly wrong-env) hardcoded URL secret
DELETE FROM vault.secrets WHERE name = 'supabase_project_url';

-- 2. Reschedule cron jobs with a safety guard:
--    - Only fire if vault secret exists AND looks like a valid supabase URL
--    - This prevents the Test-URL leak when the migration runs on Live
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
  DO $job$
  DECLARE
    v_url TEXT;
    v_secret TEXT;
  BEGIN
    SELECT decrypted_secret INTO v_url
      FROM vault.decrypted_secrets WHERE name = 'supabase_project_url' LIMIT 1;
    SELECT decrypted_secret INTO v_secret
      FROM vault.decrypted_secrets WHERE name = 'retry_worker_cron_secret' LIMIT 1;
    IF v_url IS NULL OR v_secret IS NULL THEN
      RAISE NOTICE '[retry-worker-cron] missing vault config, skipping';
      RETURN;
    END IF;
    IF v_url !~ '^https://[a-z0-9-]+\.supabase\.co$' THEN
      RAISE NOTICE '[retry-worker-cron] invalid URL format: %, skipping', v_url;
      RETURN;
    END IF;
    PERFORM net.http_post(
      url := v_url || '/functions/v1/retry-worker',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', v_secret
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 395000
    );
  END $job$;
  $cron$
);

SELECT cron.schedule(
  'retry-worker-30s-b',
  '* * * * *',
  $cron$
  DO $job$
  DECLARE
    v_url TEXT;
    v_secret TEXT;
  BEGIN
    PERFORM pg_sleep(30);
    SELECT decrypted_secret INTO v_url
      FROM vault.decrypted_secrets WHERE name = 'supabase_project_url' LIMIT 1;
    SELECT decrypted_secret INTO v_secret
      FROM vault.decrypted_secrets WHERE name = 'retry_worker_cron_secret' LIMIT 1;
    IF v_url IS NULL OR v_secret IS NULL THEN
      RAISE NOTICE '[retry-worker-cron] missing vault config, skipping';
      RETURN;
    END IF;
    IF v_url !~ '^https://[a-z0-9-]+\.supabase\.co$' THEN
      RAISE NOTICE '[retry-worker-cron] invalid URL format: %, skipping', v_url;
      RETURN;
    END IF;
    PERFORM net.http_post(
      url := v_url || '/functions/v1/retry-worker',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', v_secret
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 395000
    );
  END $job$;
  $cron$
);
