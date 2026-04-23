
DROP POLICY "Anyone can view active packages" ON public.credit_packages;

CREATE POLICY "Authenticated users can view active packages"
ON public.credit_packages
FOR SELECT
USING (auth.uid() IS NOT NULL AND is_active = true);
