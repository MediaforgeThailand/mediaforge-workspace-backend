
-- Add columns to credit_costs for duration/audio/pricing_type support
ALTER TABLE public.credit_costs 
  ADD COLUMN IF NOT EXISTS duration_seconds integer,
  ADD COLUMN IF NOT EXISTS has_audio boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS pricing_type text DEFAULT 'per_operation';

-- Add comment for clarity
COMMENT ON COLUMN public.credit_costs.pricing_type IS 'per_operation (flat cost), per_second (cost * duration), fixed (cost for specific duration)';
