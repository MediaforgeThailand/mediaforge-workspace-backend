-- Create storage bucket for AI-generated media (persistent URLs)
INSERT INTO storage.buckets (id, name, public) VALUES ('ai-media', 'ai-media', true)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload
CREATE POLICY "Users can upload ai media"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'ai-media' AND auth.uid()::text = (storage.foldername(name))[1]);

-- Public read access
CREATE POLICY "AI media is publicly accessible"
ON storage.objects FOR SELECT
USING (bucket_id = 'ai-media');

-- Users can delete their own media
CREATE POLICY "Users can delete own ai media"
ON storage.objects FOR DELETE
USING (bucket_id = 'ai-media' AND auth.uid()::text = (storage.foldername(name))[1]);