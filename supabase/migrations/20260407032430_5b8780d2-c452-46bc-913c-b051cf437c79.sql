
-- Fix Chat AI slugs
UPDATE credit_costs SET model = 'google/gemini-3.1-pro-preview' WHERE model = 'gemini-3.1-pro-preview';
UPDATE credit_costs SET model = 'openai/gpt-5' WHERE model = 'gpt-5';
UPDATE credit_costs SET model = 'openai/gpt-5-mini' WHERE model = 'gpt-5-mini';

-- Insert missing Kling models (skip if already exist)
INSERT INTO credit_costs (feature, model, label, cost, pricing_type, duration_seconds, has_audio) VALUES
('generate_freepik_video', 'kling-v3-omni', 'Kling 3.0 Omni Pro 5s', 31, 'fixed', 5, false),
('generate_freepik_video', 'kling-v3-omni', 'Kling 3.0 Omni Pro 5s +Audio', 62, 'fixed', 5, true),
('generate_freepik_video', 'kling-v3-omni', 'Kling 3.0 Omni Pro 10s', 62, 'fixed', 10, false),
('generate_freepik_video', 'kling-v3-omni', 'Kling 3.0 Omni Pro 10s +Audio', 123, 'fixed', 10, true),
('generate_freepik_video', 'kling-video-o1', 'Kling Video O1 5s', 31, 'fixed', 5, false),
('generate_freepik_video', 'kling-video-o1', 'Kling Video O1 5s +Audio', 62, 'fixed', 5, true),
('generate_freepik_video', 'kling-video-o1', 'Kling Video O1 10s', 62, 'fixed', 10, false),
('generate_freepik_video', 'kling-video-o1', 'Kling Video O1 10s +Audio', 123, 'fixed', 10, true),
('generate_freepik_video', 'kling-v3-motion-pro', 'Kling 3.0 Motion Pro /s', 6, 'per_second', NULL, false)
ON CONFLICT (feature, COALESCE(model, '__default__'), COALESCE(duration_seconds, 0), COALESCE(has_audio, false)) 
DO UPDATE SET label = EXCLUDED.label;

-- Update any existing Omni labels to include "Pro"
UPDATE credit_costs SET label = REPLACE(label, 'Kling 3.0 Omni ', 'Kling 3.0 Omni Pro ') 
WHERE model = 'kling-v3-omni' AND label NOT LIKE '%Omni Pro%';
