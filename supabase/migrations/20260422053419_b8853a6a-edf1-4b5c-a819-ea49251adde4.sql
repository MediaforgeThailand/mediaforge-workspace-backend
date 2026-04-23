INSERT INTO public.credit_costs (feature, model, label, cost, pricing_type, has_audio)
SELECT 'merge_audio_video', 'shotstack', 'Merge Audio + Video (Shotstack)', 20, 'per_operation', false
WHERE NOT EXISTS (
  SELECT 1 FROM public.credit_costs WHERE feature = 'merge_audio_video' AND model = 'shotstack'
);