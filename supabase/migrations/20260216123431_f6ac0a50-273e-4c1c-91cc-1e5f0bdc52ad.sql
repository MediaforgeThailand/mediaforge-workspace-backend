
-- Add content_hash column for deduplication
ALTER TABLE public.user_assets ADD COLUMN IF NOT EXISTS content_hash text;

-- Create index for fast hash lookups per user
CREATE INDEX IF NOT EXISTS idx_user_assets_hash ON public.user_assets (user_id, content_hash) WHERE content_hash IS NOT NULL;
