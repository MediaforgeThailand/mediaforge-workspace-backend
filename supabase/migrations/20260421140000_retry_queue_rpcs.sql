-- ═══════════════════════════════════════════════════════════════════
-- Retry-queue RPCs: claim, complete, fail, cancel
-- These were applied directly to prod but never had a migration file.
-- Used by: retry-worker edge function, execute-pipeline-step
-- ═══════════════════════════════════════════════════════════════════

-- claim_retry_jobs: atomically claim a batch of pending/expired jobs
CREATE OR REPLACE FUNCTION public.claim_retry_jobs(
  p_worker_id text,
  p_batch_size integer DEFAULT 5,
  p_lock_duration_sec integer DEFAULT 300
)
RETURNS SETOF provider_retry_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  UPDATE public.provider_retry_queue q
  SET
    status = 'processing',
    locked_by = p_worker_id,
    locked_at = now(),
    lock_expires_at = now() + (p_lock_duration_sec || ' seconds')::INTERVAL,
    attempt = q.attempt + 1,
    updated_at = now()
  WHERE q.id IN (
    SELECT id FROM public.provider_retry_queue
    WHERE
      (status = 'pending' AND next_attempt_at <= now())
      OR
      (status = 'processing' AND lock_expires_at < now())
    ORDER BY next_attempt_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END; $function$;

-- complete_retry_job: mark a job as succeeded
CREATE OR REPLACE FUNCTION public.complete_retry_job(p_job_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.provider_retry_queue
  SET
    status = 'succeeded',
    completed_at = now(),
    locked_by = NULL, locked_at = NULL, lock_expires_at = NULL
  WHERE id = p_job_id;
END; $function$;

-- fail_retry_job: handle failure with backoff or mark dead/failed
CREATE OR REPLACE FUNCTION public.fail_retry_job(
  p_job_id uuid,
  p_error text,
  p_classification text
)
RETURNS TABLE(final_status retry_job_status, attempt integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.provider_retry_queue;
  v_next_delay INT;
  v_final_status public.retry_job_status;
BEGIN
  SELECT * INTO v_row FROM public.provider_retry_queue WHERE id = p_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'job_not_found';
  END IF;

  IF p_classification = 'permanent' THEN
    v_final_status := 'dead';
    UPDATE public.provider_retry_queue
    SET status = v_final_status, last_error = p_error, last_classification = p_classification,
        completed_at = now(), locked_by = NULL, locked_at = NULL, lock_expires_at = NULL
    WHERE id = p_job_id;
    RETURN QUERY SELECT v_final_status, v_row.attempt;
    RETURN;
  END IF;

  IF v_row.attempt >= v_row.max_attempts THEN
    v_final_status := 'failed';
    UPDATE public.provider_retry_queue
    SET status = v_final_status, last_error = p_error, last_classification = p_classification,
        completed_at = now(), locked_by = NULL, locked_at = NULL, lock_expires_at = NULL
    WHERE id = p_job_id;
    RETURN QUERY SELECT v_final_status, v_row.attempt;
    RETURN;
  END IF;

  v_next_delay := LEAST(30 * POWER(2, GREATEST(v_row.attempt - 4, 0))::INT, 600);

  UPDATE public.provider_retry_queue
  SET
    status = 'pending',
    last_error = p_error,
    last_classification = p_classification,
    next_attempt_at = now() + (v_next_delay || ' seconds')::INTERVAL,
    locked_by = NULL, locked_at = NULL, lock_expires_at = NULL
  WHERE id = p_job_id;

  RETURN QUERY SELECT 'pending'::public.retry_job_status, v_row.attempt;
END; $function$;

-- cancel_retry_job: admin-only cancellation
CREATE OR REPLACE FUNCTION public.cancel_retry_job(p_job_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  UPDATE public.provider_retry_queue
  SET status = 'cancelled', completed_at = now(),
      locked_by = NULL, locked_at = NULL, lock_expires_at = NULL
  WHERE id = p_job_id AND status IN ('pending', 'processing');
END; $function$;

-- Permissions
GRANT EXECUTE ON FUNCTION public.claim_retry_jobs(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_retry_job(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_retry_job(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_retry_job(uuid) TO service_role, authenticated;
