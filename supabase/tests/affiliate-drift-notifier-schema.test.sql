-- Tests for the schema + cron parts of the affiliate drift email notifier
-- (migration 20260519052333_affiliate_drift_email_notifier.sql).
--
-- The edge function itself (email rendering, SendGrid call, batch UPDATE)
-- is not testable from pgTAP without mocking SendGrid + the edge runtime;
-- see the PR description for the manual smoke procedure.
--
-- All assertions fail-loud via RAISE EXCEPTION.

\set ON_ERROR_STOP on

-- ─────────────────────────────────────────────────────────────
-- TEST 1: notified_at column exists on affiliate_audit_log
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='affiliate_audit_log'
      AND column_name='notified_at'
      AND data_type='timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'TEST 1 FAIL: affiliate_audit_log.notified_at is missing';
  END IF;
  RAISE NOTICE '✅ TEST 1 PASS: affiliate_audit_log.notified_at exists';
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 2: partial index for unnotified drifts exists
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public'
      AND tablename='affiliate_audit_log'
      AND indexname='idx_affiliate_audit_log_unnotified_drift'
  ) THEN
    RAISE EXCEPTION 'TEST 2 FAIL: idx_affiliate_audit_log_unnotified_drift missing';
  END IF;
  RAISE NOTICE '✅ TEST 2 PASS: partial index for unnotified drifts exists';
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 3: Cron job is scheduled at the expected interval
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_schedule TEXT;
BEGIN
  SELECT schedule INTO v_schedule
  FROM cron.job
  WHERE jobname = 'notify-affiliate-drifts-15min';

  IF v_schedule IS NULL THEN
    RAISE EXCEPTION 'TEST 3 FAIL: notify-affiliate-drifts-15min cron is missing';
  END IF;
  IF v_schedule <> '*/15 * * * *' THEN
    RAISE EXCEPTION 'TEST 3 FAIL: schedule is "%", expected "*/15 * * * *"', v_schedule;
  END IF;
  RAISE NOTICE '✅ TEST 3 PASS: notify-affiliate-drifts-15min scheduled every 15 minutes';
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 4: A new drift row has notified_at NULL by default. Marking
--         notified_at simulates what the edge function would do; the
--         partial index should then exclude that row from future runs.
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_drift_id BIGINT;
  v_unnotified INT;
BEGIN
  INSERT INTO public.affiliate_audit_log (
    actor_id, action, entity_type, entity_id, diff
  ) VALUES (
    NULL, 'reconciliation_drift', 'partner', 'TEST-PARTNER-ID',
    jsonb_build_object('invariant', 'TEST_FAKE', 'expected', 0, 'actual', 1, 'delta', 1)
  ) RETURNING id INTO v_drift_id;

  SELECT count(*) INTO v_unnotified
  FROM public.affiliate_audit_log
  WHERE action = 'reconciliation_drift'
    AND notified_at IS NULL
    AND id = v_drift_id;
  IF v_unnotified <> 1 THEN
    RAISE EXCEPTION 'TEST 4 FAIL: new drift row not visible to unnotified query';
  END IF;

  -- Simulate notifier marking it
  UPDATE public.affiliate_audit_log SET notified_at = now() WHERE id = v_drift_id;

  SELECT count(*) INTO v_unnotified
  FROM public.affiliate_audit_log
  WHERE action = 'reconciliation_drift'
    AND notified_at IS NULL
    AND id = v_drift_id;
  IF v_unnotified <> 0 THEN
    RAISE EXCEPTION 'TEST 4 FAIL: marked row still visible to unnotified query';
  END IF;

  RAISE NOTICE '✅ TEST 4 PASS: notified_at marking removes row from pending set';
END $$;
ROLLBACK;
