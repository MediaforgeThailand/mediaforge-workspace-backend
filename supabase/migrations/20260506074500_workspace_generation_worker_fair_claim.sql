-- Claim due workspace generation jobs by retry time, not by original creation
-- time. Older jobs that are backing off should not block newer due jobs from
-- other providers.

BEGIN;

CREATE OR REPLACE FUNCTION public.claim_workspace_generation_jobs(
  p_worker_id text,
  p_batch_size integer DEFAULT 8,
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
    ORDER BY COALESCE(j.run_after, j.created_at, now()) ASC, j.created_at ASC
    LIMIT GREATEST(1, LEAST(COALESCE(p_batch_size, 8), 10))
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

COMMIT;
