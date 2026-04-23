-- RLS policies for redemption_codes
CREATE POLICY "Users can view pending or own redeemed codes"
ON public.redemption_codes
FOR SELECT
TO authenticated
USING (status = 'pending' OR redeemed_by = auth.uid());

-- RLS policies for demo_links (check if already exists)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'demo_links' AND policyname = 'Users can view active or own demo links') THEN
    CREATE POLICY "Users can view active or own demo links"
    ON public.demo_links
    FOR SELECT
    TO authenticated
    USING (is_active = true OR redeemed_by = auth.uid());
  END IF;
END $$;