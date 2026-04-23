
CREATE TABLE public.pipeline_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES public.flows(id),
  flow_run_id uuid REFERENCES public.flow_runs(id),
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  total_steps integer NOT NULL DEFAULT 1,
  current_step integer NOT NULL DEFAULT 0,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  step_results jsonb NOT NULL DEFAULT '[]'::jsonb,
  credits_deducted integer NOT NULL DEFAULT 0,
  pricing_info jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pipeline_executions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own executions" ON public.pipeline_executions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own executions" ON public.pipeline_executions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own executions" ON public.pipeline_executions FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Admins can view all executions" ON public.pipeline_executions FOR SELECT USING (public.has_role(auth.uid(), 'admin'));
