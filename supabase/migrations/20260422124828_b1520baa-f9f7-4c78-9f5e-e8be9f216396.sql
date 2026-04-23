
-- 1. Add 'dead_letter' to retry_job_status enum
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'dead_letter'
      AND enumtypid = 'public.retry_job_status'::regtype
  ) THEN
    ALTER TYPE public.retry_job_status ADD VALUE 'dead_letter';
  END IF;
END$$;

-- 2. Create dead-letter table
CREATE TABLE IF NOT EXISTS public.retry_queue_dead_letter (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_job_id UUID NOT NULL,
  flow_run_id UUID,
  step_index INTEGER,
  task_type TEXT NOT NULL,
  provider TEXT,
  payload JSONB NOT NULL,
  final_error TEXT,
  total_attempts INT NOT NULL,
  moved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  moved_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_retry_dlq_original_job
  ON public.retry_queue_dead_letter(original_job_id);
CREATE INDEX IF NOT EXISTS idx_retry_dlq_flow_run
  ON public.retry_queue_dead_letter(flow_run_id);
CREATE INDEX IF NOT EXISTS idx_retry_dlq_moved_at
  ON public.retry_queue_dead_letter(moved_at DESC);

ALTER TABLE public.retry_queue_dead_letter ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_full_dlq" ON public.retry_queue_dead_letter;
CREATE POLICY "admin_full_dlq"
  ON public.retry_queue_dead_letter
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'::app_role
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'::app_role
    )
  );

-- 3. Function: recover stuck "processing" jobs older than threshold
CREATE OR REPLACE FUNCTION public.recover_stuck_retry_jobs(p_stuck_after_minutes INT DEFAULT 10)
RETURNS TABLE(recovered_id UUID, prior_locked_by TEXT, prior_attempt INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.provider_retry_queue q
  SET
    status = 'pending'::retry_job_status,
    locked_by = NULL,
    locked_at = NULL,
    lock_expires_at = NULL,
    next_attempt_at = now(),
    updated_at = now()
  WHERE q.status = 'processing'::retry_job_status
    AND q.updated_at < now() - make_interval(mins => p_stuck_after_minutes)
  RETURNING q.id, q.locked_by, q.attempt;
END;
$$;

-- 4. Function: escalate a job to dead-letter
CREATE OR REPLACE FUNCTION public.escalate_to_dead_letter(
  p_job_id UUID,
  p_final_error TEXT,
  p_moved_by TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.provider_retry_queue%ROWTYPE;
  v_dlq_id UUID;
BEGIN
  SELECT * INTO v_job
  FROM public.provider_retry_queue
  WHERE id = p_job_id
  FOR UPDATE;

  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'job_not_found: %', p_job_id;
  END IF;

  -- Idempotency: if already dead-lettered, just return existing dlq row
  SELECT id INTO v_dlq_id
  FROM public.retry_queue_dead_letter
  WHERE original_job_id = p_job_id
  LIMIT 1;

  IF v_dlq_id IS NOT NULL THEN
    RETURN v_dlq_id;
  END IF;

  INSERT INTO public.retry_queue_dead_letter (
    original_job_id, flow_run_id, step_index,
    task_type, provider, payload,
    final_error, total_attempts, moved_by
  ) VALUES (
    v_job.id, v_job.flow_run_id, v_job.step_index,
    COALESCE(v_job.node_type, 'unknown'), v_job.provider, v_job.resume_payload,
    COALESCE(p_final_error, v_job.last_error, 'max_attempts_exceeded'),
    v_job.attempt, p_moved_by
  )
  RETURNING id INTO v_dlq_id;

  UPDATE public.provider_retry_queue
  SET status = 'dead_letter'::retry_job_status,
      completed_at = now(),
      locked_by = NULL,
      locked_at = NULL,
      lock_expires_at = NULL,
      last_error = COALESCE(p_final_error, last_error),
      updated_at = now()
  WHERE id = p_job_id;

  RETURN v_dlq_id;
END;
$$;

-- 5. Function: release worker locks gracefully (for SIGTERM handling)
CREATE OR REPLACE FUNCTION public.release_worker_locks(p_worker_id TEXT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  WITH released AS (
    UPDATE public.provider_retry_queue
    SET status = 'pending'::retry_job_status,
        locked_by = NULL,
        locked_at = NULL,
        lock_expires_at = NULL,
        next_attempt_at = now(),
        updated_at = now()
    WHERE locked_by = p_worker_id
      AND status = 'processing'::retry_job_status
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM released;
  RETURN v_count;
END;
$$;
