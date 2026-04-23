
-- Fix: restrict insert to authenticated users only (service role bypasses RLS anyway)
DROP POLICY "Service can insert logs" ON public.api_usage_logs;
CREATE POLICY "Authenticated can insert own logs"
  ON public.api_usage_logs FOR INSERT
  WITH CHECK (auth.uid() = user_id);
