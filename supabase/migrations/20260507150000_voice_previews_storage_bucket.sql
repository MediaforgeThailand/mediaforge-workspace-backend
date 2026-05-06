-- Voice preview cache bucket.
--
-- The `voice-preview` edge function caches synthesised TTS samples
-- here so the second click on a voice is an instant CDN hit instead
-- of another paid Google / ElevenLabs synthesis. Without the bucket
-- existing, the function falls into the data:URL fallback path,
-- which previously also crashed with "Maximum call stack size
-- exceeded" — both are now fixed but having the bucket is what we
-- actually want at runtime so audio doesn't bloat every JSON
-- response with a base64 blob.
--
-- Public-read so the picker grid can <audio src=...> the preview
-- without minting a signed URL per click. Authenticated INSERT so
-- the function can run with the user's JWT (audit trail in
-- storage.objects keyed to auth.uid()).

-- Create the bucket if it isn't there yet. `id` and `name` match —
-- supabase-js .from("voice-previews") looks the bucket up by id.
INSERT INTO storage.buckets (id, name, public)
VALUES ('voice-previews', 'voice-previews', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

-- Public-read policy. The bucket is `public = true` already, but an
-- explicit read policy makes the intent clear and survives any
-- future global RLS tightening of the storage.objects table.
DROP POLICY IF EXISTS "voice_previews_public_read" ON storage.objects;
CREATE POLICY "voice_previews_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'voice-previews');

-- Authenticated INSERT — the function uses the user-scoped supabase
-- client to upload, so the row gets owner = auth.uid() automatically.
DROP POLICY IF EXISTS "voice_previews_authenticated_insert" ON storage.objects;
CREATE POLICY "voice_previews_authenticated_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'voice-previews');

-- Authenticated UPDATE — `upload(..., { upsert: true })` issues an
-- UPDATE when the path already exists. Without this the upsert path
-- silently 403s for an existing key.
DROP POLICY IF EXISTS "voice_previews_authenticated_update" ON storage.objects;
CREATE POLICY "voice_previews_authenticated_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'voice-previews')
  WITH CHECK (bucket_id = 'voice-previews');
