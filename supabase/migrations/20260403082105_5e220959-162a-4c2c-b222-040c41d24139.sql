-- Add recommendation foundation columns to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS industry text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS use_cases text[] DEFAULT '{}'::text[];

-- Add categories array to flows for multi-category tagging
ALTER TABLE public.flows ADD COLUMN IF NOT EXISTS categories text[] DEFAULT '{}'::text[];