-- Admin-side RPC aliases + revoke + class auto-end.
--
-- The org-admin-api edge fn calls these names. They wrap (or extend) the
-- Schema C credit RPCs from migration 150:
--
--   allocate_class_pool  — wraps allocate_to_class with signed delta + actor
--                          (positive = org→class allocate, negative = class→org claw-back)
--   grant_credits        — alias for grant_credits_to_member with metadata
--   revoke_credits       — NEW: pull credits back from a member to class pool
--   run_class_auto_end   — daily cron: flip status=ended for past-end_date classes

BEGIN;

-- ─── 1. allocate_class_pool (signed delta wrapper) ───────────────────
CREATE OR REPLACE FUNCTION public.allocate_class_pool(
  p_class_id UUID,
  p_delta INT,
  p_actor_id UUID DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
  v_class_pool INT;
  v_class_consumed INT;
  v_org_pool INT;
  v_org_allocated INT;
  v_new_class_pool INT;
BEGIN
  IF p_delta IS NULL OR p_delta = 0 THEN
    RAISE EXCEPTION 'allocate_class_pool: delta must be non-zero';
  END IF;

  -- Lock class
  SELECT organization_id, credit_pool, credit_pool_consumed
    INTO v_org_id, v_class_pool, v_class_consumed
    FROM public.classes
    WHERE id = p_class_id AND deleted_at IS NULL
    FOR UPDATE;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'allocate_class_pool: class % not found', p_class_id;
  END IF;

  -- Authorization: org_admin or super-admin
  IF NOT public.is_org_admin(COALESCE(p_actor_id, auth.uid()), v_org_id) THEN
    RAISE EXCEPTION 'allocate_class_pool: org admin required';
  END IF;

  -- Lock org row
  SELECT credit_pool, credit_pool_allocated
    INTO v_org_pool, v_org_allocated
    FROM public.organizations
    WHERE id = v_org_id
    FOR UPDATE;

  IF p_delta > 0 THEN
    -- Allocate org → class. Need enough unallocated.
    IF v_org_pool - v_org_allocated < p_delta THEN
      RETURN -1;  -- insufficient org pool
    END IF;
    UPDATE public.organizations
       SET credit_pool_allocated = credit_pool_allocated + p_delta,
           updated_at = NOW()
       WHERE id = v_org_id;
    UPDATE public.classes
       SET credit_pool = credit_pool + p_delta,
           updated_at = NOW()
       WHERE id = p_class_id
       RETURNING credit_pool INTO v_new_class_pool;
  ELSE
    -- Claw-back: class → org. Need enough unconsumed in class pool.
    IF v_class_pool - v_class_consumed < ABS(p_delta) THEN
      RETURN -2;  -- class pool would go negative (some already consumed by members)
    END IF;
    UPDATE public.classes
       SET credit_pool = credit_pool + p_delta,  -- p_delta is negative
           updated_at = NOW()
       WHERE id = p_class_id
       RETURNING credit_pool INTO v_new_class_pool;
    UPDATE public.organizations
       SET credit_pool_allocated = credit_pool_allocated + p_delta,
           updated_at = NOW()
       WHERE id = v_org_id;
  END IF;

  -- Ledger: dual rows (mirror direction by sign)
  INSERT INTO public.pool_transactions (organization_id, triggered_by, amount, reason, description)
  VALUES (v_org_id, COALESCE(p_actor_id, auth.uid()), -p_delta,
          CASE WHEN p_delta > 0 THEN 'org_pool_allocation' ELSE 'org_pool_revoked' END,
          p_reason);
  INSERT INTO public.pool_transactions (class_id, triggered_by, amount, reason, description)
  VALUES (p_class_id, COALESCE(p_actor_id, auth.uid()), p_delta,
          CASE WHEN p_delta > 0 THEN 'class_pool_allocation' ELSE 'class_pool_revoked' END,
          p_reason);

  RETURN v_new_class_pool;
END;
$$;

REVOKE ALL ON FUNCTION public.allocate_class_pool(UUID, INT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_class_pool(UUID, INT, UUID, TEXT) TO authenticated, service_role;

-- ─── 2. grant_credits — alias-with-metadata for grant_credits_to_member ─
CREATE OR REPLACE FUNCTION public.grant_credits(
  p_class_id UUID,
  p_user_id UUID,
  p_amount INT,
  p_actor_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_desc TEXT;
BEGIN
  v_desc := COALESCE(p_metadata->>'reason', 'manual grant');
  RETURN public.grant_credits_to_member(p_class_id, p_user_id, p_amount, v_desc);
END;
$$;

REVOKE ALL ON FUNCTION public.grant_credits(UUID, UUID, INT, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_credits(UUID, UUID, INT, UUID, JSONB) TO authenticated, service_role;

-- ─── 3. revoke_credits — pull credits back from member → class pool ────
-- Drains member's class-grant batches FIFO; updates user_credits + class_members.
-- If the member doesn't have enough class-source balance, takes what's available
-- and returns the actual revoked amount (caller can compare to p_amount).
CREATE OR REPLACE FUNCTION public.revoke_credits(
  p_class_id UUID,
  p_user_id UUID,
  p_amount INT,
  p_actor_id UUID DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS INT  -- new class_members.credits_balance
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
  v_class_consumed INT;
  v_member_bal INT;
  v_actually_revoked INT;
  v_taken_from_batches INT := 0;
  v_remaining INT;
  v_batch RECORD;
  v_new_member_bal INT;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'revoke_credits: amount must be positive';
  END IF;

  -- Authorization: must be class teacher / org admin
  IF NOT public.is_class_teacher(COALESCE(p_actor_id, auth.uid()), p_class_id) THEN
    RAISE EXCEPTION 'revoke_credits: class teacher required';
  END IF;

  SELECT c.organization_id, c.credit_pool_consumed, cm.credits_balance
    INTO v_org_id, v_class_consumed, v_member_bal
    FROM public.classes c
    JOIN public.class_members cm ON cm.class_id = c.id AND cm.user_id = p_user_id
    WHERE c.id = p_class_id AND c.deleted_at IS NULL
    FOR UPDATE;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'revoke_credits: class or member not found';
  END IF;

  -- Cap at what the member actually has from class
  v_actually_revoked := LEAST(p_amount, v_member_bal);
  IF v_actually_revoked = 0 THEN
    RETURN v_member_bal;  -- nothing to revoke
  END IF;

  -- Drain credit_batches with source_type='class_grant', reference_id=class_id, FIFO
  v_remaining := v_actually_revoked;
  FOR v_batch IN
    SELECT id, remaining
      FROM public.credit_batches
      WHERE user_id = p_user_id
        AND source_type = 'class_grant'
        AND reference_id = p_class_id::text
        AND remaining > 0
      ORDER BY created_at ASC
      FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    DECLARE v_take INT := LEAST(v_remaining, v_batch.remaining);
    BEGIN
      UPDATE public.credit_batches
         SET remaining = remaining - v_take
         WHERE id = v_batch.id;
      v_remaining := v_remaining - v_take;
      v_taken_from_batches := v_taken_from_batches + v_take;
    END;
  END LOOP;

  -- If batches didn't have enough (rare — only if user spent some from this class),
  -- take the rest from user_credits.balance directly (we still cap at v_member_bal)
  v_actually_revoked := v_taken_from_batches + (v_actually_revoked - v_taken_from_batches - v_remaining);
  IF v_actually_revoked <= 0 THEN
    RETURN v_member_bal;
  END IF;

  -- Decrement user_credits
  UPDATE public.user_credits
     SET balance = GREATEST(balance - v_actually_revoked, 0),
         updated_at = NOW()
     WHERE user_id = p_user_id;

  -- Decrement class_members + return credits to class pool
  UPDATE public.class_members
     SET credits_balance = credits_balance - v_actually_revoked,
         updated_at = NOW()
     WHERE class_id = p_class_id AND user_id = p_user_id
     RETURNING credits_balance INTO v_new_member_bal;

  UPDATE public.classes
     SET credit_pool_consumed = GREATEST(credit_pool_consumed - v_actually_revoked, 0),
         updated_at = NOW()
     WHERE id = p_class_id;

  -- Ledger
  INSERT INTO public.pool_transactions (user_id, triggered_by, amount, reason, description, metadata)
  VALUES (p_user_id, COALESCE(p_actor_id, auth.uid()), -v_actually_revoked, 'class_revoke',
          COALESCE(p_reason, 'teacher revoke'),
          jsonb_build_object('class_id', p_class_id));
  INSERT INTO public.pool_transactions (class_id, triggered_by, amount, reason, description)
  VALUES (p_class_id, COALESCE(p_actor_id, auth.uid()), v_actually_revoked, 'class_pool_allocation',
          COALESCE(p_reason, 'revoke from member'));

  -- Activity
  INSERT INTO public.workspace_activity (user_id, organization_id, class_id, activity_type, credits_used, metadata)
  VALUES (p_user_id, v_org_id, p_class_id, 'credits_revoked', v_actually_revoked,
          jsonb_build_object('actor_id', COALESCE(p_actor_id, auth.uid()), 'reason', p_reason));

  RETURN v_new_member_bal;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_credits(UUID, UUID, INT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_credits(UUID, UUID, INT, UUID, TEXT) TO authenticated, service_role;

-- ─── 4. run_class_auto_end (cron-friendly) ──────────────────────────
CREATE OR REPLACE FUNCTION public.run_class_auto_end()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  UPDATE public.classes
     SET status = 'ended', updated_at = NOW()
     WHERE status = 'active'
       AND end_date IS NOT NULL
       AND end_date < CURRENT_DATE
       AND deleted_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.run_class_auto_end() TO service_role;

COMMIT;
