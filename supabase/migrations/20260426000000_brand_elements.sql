-- brand_elements: persistent element refs (Kling Omni character / object)
--
-- Created when the user wires up an "Element Creator" node and clicks
-- Create. We upload the reference images to ai-media bucket, optionally
-- call Kling's element-create endpoint to register a kling_element_id,
-- and store the row here so the Asset Library can list every element
-- the workspace owns and the user can drag a reusable Element node back
-- onto any canvas without re-uploading.
--
-- `kling_element_id` is nullable — wireframe can store an element with
-- inline refs only and resolve via `reference_images` URLs at render
-- time. Once the Kling Element Create endpoint is wired, that column
-- gets the real id and the Video Gen call switches to id-based refs.

CREATE TABLE IF NOT EXISTS public.brand_elements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_canvas_id text,                     -- frontend-issued canvas id; nullable so an element survives a canvas delete
  element_name    varchar(120) NOT NULL,
  description     text,
  kling_element_id varchar(120),                -- filled when Kling Element Create succeeds
  thumbnail_url   text,                         -- typically reference_images[0]
  reference_images jsonb NOT NULL DEFAULT '[]'::jsonb,  -- array of signed URLs
  frontal_image_url text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brand_elements_user_id_idx
  ON public.brand_elements (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS brand_elements_canvas_idx
  ON public.brand_elements (workspace_canvas_id)
  WHERE workspace_canvas_id IS NOT NULL;

ALTER TABLE public.brand_elements ENABLE ROW LEVEL SECURITY;

-- Owner-only access. Workspace V2 has no team-sharing concept yet, so
-- a row is visible / mutable only by the user who created it.
DROP POLICY IF EXISTS "brand_elements_owner_select" ON public.brand_elements;
CREATE POLICY "brand_elements_owner_select"
  ON public.brand_elements FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "brand_elements_owner_insert" ON public.brand_elements;
CREATE POLICY "brand_elements_owner_insert"
  ON public.brand_elements FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "brand_elements_owner_update" ON public.brand_elements;
CREATE POLICY "brand_elements_owner_update"
  ON public.brand_elements FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "brand_elements_owner_delete" ON public.brand_elements;
CREATE POLICY "brand_elements_owner_delete"
  ON public.brand_elements FOR DELETE
  USING (auth.uid() = user_id);

-- updated_at auto-touch
CREATE OR REPLACE FUNCTION public.brand_elements_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS brand_elements_set_updated_at_tg ON public.brand_elements;
CREATE TRIGGER brand_elements_set_updated_at_tg
  BEFORE UPDATE ON public.brand_elements
  FOR EACH ROW
  EXECUTE FUNCTION public.brand_elements_set_updated_at();
