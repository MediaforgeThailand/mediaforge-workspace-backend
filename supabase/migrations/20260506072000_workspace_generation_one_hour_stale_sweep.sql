-- Keep workspace background generations alive for the full one-hour deadline.
--
-- The old stuck-job sweep treated 300 seconds without an updated_at change as a
-- terminal worker drop and refunded immediately. That is too aggressive for
-- providers that can return quick transient errors or sit in a busy queue. The
-- edge worker owns terminal failure/refund at deadline; this sweep only releases
-- stale locks so another worker can keep trying before that deadline.

BEGIN;

ALTER TABLE public.workspace_generation_jobs
  ALTER COLUMN deadline_at SET DEFAULT (now() + interval '60 minutes');

UPDATE public.workspace_generation_jobs
SET deadline_at = GREATEST(
    deadline_at,
    COALESCE(started_at, created_at, now()) + interval '60 minutes'
  ),
  updated_at = now()
WHERE status IN ('queued', 'running')
  AND deadline_at < COALESCE(started_at, created_at, now()) + interval '60 minutes';

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
      AND COALESCE(j.deadline_at, j.created_at + interval '60 minutes') > now()
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
    AND COALESCE(j.deadline_at, j.created_at + interval '60 minutes') > now()
    AND (j.lock_expires_at IS NULL OR j.lock_expires_at < now() OR j.locked_by = p_worker_id)
  RETURNING j.* INTO v_job;

  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.sweep_workspace_stuck_jobs(
  p_stale_seconds integer DEFAULT 300
)
RETURNS TABLE(swept_id uuid, refunded integer, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job RECORD;
  v_msg text;
BEGIN
  FOR v_job IN
    SELECT *
    FROM public.workspace_generation_jobs
    WHERE status IN ('queued', 'running')
      AND updated_at < (now() - make_interval(secs => GREATEST(60, COALESCE(p_stale_seconds, 300))))
      AND COALESCE(deadline_at, created_at + interval '60 minutes') > now()
    FOR UPDATE SKIP LOCKED
  LOOP
    v_msg := 'Workspace worker had no progress heartbeat; job was released for retry before the one-hour deadline.';

    UPDATE public.workspace_generation_jobs
    SET
      status = 'running',
      locked_by = NULL,
      lock_expires_at = NULL,
      worker_heartbeat_at = now(),
      run_after = now(),
      last_error = COALESCE(last_error, v_msg),
      updated_at = now()
    WHERE id = v_job.id;

    swept_id := v_job.id;
    refunded := 0;
    reason := 'released_for_retry';
    RETURN NEXT;
  END LOOP;

  RETURN;
END;
$$;

COMMENT ON FUNCTION public.sweep_workspace_stuck_jobs(integer) IS
  'Releases stale workspace generation locks for retry before the one-hour deadline. Terminal failure/refund is handled by workspace-run-node deadline expiry.';

COMMIT;
