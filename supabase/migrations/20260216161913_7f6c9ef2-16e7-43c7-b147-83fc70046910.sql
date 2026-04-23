
-- Fix 1: Replace overly permissive UPDATE policy on processing_jobs
DROP POLICY IF EXISTS "Service role can update jobs" ON public.processing_jobs;

-- Users can only update their own jobs (e.g. cancel)
CREATE POLICY "Users can update their own jobs"
  ON public.processing_jobs FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Fix 2: Add admin SELECT policy on profiles
CREATE POLICY "Admins can view all profiles"
  ON public.profiles FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));
