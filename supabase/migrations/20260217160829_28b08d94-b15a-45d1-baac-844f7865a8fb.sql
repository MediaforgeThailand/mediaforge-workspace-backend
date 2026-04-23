
-- Fix: Restrict analytics_events INSERT to authenticated users only
-- and validate user_id matches auth.uid()
DROP POLICY IF EXISTS "Anyone can insert analytics events" ON public.analytics_events;

CREATE POLICY "Authenticated users can insert own analytics"
  ON public.analytics_events FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL 
    AND (user_id IS NULL OR user_id = auth.uid())
  );
