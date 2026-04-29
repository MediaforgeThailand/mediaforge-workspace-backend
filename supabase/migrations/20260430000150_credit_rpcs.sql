-- Credit movement RPCs (org/class pool side).
--
-- Design (Q3): user_credits.balance + credit_batches are the SOURCE OF
-- TRUTH for what a user can spend. The existing consume_credits / refund_credits
-- RPCs (defined in 20260222) read from credit_batches FIFO and decrement
-- user_credits — workspace edge fns keep calling them unchanged.
--
-- The RPCs in this file handle MONEY MOVEMENT between the new org/class
-- pools AND THE USER WALLET:
--
--   topup_org_pool(org, amount)
--     Sales / super-admin adds credits to org pool. Logs.
--
--   allocate_to_class(class, amount)
--     Org admin moves credits org→class. Atomic, balance-checked.
--
--   grant_credits_to_member(class, user, amount)
--     Teacher moves credits class→user_wallet. The trick: we INSERT a
--     row into credit_batches so the existing consume_credits picks it up
--     FIFO-correctly. We also UPDATE user_credits.balance to keep the
--     scalar in sync (consume_credits relies on both).
--
-- All RPCs are SECURITY DEFINER + revoked-then-granted to enforce that
-- only authenticated callers (and service-role) can call them. The fns
-- themselves still check the caller's authorization via is_org_admin /
-- is_class_teacher.

BEGIN;

