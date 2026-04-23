
-- Create storage bucket for user assets
INSERT INTO storage.buckets (id, name, public) VALUES ('user_assets', 'user_assets', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for user_assets bucket
CREATE POLICY "Users can upload their own assets"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'user_assets' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can view their own assets"
ON storage.objects FOR SELECT
USING (bucket_id = 'user_assets' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can delete their own assets"
ON storage.objects FOR DELETE
USING (bucket_id = 'user_assets' AND auth.uid()::text = (storage.foldername(name))[1]);

-- Metadata table for assets
CREATE TABLE public.user_assets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_type TEXT NOT NULL DEFAULT 'image', -- 'image' or 'video'
  source TEXT NOT NULL DEFAULT 'upload', -- 'upload' or 'ai_generated'
  thumbnail_url TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.user_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own assets"
ON public.user_assets FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own assets"
ON public.user_assets FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own assets"
ON public.user_assets FOR DELETE
USING (auth.uid() = user_id);

CREATE INDEX idx_user_assets_user_source ON public.user_assets(user_id, source);
