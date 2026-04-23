
CREATE TABLE public.system_prompt_versions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  changed_by UUID NOT NULL,
  change_note TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.system_prompt_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view prompt versions"
ON public.system_prompt_versions
FOR SELECT
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can insert prompt versions"
ON public.system_prompt_versions
FOR INSERT
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Seed current prompt as version 1
INSERT INTO public.system_prompt_versions (version, content, changed_by, change_note)
SELECT 1, value, 'fb4de7e2-9f6e-459b-bb1b-464f6ae14bea', 'Initial version'
FROM public.subscription_settings WHERE key = 'system_prompt';
