
-- Create homepage_featured if it doesn't exist (may have been created outside migrations)
CREATE TABLE IF NOT EXISTS public.homepage_featured (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot text NOT NULL DEFAULT 'trending',
  flow_id uuid NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- New homepage_sections table
CREATE TABLE public.homepage_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  subtitle text,
  icon text NOT NULL DEFAULT 'sparkles',
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  section_type text NOT NULL DEFAULT 'grid',
  max_items integer NOT NULL DEFAULT 6,
  auto_fill_strategy text NOT NULL DEFAULT 'none',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.homepage_sections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read active sections" ON public.homepage_sections
  FOR SELECT TO public USING (is_active = true);

CREATE POLICY "Admins can manage sections" ON public.homepage_sections
  FOR ALL TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));

-- Add section_id FK to homepage_featured
ALTER TABLE public.homepage_featured
  ADD COLUMN section_id uuid REFERENCES public.homepage_sections(id) ON DELETE CASCADE;

-- Seed default sections
INSERT INTO public.homepage_sections (title, subtitle, icon, sort_order, section_type, max_items, auto_fill_strategy) VALUES
  ('Hero Banner', 'Featured flow highlight', 'star', 0, 'hero', 1, 'none'),
  ('Trending Flows', 'Flows ที่กำลังมาแรงตอนนี้', 'flame', 1, 'grid', 6, 'trending'),
  ('ยอดนิยม', 'Flows ที่ได้รับความนิยมสูงสุด', 'trending-up', 2, 'grid', 3, 'popular'),
  ('Official Automations', 'Premium flows จากทีม MediaForge', 'sparkles', 3, 'grid', 8, 'official');
