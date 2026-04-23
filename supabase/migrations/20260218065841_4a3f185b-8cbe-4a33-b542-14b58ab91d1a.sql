
-- Create storage bucket for angle prompt example media (videos/images)
INSERT INTO storage.buckets (id, name, public) VALUES ('angle-prompt-media', 'angle-prompt-media', true)
ON CONFLICT (id) DO NOTHING;

-- Public read access
CREATE POLICY "Anyone can view angle prompt media"
ON storage.objects FOR SELECT
USING (bucket_id = 'angle-prompt-media');

-- Admin-only write
CREATE POLICY "Admins can upload angle prompt media"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'angle-prompt-media' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update angle prompt media"
ON storage.objects FOR UPDATE
USING (bucket_id = 'angle-prompt-media' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete angle prompt media"
ON storage.objects FOR DELETE
USING (bucket_id = 'angle-prompt-media' AND public.has_role(auth.uid(), 'admin'));
