
-- Add flow_type and estimated_credits columns to angle_prompts
ALTER TABLE public.angle_prompts
  ADD COLUMN IF NOT EXISTS flow_type text NOT NULL DEFAULT 'simple',
  ADD COLUMN IF NOT EXISTS estimated_credits integer NOT NULL DEFAULT 0;

-- Create angle_prompt_inputs table
CREATE TABLE public.angle_prompt_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  angle_prompt_id uuid NOT NULL REFERENCES public.angle_prompts(id) ON DELETE CASCADE,
  input_key text NOT NULL,
  input_type text NOT NULL DEFAULT 'image',
  label text NOT NULL,
  description text,
  is_required boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  example_url text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Create angle_prompt_steps table
CREATE TABLE public.angle_prompt_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  angle_prompt_id uuid NOT NULL REFERENCES public.angle_prompts(id) ON DELETE CASCADE,
  step_order integer NOT NULL DEFAULT 1,
  action text NOT NULL,
  label text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.angle_prompt_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.angle_prompt_steps ENABLE ROW LEVEL SECURITY;

-- RLS: Anyone can read inputs/steps for active angle_prompts
CREATE POLICY "Anyone can read inputs of active prompts"
  ON public.angle_prompt_inputs FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.angle_prompts
    WHERE angle_prompts.id = angle_prompt_inputs.angle_prompt_id
      AND angle_prompts.is_active = true
  ));

CREATE POLICY "Anyone can read steps of active prompts"
  ON public.angle_prompt_steps FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.angle_prompts
    WHERE angle_prompts.id = angle_prompt_steps.angle_prompt_id
      AND angle_prompts.is_active = true
  ));

-- RLS: Admins can manage inputs
CREATE POLICY "Admins can manage inputs"
  ON public.angle_prompt_inputs FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role));

-- RLS: Admins can manage steps
CREATE POLICY "Admins can manage steps"
  ON public.angle_prompt_steps FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role));

-- Indexes
CREATE INDEX idx_angle_prompt_inputs_prompt_id ON public.angle_prompt_inputs(angle_prompt_id);
CREATE INDEX idx_angle_prompt_steps_prompt_id ON public.angle_prompt_steps(angle_prompt_id);
CREATE INDEX idx_angle_prompt_steps_order ON public.angle_prompt_steps(angle_prompt_id, step_order);

-- Update triggers
CREATE TRIGGER update_angle_prompt_inputs_updated_at
  BEFORE UPDATE ON public.angle_prompt_inputs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_angle_prompt_steps_updated_at
  BEFORE UPDATE ON public.angle_prompt_steps
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
