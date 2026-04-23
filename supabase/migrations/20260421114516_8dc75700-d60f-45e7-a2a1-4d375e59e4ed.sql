CREATE OR REPLACE FUNCTION public.get_retry_worker_cron_secret()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_secret TEXT;
BEGIN
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'retry_worker_cron_secret'
  LIMIT 1;
  RETURN v_secret;
END; $$;

REVOKE ALL ON FUNCTION public.get_retry_worker_cron_secret() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_retry_worker_cron_secret() TO service_role;