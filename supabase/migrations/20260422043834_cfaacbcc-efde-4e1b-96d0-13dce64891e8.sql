INSERT INTO public.credit_costs (feature, model, label, cost, pricing_type)
SELECT 'merge_audio_video', 'shotstack', 'Merge Audio + Video (Shotstack)', 50, 'per_operation'
WHERE NOT EXISTS (
  SELECT 1 FROM public.credit_costs
  WHERE feature = 'merge_audio_video' AND model = 'shotstack'
);