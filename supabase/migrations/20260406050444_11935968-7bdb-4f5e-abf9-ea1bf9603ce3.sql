
-- Create an ACID-compliant refund RPC with advisory locking
-- Mirrors the safety of consume_credits but for refunds
CREATE OR REPLACE FUNCTION public.refund_credits(
  p_user_id UUID,
  p_amount INTEGER,
  p_reason TEXT DEFAULT 'Refund',
  p_reference_id TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_lock_key bigint;
  v_new_balance integer;
BEGIN
  -- Validate input
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Refund amount must be positive';
  END IF;

  IF p_amount > 100000 THEN
    RAISE EXCEPTION 'Refund amount exceeds safety limit (100,000)';
  END IF;

  -- Advisory lock on user_id — same algorithm as consume_credits
  v_lock_key := ('x' || left(replace(p_user_id::text, '-', ''), 15))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- 1. Insert refund batch (expires in 30 days)
  INSERT INTO credit_batches (user_id, amount, remaining, source_type, reference_id, expires_at)
  VALUES (
    p_user_id,
    p_amount,
    p_amount,
    'refund',
    p_reference_id,
    now() + interval '30 days'
  );

  -- 2. Update aggregate balance
  UPDATE user_credits
  SET balance = balance + p_amount,
      updated_at = now()
  WHERE user_id = p_user_id;

  -- Get new balance for transaction log
  SELECT balance INTO v_new_balance
  FROM user_credits
  WHERE user_id = p_user_id;

  -- 3. Record transaction
  INSERT INTO credit_transactions (user_id, amount, type, feature, description, reference_id, balance_after)
  VALUES (
    p_user_id,
    p_amount,
    'refund',
    'flow_run',
    p_reason,
    p_reference_id,
    COALESCE(v_new_balance, 0)
  );
END;
$$;

-- Revoke public access — only service_role (Edge Functions) can call this
REVOKE ALL ON FUNCTION public.refund_credits(UUID, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refund_credits(UUID, INTEGER, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.refund_credits(UUID, INTEGER, TEXT, TEXT) FROM authenticated;
