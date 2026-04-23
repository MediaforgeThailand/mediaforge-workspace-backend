-- Allow all authenticated users to view published flows
CREATE POLICY "Anyone authenticated can view published flows"
ON public.flows
FOR SELECT
USING (auth.uid() IS NOT NULL AND status = 'published');