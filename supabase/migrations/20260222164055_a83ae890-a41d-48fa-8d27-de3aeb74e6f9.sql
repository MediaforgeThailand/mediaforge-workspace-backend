
-- Add base_cost and markup_multiplier to flows table for dual-sided monetization
ALTER TABLE public.flows
  ADD COLUMN IF NOT EXISTS base_cost integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS markup_multiplier numeric(4,2) NOT NULL DEFAULT 2.5;

-- Add index for quick lookups on published flows with pricing
CREATE INDEX IF NOT EXISTS idx_flows_published_pricing ON public.flows (status, base_cost) WHERE status = 'published';
