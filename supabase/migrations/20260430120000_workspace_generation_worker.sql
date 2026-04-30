-- Durable worker support for Workspace background generation jobs.
--
-- Workspace generation used to rely on EdgeRuntime.waitUntil plus browser
-- polling. These columns/RPCs let pg_cron safely claim queued/running jobs
-- after the user leaves the page, while keeping a hard 30 minute deadline.

BEGIN;

ALTER TABLE public.workspace_generation_jobs
  ADD COLUMN IF NOT EXISTS run_after timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS lock_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS worker_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS notification_sent_at timestamptz;

UPDATE public.workspace_generation_jobs
SET deadline_at = COALESCE(deadline_at, COALESCE(started_at, created_at, now()) + interval '30 minutes')
WHERE deadline_at IS NULL;

ALTER TABLE public.workspace_generation_jobs
  ALTER COLUMN deadline_at SET DEFAULT (now() + interval '30 minutes'),
  ALTER COLUMN deadline_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS workspace_generation_jobs_worker_due_idx
  ON public.workspace_generation_jobs (status, run_after, lock_expires_at, created_at)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS workspace_generation_jobs_worker_deadline_idx
  ON public.workspace_generation_jobs (deadline_at, status)
  WHERE status IN ('queued', 'running');

CREATE OR REPLACE FUNCTION public.claim_workspace_generation_jobs(
  p_worker_id text,
  p_batch_size integer DEFAULT 2,
  p_lock_duration_sec integer DEFAULT 360
)
RETURNS SETOF public.workspace_generation_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT j.id
    FROM public.workspace_generation_jobs j
    WHERE j.status IN ('queued', 'running')
      AND COALESCE(j.run_after, j.created_at, now()) <= now()
      AND COALESCE(j.deadline_at, j.created_at + interval '30 minutes') > now()
      AND (j.lock_expires_at IS NULL OR j.lock_expires_at < now())
    ORDER BY j.created_at ASC
    LIMIT GREATEST(1, LEAST(COALESCE(p_batch_size, 2), 10))
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.workspace_generation_jobs j
  SET
    status = 'running',
    locked_by = p_worker_id,
    lock_expires_at = now() + make_interval(secs => GREATEST(30, COALESCE(p_lock_duration_sec, 360))),
    worker_heartbeat_at = now(),
    started_at = COALESCE(j.started_at, now()),
    updated_at = now()
  FROM candidates c
  WHERE j.id = c.id
  RETURNING j.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_workspace_generation_job(
  p_job_id uuid,
  p_worker_id text,
  p_lock_duration_sec integer DEFAULT 360
)
RETURNS public.workspace_generation_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.workspace_generation_jobs;
BEGIN
  UPDATE public.workspace_generation_jobs j
  SET
    status = 'running',
    locked_by = p_worker_id,
    lock_expires_at = now() + make_interval(secs => GREATEST(30, COALESCE(p_lock_duration_sec, 360))),
    worker_heartbeat_at = now(),
    started_at = COALESCE(j.started_at, now()),
    updated_at = now()
  WHERE j.id = p_job_id
    AND j.status IN ('queued', 'running')
    AND COALESCE(j.deadline_at, j.created_at + interval '30 minutes') > now()
    AND (j.lock_expires_at IS NULL OR j.lock_expires_at < now() OR j.locked_by = p_worker_id)
  RETURNING j.* INTO v_job;

  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_workspace_generation_job(
  p_job_id uuid,
  p_worker_id text,
  p_run_after_seconds integer DEFAULT 15
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.workspace_generation_jobs j
  SET
    locked_by = NULL,
    lock_expires_at = NULL,
    worker_heartbeat_at = now(),
    run_after = now() + make_interval(secs => GREATEST(0, COALESCE(p_run_after_seconds, 15))),
    updated_at = now()
  WHERE j.id = p_job_id
    AND j.status IN ('queued', 'running')
    AND (j.locked_by = p_worker_id OR j.locked_by IS NULL);

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_workspace_generation_jobs(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_workspace_generation_job(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_workspace_generation_job(uuid, text, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_workspace_generation_jobs(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_workspace_generation_job(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_workspace_generation_job(uuid, text, integer) TO service_role;

DO $$
BEGIN
  PERFORM cron.unschedule('workspace-generation-worker-30s-a');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('workspace-generation-worker-30s-b');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'workspace-generation-worker-30s-a',
  '* * * * *',
  $cron$
  DO $job$
  DECLARE
    v_url text;
    v_secret text;
  BEGIN
    SELECT decrypted_secret INTO v_url
      FROM vault.decrypted_secrets WHERE name = 'supabase_project_url' LIMIT 1;
    SELECT decrypted_secret INTO v_secret
      FROM vault.decrypted_secrets WHERE name = 'retry_worker_cron_secret' LIMIT 1;
    IF v_url IS NULL OR v_secret IS NULL THEN
      RAISE NOTICE '[workspace-generation-worker-cron] missing vault config, skipping';
      RETURN;
    END IF;
    IF v_url !~ '^https://[a-z0-9-]+\.supabase\.co$' THEN
      RAISE NOTICE '[workspace-generation-worker-cron] invalid URL format: %, skipping', v_url;
      RETURN;
    END IF;
    PERFORM net.http_post(
      url := v_url || '/functions/v1/workspace-run-node',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', v_secret
      ),
      body := jsonb_build_object('action', 'run_workspace_job_worker'),
      timeout_milliseconds := 395000
    );
  END $job$;
  $cron$
);

SELECT cron.schedule(
  'workspace-generation-worker-30s-b',
  '* * * * *',
  $cron$
  DO $job$
  DECLARE
    v_url text;
    v_secret text;
  BEGIN
    PERFORM pg_sleep(30);
    SELECT decrypted_secret INTO v_url
      FROM vault.decrypted_secrets WHERE name = 'supabase_project_url' LIMIT 1;
    SELECT decrypted_secret INTO v_secret
      FROM vault.decrypted_secrets WHERE name = 'retry_worker_cron_secret' LIMIT 1;
    IF v_url IS NULL OR v_secret IS NULL THEN
      RAISE NOTICE '[workspace-generation-worker-cron] missing vault config, skipping';
      RETURN;
    END IF;
    IF v_url !~ '^https://[a-z0-9-]+\.supabase\.co$' THEN
      RAISE NOTICE '[workspace-generation-worker-cron] invalid URL format: %, skipping', v_url;
      RETURN;
    END IF;
    PERFORM net.http_post(
      url := v_url || '/functions/v1/workspace-run-node',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', v_secret
      ),
      body := jsonb_build_object('action', 'run_workspace_job_worker'),
      timeout_milliseconds := 395000
    );
  END $job$;
  $cron$
);

COMMIT;
