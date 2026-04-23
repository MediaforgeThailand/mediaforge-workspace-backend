-- Create a public bucket for landing page videos
INSERT INTO storage.buckets (id, name, public)
VALUES ('landing-videos', 'landing-videos', true)
ON CONFLICT (id) DO NOTHING;

-- Allow anyone to read from the bucket (public access)
CREATE POLICY "Public read access for landing videos"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'landing-videos');

-- Allow authenticated admins to upload
CREATE POLICY "Admin upload to landing videos"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'landing-videos'
  AND public.has_role(auth.uid(), 'admin')
);

-- Allow authenticated admins to delete
CREATE POLICY "Admin delete from landing videos"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'landing-videos'
  AND public.has_role(auth.uid(), 'admin')
);