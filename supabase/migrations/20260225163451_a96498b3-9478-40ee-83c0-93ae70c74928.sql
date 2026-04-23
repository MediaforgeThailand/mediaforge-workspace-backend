
-- Add visit_count and survey_data columns to user_personas
ALTER TABLE public.user_personas
  ADD COLUMN IF NOT EXISTS visit_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS survey_data jsonb;
