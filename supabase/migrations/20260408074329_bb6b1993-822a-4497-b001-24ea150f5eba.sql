-- Create public bucket for flow reference/example images
INSERT INTO storage.buckets (id, name, public)
VALUES ('flow-assets', 'flow-assets', true)
ON CONFLICT (id) DO NOTHING;

-- Public read access
CREATE POLICY "flow-assets public read"
ON storage.objects FOR SELECT
USING (bucket_id = 'flow-assets');

-- Authenticated users can upload to their own folder
CREATE POLICY "flow-assets auth upload"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'flow-assets'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Users can delete their own files
CREATE POLICY "flow-assets auth delete"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'flow-assets'
  AND auth.uid()::text = (storage.foldername(name))[1]
);