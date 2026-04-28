-- Workspace V2 brand_elements table — port from workspace track.
CREATE TABLE IF NOT EXISTS public.brand_elements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_canvas_id text,
  element_name    varchar(120) NOT NULL,
  description     text,
  kling_element_id varchar(120),
  thumbnail_url   text,
  reference_images jsonb NOT NULL DEFAULT '[]'::jsonb,
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
