
-- Debug helper: set user balance to a specific value
CREATE OR REPLACE FUNCTION public.debug_set_balance(p_user_id uuid, p_balance integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE user_credits
  SET balance = p_balance, updated_at = now()
  WHERE user_id = p_user_id;

  -- Also update all credit batches to match
  IF p_balance = 0 THEN
    UPDATE credit_batches SET remaining = 0 WHERE user_id = p_user_id;
  END IF;

  -- Log the debug action
  INSERT INTO credit_transactions (user_id, amount, type, feature, description, balance_after)
  VALUES (p_user_id, p_balance - COALESCE((SELECT balance FROM user_credits WHERE user_id = p_user_id), 0), 'adjustment', 'debug', 'Debug: set balance to ' || p_balance, p_balance);
END;
$$;

-- Debug helper: add credits to user
CREATE OR REPLACE FUNCTION public.debug_add_credits(p_user_id uuid, p_amount integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_new_balance integer;
BEGIN
  -- Add to user_credits
  UPDATE user_credits
  SET balance = balance + p_amount,
      total_purchased = total_purchased + p_amount,
      updated_at = now()
  WHERE user_id = p_user_id;

  SELECT balance INTO v_new_balance FROM user_credits WHERE user_id = p_user_id;

  -- Create a credit batch (expires in 30 days)
  INSERT INTO credit_batches (user_id, amount, remaining, source_type, expires_at, reference_id)
  VALUES (p_user_id, p_amount, p_amount, 'topup', now() + interval '30 days', 'debug-' || gen_random_uuid());

  -- Log transaction
  INSERT INTO credit_transactions (user_id, amount, type, feature, description, balance_after)
  VALUES (p_user_id, p_amount, 'topup', 'debug', 'Debug: added ' || p_amount || ' credits', v_new_balance);
END;
$$;
