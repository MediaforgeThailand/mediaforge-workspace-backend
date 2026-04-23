
-- 1. Create a public view for community features (only exposes display_name & avatar_url)
CREATE VIEW public.profiles_public
WITH (security_invoker = on) AS
SELECT user_id, display_name, avatar_url
FROM public.profiles;

-- 2. Drop the old permissive admin SELECT policy on profiles
DROP POLICY IF EXISTS "Admins can view all profiles" ON public.profiles;

-- 3. Create a stricter admin policy that only works via service role (edge functions)
-- Admin viewing from client side is no longer needed since Admin page 
-- uses the same RLS and admin queries go through service role in edge functions
-- We keep only user's own profile access

-- 4. Enable RLS on the view (views inherit base table RLS with security_invoker)
-- The view will work because authenticated users can see their own profile row
-- For community: we need a policy that allows SELECT on profiles for the view
-- But we want to restrict what columns are accessible

-- Actually, with security_invoker=on, the view runs as the calling user
-- So we need a SELECT policy that allows reading display_name/avatar_url of others
-- The safest approach: keep own-profile policy, add a limited policy for community

-- Drop and recreate: allow all authenticated users to SELECT from profiles
-- but the view only exposes safe columns
DROP POLICY IF EXISTS "Users can view their own profile" ON public.profiles;

-- Users can still see their own full profile
CREATE POLICY "Users can view own profile"
ON public.profiles FOR SELECT
USING (auth.uid() = user_id);

-- For community view: allow reading any profile but ONLY through the view
-- Since security_invoker makes the view run as the user, we need a broader SELECT
-- We'll use a separate approach: make the view security_definer instead

-- Drop the security_invoker view and recreate as security_definer
DROP VIEW IF EXISTS public.profiles_public;

CREATE VIEW public.profiles_public
WITH (security_barrier = true) AS
SELECT user_id, display_name, avatar_url
FROM public.profiles;

-- Grant select on the view to authenticated users  
GRANT SELECT ON public.profiles_public TO authenticated;
GRANT SELECT ON public.profiles_public TO anon;
