-- Unschedule legacy retry-worker cron jobs.
--
-- The original schedules were created by:
--   20260421114301_2788fd1f-bfa0-47a5-b4b5-c459bfb6c57c.sql
--   20260421115848_abb6fe98-5872-473b-b57a-54e25e7197f8.sql
-- and pointed at /functions/v1/retry-worker. That edge function has been
-- removed in the same change-set: it was the queue worker for the legacy
-- multi-step pipeline retry path (run-flow-init -> execute-pipeline-step ->
-- provider_retry_queue -> retry-worker), all of which are gone now.
--
-- Production has already had both jobs unscheduled out-of-band (verified
-- via SELECT * FROM cron.job — neither was present). This migration is
-- the final state-setting step so a fresh restore that re-runs the
-- historical migrations doesn't end up with a schedule pointing at a
-- deleted edge function.
--
-- Idempotent: iterates over cron.job by name, so it is a no-op when the
-- target jobs are absent.

DO $$
DECLARE
  v_jobname text;
BEGIN
  FOR v_jobname IN
    SELECT jobname FROM cron.job
    WHERE jobname IN ('retry-worker-30s-a', 'retry-worker-30s-b')
  LOOP
    PERFORM cron.unschedule(v_jobname);
    RAISE NOTICE '[unschedule_legacy_retry_worker_cron] dropped cron job: %', v_jobname;
  END LOOP;
END;
$$;