-- ─── 1. topup_org_pool ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.topup_org_pool(
  p_org_id UUID,
  p_amount INT,
  p_description TEXT DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_pool INT;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'topup_org_pool: amount must be positive';
  END IF;

  -- Authorization: super-admin only
  IF NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'topup_org_pool: super-admin required';
  END IF;

  UPDATE public.organizations
     SET credit_pool = credit_pool + p_amount,
         updated_at = NOW()
   WHERE id = p_org_id
   RETURNING credit_pool INTO v_new_pool;

  IF v_new_pool IS NULL THEN
    RAISE EXCEPTION 'topup_org_pool: org % not found', p_org_id;
  END IF;

  INSERT INTO public.pool_transactions
    (organization_id, triggered_by, amount, reason, description)
  VALUES
    (p_org_id, auth.uid(), p_amount, 'org_pool_topup', p_description);

  RETURN v_new_pool;
END;
$$;

REVOKE ALL ON FUNCTION public.topup_org_pool(UUID, INT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topup_org_pool(UUID, INT, TEXT) TO authenticated, service_role;

-- ─── 2. allocate_to_class ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.allocate_to_class(
  p_class_id UUID,
  p_amount INT,
  p_description TEXT DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
  v_org_pool INT;
  v_org_allocated INT;
  v_new_class_pool INT;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'allocate_to_class: amount must be positive';
  END IF;

  -- Lock the class row to find its org and serialise concurrent allocations
  SELECT organization_id INTO v_org_id
    FROM public.classes
   WHERE id = p_class_id AND deleted_at IS NULL
   FOR UPDATE;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'allocate_to_class: class % not found', p_class_id;
  END IF;

  -- Authorization: org_admin of the class's org
  IF NOT public.is_org_admin(auth.uid(), v_org_id) THEN
    RAISE EXCEPTION 'allocate_to_class: org admin required';
  END IF;

  -- Lock org row + check balance
  SELECT credit_pool, credit_pool_allocated
    INTO v_org_pool, v_org_allocated
    FROM public.organizations
   WHERE id = v_org_id
   FOR UPDATE;

  IF v_org_pool - v_org_allocated < p_amount THEN
    RETURN -1;  -- insufficient (caller maps to "top up org first")
  END IF;

  -- Move
  UPDATE public.organizations
     SET credit_pool_allocated = credit_pool_allocated + p_amount,
         updated_at = NOW()
   WHERE id = v_org_id;

  UPDATE public.classes
     SET credit_pool = credit_pool + p_amount,
         updated_at = NOW()
   WHERE id = p_class_id
   RETURNING credit_pool INTO v_new_class_pool;

  -- Ledger: ONE row per side (org outflow, class inflow)
  INSERT INTO public.pool_transactions
    (organization_id, triggered_by, amount, reason, description)
  VALUES
    (v_org_id, auth.uid(), -p_amount, 'org_pool_allocation',
     COALESCE(p_description, 'allocate to class'));

  INSERT INTO public.pool_transactions
    (class_id, triggered_by, amount, reason, description)
  VALUES
    (p_class_id, auth.uid(), p_amount, 'class_pool_allocation',
     COALESCE(p_description, 'allocate from org'));

  RETURN v_new_class_pool;
END;
$$;

REVOKE ALL ON FUNCTION public.allocate_to_class(UUID, INT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_to_class(UUID, INT, TEXT) TO authenticated, service_role;

-- ─── 3. grant_credits_to_member ──────────────────────────────────────
-- Teacher / org admin moves credits class.credit_pool → user wallet.
--
-- The user wallet is split across credit_batches (FIFO with expiry, used by
-- consume_credits) + user_credits.balance (scalar mirror). To keep both in
-- sync we INSERT a credit_batches row + UPDATE user_credits in the same
-- transaction.
--
-- Expiry rule for class grants:
--   - If class has end_date → expires_at = end_date + 30 days
--   - Else → expires_at = NOW() + 1 year (sane default for open-ended classes)
CREATE OR REPLACE FUNCTION public.grant_credits_to_member(
  p_class_id UUID,
  p_user_id UUID,
  p_amount INT,
  p_description TEXT DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_class_pool INT;
  v_class_consumed INT;
  v_class_end DATE;
  v_org_id UUID;
  v_expires TIMESTAMPTZ;
  v_new_balance INT;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'grant_credits_to_member: amount must be positive';
  END IF;

  -- Authorization: caller must be teacher / org-admin of this class
  IF NOT public.is_class_teacher(auth.uid(), p_class_id) THEN
    RAISE EXCEPTION 'grant_credits_to_member: class teacher required';
  END IF;

  -- Lock class row + check pool capacity
  SELECT credit_pool, credit_pool_consumed, end_date, organization_id
    INTO v_class_pool, v_class_consumed, v_class_end, v_org_id
    FROM public.classes
   WHERE id = p_class_id AND deleted_at IS NULL
   FOR UPDATE;
  IF v_class_pool IS NULL THEN
    RAISE EXCEPTION 'grant_credits_to_member: class not found';
  END IF;

  IF v_class_pool - v_class_consumed < p_amount THEN
    RETURN -1;  -- insufficient class pool
  END IF;

  -- Verify member is active in class
  IF NOT EXISTS (
    SELECT 1 FROM public.class_members
     WHERE class_id = p_class_id AND user_id = p_user_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'grant_credits_to_member: user % not in class % (or not active)',
                    p_user_id, p_class_id;
  END IF;

  -- Compute expiry
  v_expires := CASE
    WHEN v_class_end IS NOT NULL THEN (v_class_end + INTERVAL '30 days')::timestamptz
    ELSE (NOW() + INTERVAL '1 year')
  END;

  -- 1. Move credits: class pool consumed += amount
  UPDATE public.classes
     SET credit_pool_consumed = credit_pool_consumed + p_amount,
         updated_at = NOW()
   WHERE id = p_class_id;

  -- 2. INSERT credit_batches row so existing consume_credits picks it up FIFO
  INSERT INTO public.credit_batches
    (user_id, source_type, amount, remaining, expires_at, reference_id)
  VALUES
    (p_user_id, 'class_grant', p_amount, p_amount, v_expires, p_class_id::text);

  -- 3. Update user_credits.balance (scalar mirror used elsewhere)
  UPDATE public.user_credits
     SET balance = balance + p_amount,
         updated_at = NOW()
   WHERE user_id = p_user_id
   RETURNING balance INTO v_new_balance;

  IF v_new_balance IS NULL THEN
    -- Defensive: handle_new_user should have inserted this row at signup,
    -- but if it wasn't (existing user pre-Schema-C) create it.
    INSERT INTO public.user_credits (user_id, balance)
    VALUES (p_user_id, p_amount)
    ON CONFLICT (user_id) DO UPDATE
      SET balance = public.user_credits.balance + EXCLUDED.balance
    RETURNING balance INTO v_new_balance;
  END IF;

  -- 4. Mirror to class_members.credits_balance (class-scoped view)
  UPDATE public.class_members
     SET credits_balance = credits_balance + p_amount,
         credits_lifetime_received = credits_lifetime_received + p_amount,
         updated_at = NOW()
   WHERE class_id = p_class_id AND user_id = p_user_id;

  -- 5. Pool ledger: class outflow + user inflow rows
  INSERT INTO public.pool_transactions
    (class_id, triggered_by, amount, reason, description)
  VALUES
    (p_class_id, auth.uid(), -p_amount, 'class_pool_consumed',
     COALESCE(p_description, 'grant to member'));

  INSERT INTO public.pool_transactions
    (user_id, triggered_by, amount, reason, description, metadata)
  VALUES
    (p_user_id, auth.uid(), p_amount, 'member_grant',
     COALESCE(p_description, 'grant from teacher'),
     jsonb_build_object('class_id', p_class_id));

  -- 6. Activity log
  INSERT INTO public.workspace_activity
    (user_id, organization_id, class_id, activity_type, credits_used, metadata)
  VALUES
    (p_user_id, v_org_id, p_class_id, 'credits_granted', p_amount,
     jsonb_build_object('actor_id', auth.uid()));

  RETURN v_new_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.grant_credits_to_member(UUID, UUID, INT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_credits_to_member(UUID, UUID, INT, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.grant_credits_to_member(UUID, UUID, INT, TEXT) IS
  'Teacher grants credits class→user. Inserts credit_batches row so consume_credits picks it up FIFO.';

COMMIT;
