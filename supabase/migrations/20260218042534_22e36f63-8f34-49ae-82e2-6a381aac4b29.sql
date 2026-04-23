
-- Presets table for database-driven preset management
CREATE TABLE public.presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  prompt text NOT NULL,
  category text NOT NULL DEFAULT 'image',
  tag text, -- Hot, New, Trending, etc.
  section text NOT NULL DEFAULT 'hot', -- hot, video, image, template
  thumbnail_url text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.presets ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read active presets
CREATE POLICY "Anyone can view active presets"
  ON public.presets FOR SELECT
  USING (is_active = true);

-- Admins can do everything
CREATE POLICY "Admins can manage presets"
  ON public.presets FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role));

-- Timestamp trigger
CREATE TRIGGER update_presets_updated_at
  BEFORE UPDATE ON public.presets
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
