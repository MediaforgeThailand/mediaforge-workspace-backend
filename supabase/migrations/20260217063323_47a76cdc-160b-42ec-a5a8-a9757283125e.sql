-- Make user_assets bucket private to prevent unauthenticated access
UPDATE storage.buckets 
SET public = false 
WHERE id = 'user_assets';

-- Add a SELECT policy so authenticated owners can still read their files
-- (INSERT/UPDATE/DELETE policies should already exist)
-- First check if a SELECT policy already exists and drop it
DO $$
BEGIN
  -- Drop existing public SELECT policy if any
  IF EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' AND tablename = 'objects' 
    AND policyname = 'Users can view their own assets in storage'
  ) THEN
    DROP POLICY "Users can view their own assets in storage" ON storage.objects;
  END IF;
END $$;

-- Create owner-only SELECT policy for user_assets bucket
CREATE POLICY "Users can view their own assets in storage"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'user_assets' 
  AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Ensure upload policy exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' AND tablename = 'objects' 
    AND policyname = 'Users can upload to user_assets'
  ) THEN
    CREATE POLICY "Users can upload to user_assets"
    ON storage.objects FOR INSERT
    WITH CHECK (
      bucket_id = 'user_assets' 
      AND auth.uid()::text = (storage.foldername(name))[1]
    );
  END IF;
END $$;

-- Ensure delete policy exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' AND tablename = 'objects' 
    AND policyname = 'Users can delete own assets in storage'
  ) THEN
    CREATE POLICY "Users can delete own assets in storage"
    ON storage.objects FOR DELETE
    USING (
      bucket_id = 'user_assets' 
      AND auth.uid()::text = (storage.foldername(name))[1]
    );
  END IF;
END $$;