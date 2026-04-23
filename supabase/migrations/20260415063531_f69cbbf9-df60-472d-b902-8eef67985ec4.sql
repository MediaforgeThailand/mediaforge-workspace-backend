
CREATE OR REPLACE FUNCTION public.grant_credits(p_user_id uuid, p_amount integer, p_source_type text DEFAULT 'cashback'::text, p_expiry_days integer DEFAULT 90, p_description text DEFAULT 'Credit grant'::text, p_reference_id text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lock_key bigint;
  v_new_balance integer;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Grant amount must be positive';
  END IF;

  IF p_amount > 100000 THEN
    RAISE EXCEPTION 'Grant amount exceeds safety limit (100,000)';
  END IF;

  -- Advisory lock — same algorithm as consume_credits / refund_credits
  v_lock_key := ('x' || left(replace(p_user_id::text, '-', ''), 15))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- 1. Create credit batch
  INSERT INTO credit_batches (user_id, amount, remaining, source_type, reference_id, expires_at)
  VALUES (
    p_user_id,
    p_amount,
    p_amount,
    p_source_type,
    p_reference_id,
    now() + make_interval(days => p_expiry_days)
  );

  -- 2. Upsert user_credits — use COALESCE to prevent NULL + integer = NULL
  INSERT INTO user_credits (user_id, balance, total_purchased, updated_at)
  VALUES (p_user_id, p_amount, 0, now())
  ON CONFLICT (user_id) DO UPDATE
  SET balance = COALESCE(user_credits.balance, 0) + EXCLUDED.balance,
      updated_at = now();

  -- 3. Get new balance AFTER the upsert for accurate transaction log
  SELECT balance INTO v_new_balance
  FROM user_credits
  WHERE user_id = p_user_id;

  -- 4. Record transaction
  INSERT INTO credit_transactions (user_id, amount, type, feature, description, reference_id, balance_after)
  VALUES (
    p_user_id,
    p_amount,
    p_source_type,
    'credit_grant',
    p_description,
    p_reference_id,
    COALESCE(v_new_balance, 0)
  );
END;
$function$;
