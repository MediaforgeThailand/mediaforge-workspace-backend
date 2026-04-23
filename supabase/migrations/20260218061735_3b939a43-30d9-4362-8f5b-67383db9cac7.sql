
-- Store user onboarding persona answers
CREATE TABLE public.user_personas (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  profession TEXT,
  use_case TEXT,
  ai_experience TEXT,
  favorite_feature TEXT,
  content_frequency TEXT,
  onboarding_completed BOOLEAN NOT NULL DEFAULT false,
  credits_awarded BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.user_personas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own persona" ON public.user_personas FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own persona" ON public.user_personas FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own persona" ON public.user_personas FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Admins can view all personas" ON public.user_personas FOR SELECT USING (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER update_user_personas_updated_at
BEFORE UPDATE ON public.user_personas
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
