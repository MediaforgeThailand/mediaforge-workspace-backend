
-- Allow users to update their own assets (for rename/categorize)
CREATE POLICY "Users can update their own assets"
ON public.user_assets
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Add category column for organizing assets
ALTER TABLE public.user_assets ADD COLUMN IF NOT EXISTS category text DEFAULT 'uncategorized';

-- Add is_favorite column
ALTER TABLE public.user_assets ADD COLUMN IF NOT EXISTS is_favorite boolean DEFAULT false;
