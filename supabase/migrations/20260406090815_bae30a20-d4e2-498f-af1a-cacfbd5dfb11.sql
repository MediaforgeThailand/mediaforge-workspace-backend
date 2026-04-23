-- Fix Live credit_costs slugs to match frontend schema standard
-- Chat AI: add provider prefix
UPDATE public.credit_costs SET model = 'google/gemini-3-flash-preview' WHERE model = 'gemini-3-flash-preview';
UPDATE public.credit_costs SET model = 'google/gemini-3.1-pro-preview' WHERE model = 'gemini-3.1-pro-preview';
UPDATE public.credit_costs SET model = 'openai/gpt-5' WHERE model = 'gpt-5';
UPDATE public.credit_costs SET model = 'openai/gpt-5-mini' WHERE model = 'gpt-5-mini';

-- Video: fix missing -v- in slug
UPDATE public.credit_costs SET model = 'kling-v2-6-pro' WHERE model = 'kling-2-6-pro';
UPDATE public.credit_costs SET model = 'kling-v2-6-motion-pro' WHERE model = 'kling-2-6-motion-pro';