-- Unit tests for check_canvas_workspace_ownership trigger
-- and the workspaces ↔ workspace_canvases user-id integrity rule.
--
-- Run via: psql ... -f supabase/tests/workspace-canvas-ownership.test.sql
--
-- Each test wraps in a transaction and ROLLBACKs to leave DB clean.

\set ON_ERROR_STOP on

-- ─────────────────────────────────────────────────────────────
-- TEST 1: Same-user workspace + canvas → INSERT succeeds
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  ws_id TEXT := 'TEST_ws_' || extract(epoch from clock_timestamp())::text;
  cv_id UUID;
BEGIN
  INSERT INTO public.workspaces (id, user_id, name)
  VALUES (
    ws_id,
    (SELECT user_id FROM public.user_credits ORDER BY user_id LIMIT 1),
    'TEST_owner_match'
  );

  INSERT INTO public.workspace_canvases (id, workspace_id, user_id, name)
  VALUES (
    gen_random_uuid(),
    ws_id,
    (SELECT user_id FROM public.user_credits ORDER BY user_id LIMIT 1),
    'TEST_canvas_owner_match'
  )
  RETURNING id INTO cv_id;

  IF cv_id IS NOT NULL THEN
    RAISE NOTICE '✅ TEST 1 PASS: same-user workspace + canvas insert allowed';
  ELSE
    RAISE NOTICE '❌ TEST 1 FAIL';
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 2: Cross-user workspace_id → trigger rejects with 42501
-- (Canvas claims user_id=B but workspace_id points at user A's row.)
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  user_a UUID;
  user_b UUID;
  ws_id TEXT := 'TEST_ws_cross_' || extract(epoch from clock_timestamp())::text;
BEGIN
  SELECT user_id INTO user_a FROM public.user_credits ORDER BY user_id LIMIT 1;
  SELECT user_id INTO user_b FROM public.user_credits
    WHERE user_id <> user_a ORDER BY user_id LIMIT 1;

  IF user_b IS NULL THEN
    RAISE NOTICE '⚠️ TEST 2 SKIPPED: prod DB has fewer than 2 distinct users in user_credits';
    RETURN;
  END IF;

  INSERT INTO public.workspaces (id, user_id, name)
  VALUES (ws_id, user_a, 'TEST_owner_a');

  BEGIN
    INSERT INTO public.workspace_canvases (id, workspace_id, user_id, name)
    VALUES (gen_random_uuid(), ws_id, user_b, 'TEST_cross_user');
    RAISE NOTICE '❌ TEST 2 FAIL: cross-user canvas insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '✅ TEST 2 PASS: cross-user canvas insert rejected with 42501';
  WHEN OTHERS THEN
    RAISE NOTICE '❌ TEST 2 FAIL: unexpected error class % - %', SQLSTATE, SQLERRM;
  END;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 3: workspace_canvases_touch trigger increments `revision` on UPDATE
-- (now() is frozen per-transaction so updated_at can't advance within
--  one txn, but `revision` is a deterministic, integer-valued side
--  effect that verifies the trigger actually fires.)
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  ws_id TEXT := 'TEST_ws_rev_' || extract(epoch from clock_timestamp())::text;
  cv_id UUID;
  user_id_local UUID;
  rev_before BIGINT;
  rev_after  BIGINT;
BEGIN
  SELECT user_id INTO user_id_local FROM public.user_credits ORDER BY user_id LIMIT 1;

  INSERT INTO public.workspaces (id, user_id, name)
  VALUES (ws_id, user_id_local, 'TEST_revision_ws');

  INSERT INTO public.workspace_canvases (id, workspace_id, user_id, name)
  VALUES (gen_random_uuid(), ws_id, user_id_local, 'TEST_revision_canvas')
  RETURNING id, revision INTO cv_id, rev_before;

  UPDATE public.workspace_canvases SET name = 'TEST_revision_canvas_renamed' WHERE id = cv_id
  RETURNING revision INTO rev_after;

  IF rev_after = rev_before + 1 THEN
    RAISE NOTICE '✅ TEST 3 PASS: workspace_canvases_touch incremented revision (% → %)', rev_before, rev_after;
  ELSE
    RAISE NOTICE '❌ TEST 3 FAIL: revision did not advance by 1 (before=% after=%)', rev_before, rev_after;
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 4: workspace_canvases_touch rejects user_id changes (canvas owner is immutable)
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  ws_id TEXT := 'TEST_ws_owner_immutable_' || extract(epoch from clock_timestamp())::text;
  cv_id UUID;
  user_a UUID;
  user_b UUID;
BEGIN
  SELECT user_id INTO user_a FROM public.user_credits ORDER BY user_id LIMIT 1;
  SELECT user_id INTO user_b FROM public.user_credits
    WHERE user_id <> user_a ORDER BY user_id LIMIT 1;

  IF user_b IS NULL THEN
    RAISE NOTICE '⚠️ TEST 4 SKIPPED: prod DB has fewer than 2 distinct users';
    RETURN;
  END IF;

  -- Both users own a workspace so both possible user_id values are valid for
  -- the ownership trigger; the canvas-immutable-owner trigger is the one we
  -- want to verify here.
  INSERT INTO public.workspaces (id, user_id, name)
  VALUES (ws_id, user_a, 'TEST_owner_immutable_ws');

  INSERT INTO public.workspaces (id, user_id, name)
  VALUES (ws_id || '_b', user_b, 'TEST_owner_immutable_ws_b');

  INSERT INTO public.workspace_canvases (id, workspace_id, user_id, name)
  VALUES (gen_random_uuid(), ws_id, user_a, 'TEST_owner_swap')
  RETURNING id INTO cv_id;

  BEGIN
    UPDATE public.workspace_canvases
    SET user_id = user_b, workspace_id = ws_id || '_b'
    WHERE id = cv_id;
    RAISE NOTICE '❌ TEST 4 FAIL: canvas user_id swap was allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '✅ TEST 4 PASS: canvas owner change blocked with 42501';
  WHEN OTHERS THEN
    RAISE NOTICE '❌ TEST 4 FAIL: unexpected error class % - %', SQLSTATE, SQLERRM;
  END;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 5: refund_credits exists in public schema (smoke)
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'refund_credits'
  ) THEN
    RAISE NOTICE '❌ TEST 5 FAIL: refund_credits function not found';
  ELSE
    RAISE NOTICE '✅ TEST 5 PASS: refund_credits is registered in public schema';
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 6: consume_credits exists in public schema (smoke)
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'consume_credits'
  ) THEN
    RAISE NOTICE '❌ TEST 6 FAIL: consume_credits function not found';
  ELSE
    RAISE NOTICE '✅ TEST 6 PASS: consume_credits is registered in public schema';
  END IF;
END $$;
ROLLBACK;
