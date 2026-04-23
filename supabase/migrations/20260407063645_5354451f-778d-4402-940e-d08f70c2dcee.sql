-- Replace gpt-5 with gpt-5.4
UPDATE credit_costs SET model = 'openai/gpt-5.4', label = 'GPT-5.4' WHERE feature = 'chat_ai' AND model = 'openai/gpt-5';

-- Remove gpt-5-mini
DELETE FROM credit_costs WHERE feature = 'chat_ai' AND model = 'openai/gpt-5-mini';

-- If no row exists for gpt-5.4 yet (e.g. the update above matched 0 rows), insert one
INSERT INTO credit_costs (feature, model, label, cost)
SELECT 'chat_ai', 'openai/gpt-5.4', 'GPT-5.4', 5
WHERE NOT EXISTS (SELECT 1 FROM credit_costs WHERE feature = 'chat_ai' AND model = 'openai/gpt-5.4');