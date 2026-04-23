-- Add per_second pricing rows for Omni models (flexible 3-15s duration)
INSERT INTO credit_costs (feature, model, label, cost, pricing_type, duration_seconds, has_audio) VALUES
('generate_freepik_video', 'kling-v3-omni', 'Kling 3.0 Omni Pro /s', 6, 'per_second', NULL, false),
('generate_freepik_video', 'kling-v3-omni-video-ref', 'Kling 3.0 Omni Pro +Video /s', 10, 'per_second', NULL, false),
('generate_freepik_video', 'kling-video-o1', 'Kling Video O1 /s', 6, 'per_second', NULL, false),
('generate_freepik_video', 'kling-video-o1-video-ref', 'Kling Video O1 +Video /s', 10, 'per_second', NULL, false)
ON CONFLICT (feature, COALESCE(model, '__default__'), COALESCE(duration_seconds, 0), COALESCE(has_audio, false)) 
DO UPDATE SET label = EXCLUDED.label, cost = EXCLUDED.cost, pricing_type = EXCLUDED.pricing_type;