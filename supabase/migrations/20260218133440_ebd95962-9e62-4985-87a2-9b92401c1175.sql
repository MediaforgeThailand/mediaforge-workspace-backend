
-- Fix analytics_events INSERT policy to require user_id = auth.uid()
DROP POLICY IF EXISTS "Authenticated users can insert own analytics" ON public.analytics_events;

CREATE POLICY "Authenticated users can insert own analytics"
ON public.analytics_events
FOR INSERT
WITH CHECK (auth.uid() IS NOT NULL AND user_id = auth.uid());
