
-- API Usage Logs table for admin monitoring
CREATE TABLE public.api_usage_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  endpoint text NOT NULL,
  model text,
  feature text NOT NULL,
  status text NOT NULL DEFAULT 'success',
  credits_used integer NOT NULL DEFAULT 0,
  credits_refunded integer NOT NULL DEFAULT 0,
  duration_ms integer,
  error_message text,
  request_metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Index for admin queries
CREATE INDEX idx_api_usage_logs_created ON public.api_usage_logs (created_at DESC);
CREATE INDEX idx_api_usage_logs_user ON public.api_usage_logs (user_id, created_at DESC);
CREATE INDEX idx_api_usage_logs_feature ON public.api_usage_logs (feature, created_at DESC);

-- Enable RLS
ALTER TABLE public.api_usage_logs ENABLE ROW LEVEL SECURITY;

-- Only admins can view all logs
CREATE POLICY "Admins can view all API logs"
  ON public.api_usage_logs FOR SELECT
  USING (has_role(auth.uid(), 'admin'::app_role));

-- Users can view their own logs
CREATE POLICY "Users can view own API logs"
  ON public.api_usage_logs FOR SELECT
  USING (auth.uid() = user_id);

-- Service role inserts (from edge functions)
CREATE POLICY "Service can insert logs"
  ON public.api_usage_logs FOR INSERT
  WITH CHECK (true);

-- Auto-cleanup logs older than 90 days
CREATE OR REPLACE FUNCTION public.cleanup_old_api_logs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM public.api_usage_logs WHERE created_at < now() - interval '90 days';
  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_cleanup_old_api_logs
  AFTER INSERT ON public.api_usage_logs
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.cleanup_old_api_logs();
