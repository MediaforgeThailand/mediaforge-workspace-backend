
-- Preset sections table for dynamic category management
CREATE TABLE public.preset_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  label text NOT NULL,
  icon text NOT NULL DEFAULT 'sparkles',
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.preset_sections ENABLE ROW LEVEL SECURITY;

-- Anyone can read active sections
CREATE POLICY "Anyone can view active sections"
  ON public.preset_sections FOR SELECT
  USING (is_active = true);

-- Admins can do everything
CREATE POLICY "Admins can manage sections"
  ON public.preset_sections FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role));

-- Timestamp trigger
CREATE TRIGGER update_preset_sections_updated_at
  BEFORE UPDATE ON public.preset_sections
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Seed default sections
INSERT INTO public.preset_sections (key, label, icon, sort_order) VALUES
  ('hot', '🔥 Hot & Trending', 'flame', 1),
  ('video', '🎬 Video Effects', 'film', 2),
  ('image', '🖼️ Image Styles', 'image', 3),
  ('template', '✨ Templates', 'sparkles', 4);

-- Add foreign key from presets.section to preset_sections.key
ALTER TABLE public.presets
  ADD CONSTRAINT presets_section_fkey
  FOREIGN KEY (section) REFERENCES public.preset_sections(key) ON UPDATE CASCADE;
