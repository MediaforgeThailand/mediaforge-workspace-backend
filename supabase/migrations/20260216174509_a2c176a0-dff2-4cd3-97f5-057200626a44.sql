
-- Drop the existing unique constraint on feature
ALTER TABLE public.credit_costs DROP CONSTRAINT IF EXISTS credit_costs_feature_key;

-- Add model column
ALTER TABLE public.credit_costs ADD COLUMN IF NOT EXISTS model text DEFAULT NULL;

-- Create new unique index on feature+model
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_costs_feature_model ON public.credit_costs (feature, COALESCE(model, '__default__'));

-- Rename old generic rows to be "default fallback" (model=NULL)
-- Keep them as-is, they serve as fallback prices

-- Insert per-model VIDEO pricing
INSERT INTO public.credit_costs (feature, label, cost, model) VALUES
  ('generate_freepik_video', 'WAN 2.6 (720p)', 500, 'wan-2-6'),
  ('generate_freepik_video', 'WAN 2.5 (720p T2V)', 400, 'wan-2-5'),
  ('generate_freepik_video', 'WAN 2.5 I2V (1080p)', 600, 'wan-2-5-i2v'),
  ('generate_freepik_video', 'WAN 2.6 (1080p)', 800, 'wan-2-6-1080p'),
  ('generate_freepik_video', 'MiniMax Hailuo 02', 800, 'minimax-hailuo'),
  ('generate_freepik_video', 'MiniMax Hailuo 2.3', 1000, 'minimax-hailuo-2-3'),
  ('generate_freepik_video', 'MiniMax Video 01 Live', 600, 'minimax-video-01-live'),
  ('generate_freepik_video', 'Seedance 1.5 Pro', 1200, 'seedance-1-5-pro'),
  ('generate_freepik_video', 'Seedance Pro', 1000, 'seedance-pro'),
  ('generate_freepik_video', 'Seedance Lite', 600, 'seedance-lite'),
  ('generate_freepik_video', 'Kling 2.6 Pro', 1500, 'kling-2-6-pro'),
  ('generate_freepik_video', 'Kling 2.5 Pro', 1200, 'kling-2-5-pro'),
  ('generate_freepik_video', 'Kling 2.1 Pro', 1000, 'kling-2-1-pro'),
  ('generate_freepik_video', 'Kling O1 Pro', 1500, 'kling-o1-pro'),
  ('generate_freepik_video', 'Kling Standard', 600, 'kling-std'),
  ('generate_freepik_video', 'RunWay Gen4 Turbo', 1200, 'runway-gen4-turbo'),
  ('generate_freepik_video', 'RunWay I2V', 1500, 'runway'),
  ('generate_freepik_video', 'LTX 2.0 Pro', 300, 'ltx-2-pro'),
  ('generate_freepik_video', 'LTX I2V', 300, 'ltx'),
  ('generate_freepik_video', 'PixVerse V5', 800, 'pixverse-v5');

-- Insert per-model IMAGE pricing
INSERT INTO public.credit_costs (feature, label, cost, model) VALUES
  ('generate_freepik_image', 'Mystic', 150, 'mystic'),
  ('generate_freepik_image', 'Flux Kontext Pro', 100, 'flux-kontext-pro'),
  ('generate_freepik_image', 'Flux 2 Pro', 80, 'flux-2-pro'),
  ('generate_freepik_image', 'Flux 2 Turbo', 30, 'flux-2-turbo'),
  ('generate_freepik_image', 'Flux 2 Klein', 15, 'flux-2-klein'),
  ('generate_freepik_image', 'Flux Pro 1.1', 100, 'flux-pro-v1-1'),
  ('generate_freepik_image', 'Flux Dev', 30, 'flux-dev'),
  ('generate_freepik_image', 'HyperFlux', 350, 'hyperflux'),
  ('generate_freepik_image', 'Seedream 4.5', 100, 'seedream-v4-5'),
  ('generate_freepik_image', 'Seedream 4', 80, 'seedream-v4'),
  ('generate_freepik_image', 'Seedream 3', 80, 'seedream'),
  ('generate_freepik_image', 'Z-Image Turbo', 50, 'z-image-turbo'),
  ('generate_freepik_image', 'Runway T2I', 220, 'runway-t2i');

-- Update old generic video/image rows to indicate they're fallback defaults
UPDATE public.credit_costs SET label = 'Text to Video (Default)' WHERE feature = 'text_to_video' AND model IS NULL;
UPDATE public.credit_costs SET label = 'Image to Video (Default)' WHERE feature = 'image_to_video' AND model IS NULL;
UPDATE public.credit_costs SET label = 'Generate Image (Default)' WHERE feature = 'generate_image' AND model IS NULL;
