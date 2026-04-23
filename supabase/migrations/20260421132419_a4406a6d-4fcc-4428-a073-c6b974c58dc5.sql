-- Idempotent: create table only if missing
CREATE TABLE IF NOT EXISTS public.provider_retry_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_run_id UUID NOT NULL REFERENCES public.flow_runs(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  node_id TEXT,
  provider TEXT NOT NULL,
  node_type TEXT NOT NULL,
  resume_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status public.retry_job_status NOT NULL DEFAULT 'pending',
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 14,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  last_classification TEXT,
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  lock_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS retry_queue_step_unique
  ON public.provider_retry_queue(flow_run_id, step_index);
CREATE INDEX IF NOT EXISTS idx_retry_queue_pending_due
  ON public.provider_retry_queue(next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_retry_queue_processing_expired
  ON public.provider_retry_queue(lock_expires_at) WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS idx_retry_queue_flow_run
  ON public.provider_retry_queue(flow_run_id);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_retry_queue_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $fn$;

DROP TRIGGER IF EXISTS trg_retry_queue_updated_at ON public.provider_retry_queue;
CREATE TRIGGER trg_retry_queue_updated_at
  BEFORE UPDATE ON public.provider_retry_queue
  FOR EACH ROW EXECUTE FUNCTION public.set_retry_queue_updated_at();

ALTER TABLE public.provider_retry_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_read_own_queue" ON public.provider_retry_queue;
CREATE POLICY "users_read_own_queue" ON public.provider_retry_queue
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.flow_runs fr
    WHERE fr.id = provider_retry_queue.flow_run_id AND fr.user_id = auth.uid()));

DROP POLICY IF EXISTS "admin_full_queue" ON public.provider_retry_queue;
CREATE POLICY "admin_full_queue" ON public.provider_retry_queue
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'admin'));

-- enqueue_retry_job
CREATE OR REPLACE FUNCTION public.enqueue_retry_job(
  p_flow_run_id UUID, p_step_index INTEGER, p_node_id TEXT, p_provider TEXT,
  p_node_type TEXT, p_resume_payload JSONB,
  p_initial_attempt INTEGER DEFAULT 4, p_max_attempts INTEGER DEFAULT 14,
  p_first_delay_sec INTEGER DEFAULT 30,
  p_last_error TEXT DEFAULT NULL, p_classification TEXT DEFAULT 'transient'
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_job_id UUID;
BEGIN
  INSERT INTO public.provider_retry_queue (
    flow_run_id, step_index, node_id, provider, node_type,
    resume_payload, attempt, max_attempts,
    next_attempt_at, last_error, last_classification
  ) VALUES (
    p_flow_run_id, p_step_index, p_node_id, p_provider, p_node_type,
    p_resume_payload, p_initial_attempt, p_max_attempts,
    now() + (p_first_delay_sec || ' seconds')::INTERVAL,
    p_last_error, p_classification
  )
  ON CONFLICT (flow_run_id, step_index) DO UPDATE SET
    attempt = EXCLUDED.attempt,
    next_attempt_at = EXCLUDED.next_attempt_at,
    last_error = EXCLUDED.last_error,
    status = 'pending',
    locked_by = NULL, locked_at = NULL, lock_expires_at = NULL,
    updated_at = now()
  RETURNING id INTO v_job_id;
  RETURN v_job_id;
END; $fn$;

GRANT EXECUTE ON FUNCTION public.enqueue_retry_job(UUID,INTEGER,TEXT,TEXT,TEXT,JSONB,INTEGER,INTEGER,INTEGER,TEXT,TEXT) TO service_role, authenticated;