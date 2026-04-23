-- Fix: Restrict subscription_settings to authenticated users only
DROP POLICY IF EXISTS "Anyone can view settings" ON public.subscription_settings;

CREATE POLICY "Authenticated users can view settings"
  ON public.subscription_settings FOR SELECT
  USING (auth.uid() IS NOT NULL);