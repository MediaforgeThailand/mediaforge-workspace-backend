-- Allow larger source media for Translate uploads.
UPDATE storage.buckets
SET file_size_limit = 1073741824
WHERE id IN ('ai-media', 'user_assets');
