
-- Drop old unique constraint that only covers feature+model
DROP INDEX IF EXISTS idx_credit_costs_feature_model;

-- Create new unique constraint that includes duration and audio
CREATE UNIQUE INDEX idx_credit_costs_feature_model_dur_audio 
ON public.credit_costs (feature, COALESCE(model, '__default__'), COALESCE(duration_seconds, 0), COALESCE(has_audio, false));
