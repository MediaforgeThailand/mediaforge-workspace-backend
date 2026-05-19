-- Layer 4 of the affiliate safety net: email notification for reconciliation
-- drifts. Reconciliation (Layer 3) writes drift rows to affiliate_audit_log;
-- this layer turns those passive log entries into active alerts admin sees
-- without polling.
--
-- Architecture (decoupled from reconciliation by design):
--   1. affiliate_audit_log gets a `notified_at` column.
--   2. Cron `notify-affiliate-drifts-15min` calls the edge function
--      `affiliate-drift-notifier` every 15 minutes via net.http_post.
--   3. The edge function reads rows WHERE action='reconciliation_drift'
--      AND notified_at IS NULL, batches them into a single digest email,
--      sends to AFFILIATE_DRIFT_ALERT_EMAILS via SendGrid, then UPDATEs
--      notified_at = now() for the rows it just emailed.
--
-- Decoupled from reconciliation so an email failure doesn't roll back the
-- detection write. Re-send by clearing notified_at; replay-safe.

ALTER TABLE public.affiliate_audit_log
  ADD COLUMN IF NOT EXISTS notified_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS idx_affiliate_audit_log_unnotified_drift
  ON public.affiliate_audit_log (created_at)
  WHERE action = 'reconciliation_drift' AND notified_at IS NULL;

-- Schedule the cron. The actual HTTP call goes to the edge function which
-- contains the SendGrid logic. cron_secret protects the endpoint from
-- being invoked by anyone other than this cron.
DO $$ BEGIN
  PERFORM cron.unschedule('notify-affiliate-drifts-15min');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'notify-affiliate-drifts-15min',
  '*/15 * * * *',
  $cron$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_project_url')
           || '/functions/v1/affiliate-drift-notifier',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'retry_worker_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cron$
);
