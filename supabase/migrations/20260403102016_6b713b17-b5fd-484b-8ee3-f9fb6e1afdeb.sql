-- Add 3-tier categorization columns to flows table
ALTER TABLE public.flows ADD COLUMN format_tags text[] DEFAULT '{}'::text[];
ALTER TABLE public.flows ADD COLUMN industry_tags text[] DEFAULT '{}'::text[];
ALTER TABLE public.flows ADD COLUMN use_case_tags text[] DEFAULT '{}'::text[];