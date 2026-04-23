
-- Create a public bucket for preset thumbnails
INSERT INTO storage.buckets (id, name, public)
VALUES ('preset-thumbnails', 'preset-thumbnails', true)
ON CONFLICT (id) DO NOTHING;

-- Anyone can view preset thumbnails (public)
CREATE POLICY "Anyone can view preset thumbnails"
ON storage.objects FOR SELECT
USING (bucket_id = 'preset-thumbnails');

-- Only admins can upload preset thumbnails
CREATE POLICY "Admins can upload preset thumbnails"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'preset-thumbnails'
  AND has_role(auth.uid(), 'admin'::app_role)
);

-- Only admins can update preset thumbnails
CREATE POLICY "Admins can update preset thumbnails"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'preset-thumbnails'
  AND has_role(auth.uid(), 'admin'::app_role)
);

-- Only admins can delete preset thumbnails
CREATE POLICY "Admins can delete preset thumbnails"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'preset-thumbnails'
  AND has_role(auth.uid(), 'admin'::app_role)
);
