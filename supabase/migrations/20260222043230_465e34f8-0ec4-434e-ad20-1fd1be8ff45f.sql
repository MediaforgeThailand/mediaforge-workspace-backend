
CREATE OR REPLACE FUNCTION public.consume_credits(p_user_id uuid, p_amount integer, p_feature text DEFAULT NULL::text, p_description text DEFAULT NULL::text, p_reference_id text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_remaining integer := p_amount;
  v_batch record;
  v_deduct integer;
  v_new_balance integer;
  v_lock_key bigint;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;

  -- Use advisory lock based on user_id to prevent concurrent modifications
  v_lock_key := ('x' || left(replace(p_user_id::text, '-', ''), 15))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Check total available credits across non-expired batches
  IF (
    SELECT COALESCE(SUM(remaining), 0)
    FROM credit_batches
    WHERE user_id = p_user_id AND remaining > 0 AND expires_at > now()
  ) < p_amount THEN
    RETURN false;
  END IF;

  -- Consume from batches: top-up first, then subscription, ordered by expiry (earliest first)
  FOR v_batch IN
    SELECT id, remaining
    FROM credit_batches
    WHERE user_id = p_user_id AND remaining > 0 AND expires_at > now()
    ORDER BY
      CASE source_type WHEN 'topup' THEN 0 ELSE 1 END,
      expires_at ASC
  LOOP
    EXIT WHEN v_remaining <= 0;

    v_deduct := LEAST(v_remaining, v_batch.remaining);
    
    UPDATE credit_batches
    SET remaining = remaining - v_deduct
    WHERE id = v_batch.id;

    v_remaining := v_remaining - v_deduct;
  END LOOP;

  -- Update user_credits balance
  UPDATE user_credits
  SET balance = balance - p_amount,
      total_used = total_used + p_amount,
      updated_at = now()
  WHERE user_id = p_user_id;

  -- Get new balance
  SELECT balance INTO v_new_balance FROM user_credits WHERE user_id = p_user_id;

  -- Record transaction
  INSERT INTO credit_transactions (user_id, amount, type, feature, description, reference_id, balance_after)
  VALUES (p_user_id, -p_amount, 'usage', p_feature, p_description, p_reference_id, COALESCE(v_new_balance, 0));

  RETURN true;
END;
$function$;
