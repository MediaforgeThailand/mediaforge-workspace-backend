
CREATE TABLE public.partner_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT,
  use_case TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.partner_leads ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can insert their own lead
CREATE POLICY "Users can submit partner leads"
  ON public.partner_leads FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Anon users can also submit (no user_id)
CREATE POLICY "Anon can submit partner leads"
  ON public.partner_leads FOR INSERT TO anon
  WITH CHECK (user_id IS NULL);

-- Only admins can read all leads
CREATE POLICY "Admins can read partner leads"
  ON public.partner_leads FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
