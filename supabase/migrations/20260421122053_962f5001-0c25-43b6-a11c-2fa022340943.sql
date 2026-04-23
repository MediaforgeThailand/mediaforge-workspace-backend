-- Idempotent insert/update for Merge Audio + Video pricing
INSERT INTO public.credit_costs (feature, model, label, cost, pricing_type, duration_seconds, has_audio)
VALUES ('merge_audio_video', 'shotstack', 'Merge Audio + Video (Shotstack)', 20, 'per_operation', NULL, NULL)
ON CONFLICT (feature, COALESCE(model, '__default__'::text), COALESCE(duration_seconds, 0), COALESCE(has_audio, false))
DO UPDATE SET
  cost = EXCLUDED.cost,
  label = EXCLUDED.label,
  pricing_type = EXCLUDED.pricing_type;