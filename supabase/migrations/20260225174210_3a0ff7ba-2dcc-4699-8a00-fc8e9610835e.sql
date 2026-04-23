
-- Add first_login_at and last_visit_date to user_personas for calendar-day tracking
ALTER TABLE public.user_personas 
ADD COLUMN IF NOT EXISTS first_login_at timestamptz DEFAULT NULL,
ADD COLUMN IF NOT EXISTS last_visit_date date DEFAULT NULL;
