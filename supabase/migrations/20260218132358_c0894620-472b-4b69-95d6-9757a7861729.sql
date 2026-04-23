
-- Re-add admin SELECT policy for profiles (admin needs this for user management)
CREATE POLICY "Admins can view all profiles"
ON public.profiles FOR SELECT
USING (public.has_role(auth.uid(), 'admin'));
