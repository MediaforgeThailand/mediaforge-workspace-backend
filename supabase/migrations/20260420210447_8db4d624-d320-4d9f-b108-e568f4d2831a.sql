INSERT INTO public.user_roles (user_id, role)
SELECT id, 'creator'::public.app_role FROM auth.users WHERE email = 'mediaforge2026@gmail.com'
ON CONFLICT (user_id, role) DO NOTHING;