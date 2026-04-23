INSERT INTO public.credit_costs (feature, model, cost, label, pricing_type)
VALUES ('merge_audio_video', 'shotstack', 2, 'Merge Audio + Video (Shotstack)', 'fixed')
ON CONFLICT DO NOTHING;