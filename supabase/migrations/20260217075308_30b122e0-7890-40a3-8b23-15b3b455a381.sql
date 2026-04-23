
-- Analytics events table for self-hosted tracking (like GA4)
CREATE TABLE public.analytics_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid,
  session_id text NOT NULL,
  event_type text NOT NULL DEFAULT 'page_view',
  page_path text NOT NULL,
  page_title text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  utm_content text,
  device_type text,
  browser text,
  os text,
  screen_width integer,
  screen_height integer,
  language text,
  country text,
  city text,
  duration_ms integer,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Indexes for fast querying
CREATE INDEX idx_analytics_events_created_at ON public.analytics_events (created_at DESC);
CREATE INDEX idx_analytics_events_user_id ON public.analytics_events (user_id);
CREATE INDEX idx_analytics_events_session_id ON public.analytics_events (session_id);
CREATE INDEX idx_analytics_events_event_type ON public.analytics_events (event_type);
CREATE INDEX idx_analytics_events_page_path ON public.analytics_events (page_path);

-- Enable RLS
ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;

-- Anyone can insert (including anonymous visitors)
CREATE POLICY "Anyone can insert analytics events"
ON public.analytics_events
FOR INSERT
WITH CHECK (true);

-- Only admins can read analytics
CREATE POLICY "Admins can view all analytics"
ON public.analytics_events
FOR SELECT
USING (public.has_role(auth.uid(), 'admin'::app_role));

-- Auto-cleanup old events (keep 180 days)
CREATE OR REPLACE FUNCTION public.cleanup_old_analytics()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM public.analytics_events WHERE created_at < now() - interval '180 days';
  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_cleanup_analytics
AFTER INSERT ON public.analytics_events
FOR EACH STATEMENT
EXECUTE FUNCTION public.cleanup_old_analytics();
