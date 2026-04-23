
-- System prompts per copilot feature type
CREATE TABLE public.copilot_system_prompts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  feature TEXT NOT NULL UNIQUE, -- 'video', 'image', 'voice', etc.
  label TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'google/gemini-2.5-flash',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Angle prompts (RAG knowledge base)
CREATE TABLE public.angle_prompts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  feature TEXT NOT NULL, -- 'video', 'image', 'voice'
  category TEXT NOT NULL, -- 'product', 'lifestyle', 'storytelling', etc.
  title TEXT NOT NULL,
  description TEXT,
  prompt_template TEXT NOT NULL,
  platform TEXT, -- 'tiktok', 'instagram', 'youtube', null = all
  aspect_ratio TEXT, -- recommended aspect ratio
  duration_seconds INTEGER, -- recommended duration
  has_audio BOOLEAN DEFAULT false,
  example_media_url TEXT, -- video/image example URL
  example_thumbnail_url TEXT,
  tags TEXT[] DEFAULT '{}',
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.copilot_system_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.angle_prompts ENABLE ROW LEVEL SECURITY;

-- Admin-only write, public read for copilot prompts
CREATE POLICY "Anyone can read active copilot prompts"
  ON public.copilot_system_prompts FOR SELECT
  USING (is_active = true);

CREATE POLICY "Admins can manage copilot prompts"
  ON public.copilot_system_prompts FOR ALL
  USING (public.has_role(auth.uid(), 'admin'));

-- Public read for angle prompts, admin write
CREATE POLICY "Anyone can read active angle prompts"
  ON public.angle_prompts FOR SELECT
  USING (is_active = true);

CREATE POLICY "Admins can manage angle prompts"
  ON public.angle_prompts FOR ALL
  USING (public.has_role(auth.uid(), 'admin'));

-- Timestamps triggers
CREATE TRIGGER update_copilot_system_prompts_updated_at
  BEFORE UPDATE ON public.copilot_system_prompts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_angle_prompts_updated_at
  BEFORE UPDATE ON public.angle_prompts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed default video copilot system prompt
INSERT INTO public.copilot_system_prompts (feature, label, system_prompt, model) VALUES
('video', 'Video Copilot', E'You are a professional Video Production Copilot. Help users configure video generation settings and suggest creative angles.\n\nCapabilities:\n1. Change video settings (model, duration, aspect ratio, audio, prompt) via apply_settings tool\n2. Search angle prompts from our library via search_angles tool\n3. Ask clarifying questions about platform, style, and purpose\n\nRules:\n- When user describes what they want, search for matching angle prompts first\n- If angle prompts found, present 3-4 options with examples\n- Ask which platform (TikTok, Instagram, YouTube, Facebook) if not specified\n- Set aspect ratio based on platform: TikTok/Reels=9:16, YouTube=16:9, Instagram Feed=1:1\n- Only enable audio if the angle prompt specifies it or user requests it\n- Reply in the same language as the user (Thai or English)\n- Be concise and actionable', 'google/gemini-2.5-flash'),
('image', 'Image Copilot', E'You are a professional Image Production Copilot. Help users configure image generation settings and suggest creative styles.\n\nRules:\n- Help choose the right model, style, and dimensions\n- Suggest creative approaches based on user needs\n- Reply in the same language as the user', 'google/gemini-2.5-flash'),
('voice', 'Voice Copilot', E'You are a professional Voice/TTS Copilot. Help users configure text-to-speech settings.\n\nRules:\n- Help choose voice, speed, and language\n- Suggest appropriate tone for the content\n- Reply in the same language as the user', 'google/gemini-2.5-flash');

-- Seed some example angle prompts for video
INSERT INTO public.angle_prompts (feature, category, title, description, prompt_template, platform, aspect_ratio, duration_seconds, has_audio, tags, sort_order) VALUES
('video', 'product', 'Product Showcase - Cinematic', 'สินค้าหมุนบนพื้นหลังสีเข้ม แสง rim light สวยงาม', 'A luxury product rotating slowly on a dark reflective surface, dramatic rim lighting, cinematic depth of field, premium commercial look', NULL, '9:16', 5, false, ARRAY['product','commercial','luxury'], 1),
('video', 'product', 'Unboxing Experience', 'มือเปิดกล่องสินค้าอย่างช้าๆ เผยให้เห็นสินค้าข้างใน', 'Hands slowly unboxing a premium product, revealing the item inside, soft natural lighting, ASMR-style close-up, satisfying reveal moment', NULL, '9:16', 8, false, ARRAY['product','unboxing','asmr'], 2),
('video', 'lifestyle', 'Day in Life - Aesthetic', 'วิดีโอ aesthetic แนว day in life สำหรับ social media', 'Aesthetic day-in-life montage, warm golden hour lighting, cozy vibes, smooth transitions between daily activities, soft color grading', 'tiktok', '9:16', 10, true, ARRAY['lifestyle','aesthetic','dayinlife'], 3),
('video', 'storytelling', 'Brand Story - Emotional', 'เล่าเรื่องแบรนด์ด้วยอารมณ์ที่กินใจ', 'Emotional brand storytelling video, cinematic color grading, meaningful moments captured in slow motion, inspirational mood', 'youtube', '16:9', 15, true, ARRAY['brand','storytelling','emotional'], 4),
('video', 'product', 'Food Porn - Close Up', 'อาหารถ่ายใกล้แบบ food porn น่ากิน', 'Extreme close-up food photography style video, steam rising, cheese pull, sauce dripping, vibrant colors, appetite-inducing lighting', 'instagram', '1:1', 5, false, ARRAY['food','closeup','appetizing'], 5),
('video', 'social', 'TikTok Trending Hook', 'วิดีโอ hook แรกสะดุดตาสำหรับ TikTok', 'Eye-catching opening hook for social media, fast-paced, bold text overlay style, trending aesthetic, scroll-stopping first frame', 'tiktok', '9:16', 5, false, ARRAY['tiktok','hook','trending'], 6);
