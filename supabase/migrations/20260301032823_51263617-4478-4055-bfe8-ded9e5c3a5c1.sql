-- Add credit cost for Chat AI (text generation via Lovable AI Gateway)
INSERT INTO credit_costs (feature, model, cost, label, duration_seconds, has_audio)
VALUES 
  ('chat_ai', 'gemini-2.5-flash', 25, 'Gemini 2.5 Flash', NULL, false),
  ('chat_ai', 'gemini-2.5-pro', 75, 'Gemini 2.5 Pro', NULL, false),
  ('chat_ai', 'gpt-5-mini', 50, 'GPT-5 Mini', NULL, false),
  ('chat_ai', 'gpt-5', 100, 'GPT-5', NULL, false);