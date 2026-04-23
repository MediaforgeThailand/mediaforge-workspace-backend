
-- Create private kyc-docs bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('kyc-docs', 'kyc-docs', false)
ON CONFLICT (id) DO NOTHING;

-- RLS: users can upload/read/delete their own KYC files (path: {userId}/...)
CREATE POLICY "Users can upload own KYC docs"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'kyc-docs' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can read own KYC docs"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'kyc-docs' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can update own KYC docs"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'kyc-docs' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can delete own KYC docs"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'kyc-docs' AND auth.uid()::text = (storage.foldername(name))[1]);

-- Allow users to upsert/select their own partner_application draft
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='partner_applications' AND policyname='Users can view own application'
  ) THEN
    CREATE POLICY "Users can view own application"
    ON public.partner_applications FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='partner_applications' AND policyname='Users can insert own application'
  ) THEN
    CREATE POLICY "Users can insert own application"
    ON public.partner_applications FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='partner_applications' AND policyname='Users can update own draft application'
  ) THEN
    CREATE POLICY "Users can update own draft application"
    ON public.partner_applications FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id AND status IN ('draft','needs_info'))
    WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;
