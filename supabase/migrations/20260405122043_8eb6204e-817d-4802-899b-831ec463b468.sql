
-- 1. Create flow_categories table
CREATE TABLE IF NOT EXISTS public.flow_categories (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  category_group TEXT NOT NULL CHECK (category_group IN ('industry', 'use_case')),
  icon TEXT DEFAULT 'tag',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 2. Create junction table
CREATE TABLE IF NOT EXISTS public.flow_category_mappings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  flow_id UUID NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES public.flow_categories(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(flow_id, category_id)
);

-- 3. Enable RLS
ALTER TABLE public.flow_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_category_mappings ENABLE ROW LEVEL SECURITY;

-- 4. RLS for flow_categories
CREATE POLICY "Anyone can view active categories"
  ON public.flow_categories FOR SELECT
  USING (is_active = true);

CREATE POLICY "Admins can manage categories"
  ON public.flow_categories FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role));

-- 5. RLS for flow_category_mappings
CREATE POLICY "Anyone can view mappings of published flows"
  ON public.flow_category_mappings FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.flows
    WHERE flows.id = flow_category_mappings.flow_id
    AND flows.status = 'published'
  ));

CREATE POLICY "Flow owners can view own mappings"
  ON public.flow_category_mappings FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.flows
    WHERE flows.id = flow_category_mappings.flow_id
    AND flows.user_id = auth.uid()
  ));

CREATE POLICY "Flow owners can manage own mappings"
  ON public.flow_category_mappings FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.flows
    WHERE flows.id = flow_category_mappings.flow_id
    AND flows.user_id = auth.uid()
  ));

CREATE POLICY "Flow owners can delete own mappings"
  ON public.flow_category_mappings FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.flows
    WHERE flows.id = flow_category_mappings.flow_id
    AND flows.user_id = auth.uid()
  ));

CREATE POLICY "Admins can manage all mappings"
  ON public.flow_category_mappings FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role));

-- 6. Indexes
CREATE INDEX idx_flow_categories_group ON public.flow_categories(category_group);
CREATE INDEX idx_flow_category_mappings_flow ON public.flow_category_mappings(flow_id);
CREATE INDEX idx_flow_category_mappings_category ON public.flow_category_mappings(category_id);

-- 7. Updated_at trigger
CREATE TRIGGER update_flow_categories_updated_at
  BEFORE UPDATE ON public.flow_categories
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- 8. Seed Industry categories
INSERT INTO public.flow_categories (name, slug, description, category_group, sort_order, icon) VALUES
  ('Food & Beverage', 'food-beverage', 'Restaurants, cafes, snacks, and drinks.', 'industry', 1, 'utensils'),
  ('Fashion & Apparel', 'fashion-apparel', 'Clothing, shoes, bags, and accessories.', 'industry', 2, 'shirt'),
  ('Beauty & Skincare', 'beauty-skincare', 'Cosmetics, perfumes, and aesthetic clinics.', 'industry', 3, 'sparkles'),
  ('Automotive', 'automotive', 'Cars, motorcycles, and car care products.', 'industry', 4, 'car'),
  ('Tech & Gadgets', 'tech-gadgets', 'Smartphones, headphones, and smart home devices.', 'industry', 5, 'smartphone'),
  ('Home & Lifestyle', 'home-lifestyle', 'Furniture, home decor, and appliances.', 'industry', 6, 'home'),
  ('Health & Wellness', 'health-wellness', 'Supplements, vitamins, and fitness gear.', 'industry', 7, 'heart-pulse'),
  ('Pets', 'pets', 'Pet food and accessories.', 'industry', 8, 'paw-print'),
  ('Mom & Baby', 'mom-baby', 'Baby products and educational toys.', 'industry', 9, 'baby'),
  ('Travel & Real Estate', 'travel-real-estate', 'Hotels, resorts, condos, and housing.', 'industry', 10, 'map-pin');

-- 9. Seed Use Case categories
INSERT INTO public.flow_categories (name, slug, description, category_group, sort_order, icon) VALUES
  ('Packshot', 'packshot', 'Clean, studio-style product images.', 'use_case', 1, 'camera'),
  ('Magic Background', 'magic-background', 'Placing products in generated aesthetic environments.', 'use_case', 2, 'wand'),
  ('Before & After', 'before-after', 'Side-by-side comparison images.', 'use_case', 3, 'columns'),
  ('AI Model Try-on', 'ai-model-tryon', 'Virtual clothing or face swap on AI models.', 'use_case', 4, 'user'),
  ('Lifestyle in Context', 'lifestyle-in-context', 'Products being used in real-life scenarios.', 'use_case', 5, 'image'),
  ('Social Media Ads', 'social-media-ads', 'Images with negative space for text overlays.', 'use_case', 6, 'megaphone'),
  ('Preview / Teaser', 'preview-teaser', 'Concept art or lookbooks for pre-launch.', 'use_case', 7, 'eye'),
  ('3D Mockup', '3d-mockup', 'Rendering designs on packaging or screens.', 'use_case', 8, 'box'),
  ('Illustration / Graphic', 'illustration-graphic', 'Cartoons, vectors, and watercolor styles.', 'use_case', 9, 'palette');
