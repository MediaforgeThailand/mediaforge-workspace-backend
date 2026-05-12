-- ai-media, user_assets, videos buckets had INSERT + SELECT + DELETE policies
-- but no UPDATE. Frontend uploads use `upsert: true`, which flips to UPDATE
-- when the path already exists. RLS then rejects with "new row violates
-- row-level security policy" — the message names INSERT but actually
-- covers UPDATE rejections too because Supabase Storage models upsert as
-- a single statement.
--
-- Triggered in prod by the video-frame-extraction path (workspace-frontend
-- PR #27) re-running on re-render and hitting the same `<userId>/video-
-- frames/<nodeId>/<genId>/start.jpg` (and end.jpg) twice. The first call
-- inserts; the second re-runs as UPDATE and 400s. After the fix the
-- second call updates cleanly.
--
-- Expression mirrors each bucket's existing INSERT policy: a user may
-- update only files under their own `auth.uid()/...` folder.
--
-- Idempotent: DROP IF EXISTS first so re-applying the migration after a
-- direct hotfix INSERT (which was used to restore prod) doesn't error.

DROP POLICY IF EXISTS "Users can update own ai media" ON storage.objects;
CREATE POLICY "Users can update own ai media"
ON storage.objects FOR UPDATE
TO public
USING (bucket_id = 'ai-media' AND (auth.uid())::text = (storage.foldername(name))[1])
WITH CHECK (bucket_id = 'ai-media' AND (auth.uid())::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Users can update their own assets" ON storage.objects;
CREATE POLICY "Users can update their own assets"
ON storage.objects FOR UPDATE
TO public
USING (bucket_id = 'user_assets' AND (auth.uid())::text = (storage.foldername(name))[1])
WITH CHECK (bucket_id = 'user_assets' AND (auth.uid())::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Users can update their own videos" ON storage.objects;
CREATE POLICY "Users can update their own videos"
ON storage.objects FOR UPDATE
TO public
USING (bucket_id = 'videos' AND (auth.uid())::text = (storage.foldername(name))[1])
WITH CHECK (bucket_id = 'videos' AND (auth.uid())::text = (storage.foldername(name))[1]);
