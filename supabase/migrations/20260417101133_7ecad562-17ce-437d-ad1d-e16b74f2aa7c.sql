ALTER TABLE public.referral_clicks
ADD COLUMN IF NOT EXISTS landing_path text;