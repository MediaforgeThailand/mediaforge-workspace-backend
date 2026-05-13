-- Allow larger source and result videos for video voice translation.
UPDATE storage.buckets
SET file_size_limit = 1073741824
WHERE id IN ('ai-media', 'user_assets');
