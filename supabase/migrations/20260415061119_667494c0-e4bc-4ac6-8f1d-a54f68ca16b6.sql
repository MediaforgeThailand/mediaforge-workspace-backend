
-- Table to store phone OTP codes
CREATE TABLE public.phone_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL,
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  expires_at timestamptz NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.phone_otps ENABLE ROW LEVEL SECURITY;

-- No direct client access — only edge functions with service role can read/write
-- But we need a policy for service role (which bypasses RLS anyway)

-- Index for phone lookup
CREATE INDEX idx_phone_otps_phone ON public.phone_otps (phone, created_at DESC);

-- Auto-cleanup old OTPs (trigger on insert)
CREATE OR REPLACE FUNCTION public.cleanup_old_phone_otps()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.phone_otps
  WHERE expires_at < now() - interval '1 hour';
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cleanup_phone_otps
AFTER INSERT ON public.phone_otps
FOR EACH STATEMENT
EXECUTE FUNCTION public.cleanup_old_phone_otps();
