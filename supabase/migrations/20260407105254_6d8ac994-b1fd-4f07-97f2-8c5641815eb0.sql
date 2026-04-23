-- Add keywords array column to flows table for full-text search
ALTER TABLE public.flows ADD COLUMN IF NOT EXISTS keywords text[] DEFAULT '{}';

-- GIN index for fast array containment queries on keywords
CREATE INDEX IF NOT EXISTS idx_flows_keywords ON public.flows USING GIN (keywords);

-- GIN index on existing tag columns for faster filtering
CREATE INDEX IF NOT EXISTS idx_flows_tags ON public.flows USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_flows_industry_tags ON public.flows USING GIN (industry_tags);
CREATE INDEX IF NOT EXISTS idx_flows_use_case_tags ON public.flows USING GIN (use_case_tags);

-- Index on status + updated_at for the main explore query
CREATE INDEX IF NOT EXISTS idx_flows_status_updated ON public.flows (status, updated_at DESC);