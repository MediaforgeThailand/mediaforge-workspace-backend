
-- =============================================
-- 1. Brand Contexts — for Pro+ users to store their business profile
-- =============================================
CREATE TABLE public.brand_contexts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  -- Basic info
  business_name TEXT,
  industry TEXT,
  target_audience TEXT,
  -- Brand identity
  brand_tone TEXT, -- e.g. "professional", "playful", "luxury", "casual"
  brand_colors TEXT, -- e.g. "#FF5733, #333333"
  logo_url TEXT,
  tagline TEXT,
  -- Business details
  products_services TEXT, -- describe main products/services
  unique_selling_points TEXT,
  competitors TEXT,
  -- Content strategy
  primary_platforms TEXT[], -- e.g. {"TikTok", "Instagram", "YouTube"}
  content_goals TEXT, -- e.g. "increase brand awareness", "drive sales"
  preferred_content_types TEXT[], -- e.g. {"short_video", "product_photo", "story"}
  -- Target demographics
  target_age_range TEXT, -- e.g. "18-35"
  target_gender TEXT, -- e.g. "all", "female", "male"
  target_location TEXT, -- e.g. "Thailand", "Bangkok"
  target_language TEXT DEFAULT 'th',
  -- Additional
  additional_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

ALTER TABLE public.brand_contexts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own brand context"
  ON public.brand_contexts FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own brand context"
  ON public.brand_contexts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own brand context"
  ON public.brand_contexts FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own brand context"
  ON public.brand_contexts FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER update_brand_contexts_updated_at
  BEFORE UPDATE ON public.brand_contexts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- 2. Prompt Knowledge — RAG for prompt writing techniques
-- =============================================
CREATE TABLE public.prompt_knowledge (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  feature TEXT NOT NULL, -- 'video', 'image', 'voice'
  category TEXT NOT NULL, -- e.g. 'technique', 'model_tip', 'platform_best_practice', 'style_guide'
  title TEXT NOT NULL,
  content TEXT NOT NULL, -- the actual knowledge/tip
  applicable_models TEXT[], -- which models this applies to, NULL = all
  applicable_platforms TEXT[], -- which platforms, NULL = all
  tags TEXT[] DEFAULT '{}',
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.prompt_knowledge ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage prompt knowledge"
  ON public.prompt_knowledge FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Anyone can read active prompt knowledge"
  ON public.prompt_knowledge FOR SELECT
  USING (is_active = true);

CREATE TRIGGER update_prompt_knowledge_updated_at
  BEFORE UPDATE ON public.prompt_knowledge
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
