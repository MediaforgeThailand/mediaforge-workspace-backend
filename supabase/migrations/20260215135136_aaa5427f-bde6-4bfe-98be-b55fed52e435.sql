-- Add credit costs for new AI tools
INSERT INTO public.credit_costs (feature, label, cost) VALUES
  ('reimagine', 'Reimagine Image (AI Style Transfer)', 5),
  ('image_expand', 'Image Expand (Outpainting)', 5),
  ('image_to_prompt', 'Image to Prompt (Reverse Engineering)', 1),
  ('improve_prompt', 'Improve Prompt (AI Enhancement)', 1),
  ('sound_effects', 'Sound Effects Generation', 5),
  ('audio_isolation', 'Audio Isolation (Sound Separation)', 5),
  ('skin_enhancer', 'AI Skin Enhancer', 3)
ON CONFLICT DO NOTHING;