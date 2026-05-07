-- Unit tests for trg_compute_flow_pricing
-- Run manually via: psql ... -f supabase/tests/flows-pricing-trigger.test.sql
-- Each test wraps in a transaction and ROLLBACKs to leave DB clean.

\set ON_ERROR_STOP on

-- Helper: pick an arbitrary existing user_id so we satisfy NOT NULL on flows.user_id
\set test_user_id `psql -tAc "SELECT user_id FROM public.user_credits LIMIT 1" 2>/dev/null || echo '00000000-0000-0000-0000-000000000000'`

-- ─────────────────────────────────────────────────────────────
-- TEST 1: Default multiplier (NULL → 4.0), zero bonus
-- api_cost=10 → selling=40, margin=30, payout=ceil(30*0.20)=6
-- ─────────────────────────────────────────────────────────────
BEGIN;
INSERT INTO public.flows (user_id, name, api_cost)
VALUES (
  (SELECT user_id FROM public.user_credits LIMIT 1),
  'TEST_trigger_default', 10
)
RETURNING
  api_cost,
  selling_price,
  contribution_margin,
  creator_payout,
  CASE
    WHEN selling_price = 40 AND contribution_margin = 30 AND creator_payout = 6
    THEN '✅ TEST 1 PASS: default multiplier'
    ELSE '❌ TEST 1 FAIL'
  END AS result;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 2: Custom multiplier 5.0, bonus 10%
-- api_cost=20, mult=5.0 → selling=100, margin=80
-- effective_revshare = 0.20 + 0.10 = 0.30
-- payout = ceil(80 * 0.30) = 24
-- ─────────────────────────────────────────────────────────────
BEGIN;
INSERT INTO public.flows (user_id, name, api_cost, markup_multiplier, performance_bonus_percent)
VALUES (
  (SELECT user_id FROM public.user_credits LIMIT 1),
  'TEST_trigger_bonus', 20, 5.0, 10
)
RETURNING
  selling_price,
  contribution_margin,
  creator_payout,
  CASE
    WHEN selling_price = 100 AND contribution_margin = 80 AND creator_payout = 24
    THEN '✅ TEST 2 PASS: custom multiplier + bonus'
    ELSE '❌ TEST 2 FAIL'
  END AS result;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 3: Cap edge case — bonus 30% should cap revshare at 0.50
-- api_cost=100, mult=4.0 → selling=400, margin=300
-- raw revshare = 0.20 + 0.30 = 0.50 (exactly at cap)
-- payout = ceil(300 * 0.50) = 150
-- ─────────────────────────────────────────────────────────────
BEGIN;
INSERT INTO public.flows (user_id, name, api_cost, performance_bonus_percent)
VALUES (
  (SELECT user_id FROM public.user_credits LIMIT 1),
  'TEST_trigger_cap', 100, 30
)
RETURNING
  selling_price,
  contribution_margin,
  creator_payout,
  CASE
    WHEN selling_price = 400 AND contribution_margin = 300 AND creator_payout = 150
    THEN '✅ TEST 3 PASS: cap edge case (bonus=30 → revshare=0.50)'
    ELSE '❌ TEST 3 FAIL'
  END AS result;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 4: api_cost NOT NULL constraint rejects null inserts
-- (Schema migrated to NOT NULL; the original "NULL → NULL derived"
-- branch is now structurally unreachable, so this test instead
-- confirms the constraint is in force.)
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.flows (user_id, name, api_cost)
    VALUES (
      (SELECT user_id FROM public.user_credits LIMIT 1),
      'TEST_trigger_null', NULL
    );
    RAISE NOTICE '❌ TEST 4 FAIL: NULL api_cost was allowed';
  EXCEPTION WHEN not_null_violation THEN
    RAISE NOTICE '✅ TEST 4 PASS: NULL api_cost rejected by NOT NULL constraint';
  END;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 5: UPDATE re-fires trigger
-- (Must be two separate statements — chained data-modifying CTEs all
--  observe the same pre-statement snapshot, so the UPDATE wouldn't
--  find the row the INSERT just produced.)
-- ─────────────────────────────────────────────────────────────
BEGIN;
INSERT INTO public.flows (user_id, name, api_cost)
VALUES (
  (SELECT user_id FROM public.user_credits LIMIT 1),
  'TEST_trigger_update', 10
);
UPDATE public.flows
SET api_cost = 50
WHERE name = 'TEST_trigger_update'
RETURNING
  selling_price, contribution_margin, creator_payout,
  CASE
    WHEN selling_price = 200 AND contribution_margin = 150 AND creator_payout = 30
    THEN '✅ TEST 5 PASS: UPDATE re-fires trigger'
    ELSE '❌ TEST 5 FAIL'
  END AS result;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 6: CHECK constraint — markup < 1.0 should fail
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.flows (user_id, name, api_cost, markup_multiplier)
    VALUES (
      (SELECT user_id FROM public.user_credits LIMIT 1),
      'TEST_trigger_bad_markup', 10, 0.5
    );
    RAISE NOTICE '❌ TEST 6 FAIL: markup 0.5 was allowed';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '✅ TEST 6 PASS: markup < 1.0 rejected';
  END;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 7: CHECK constraint — bonus > 30 should fail
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.flows (user_id, name, api_cost, performance_bonus_percent)
    VALUES (
      (SELECT user_id FROM public.user_credits LIMIT 1),
      'TEST_trigger_bad_bonus', 10, 35
    );
    RAISE NOTICE '❌ TEST 7 FAIL: bonus 35 was allowed';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '✅ TEST 7 PASS: bonus > 30 rejected';
  END;
END $$;
ROLLBACK;
