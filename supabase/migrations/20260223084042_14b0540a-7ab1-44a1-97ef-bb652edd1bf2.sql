
-- Secure debug_set_balance: require admin role
CREATE OR REPLACE FUNCTION public.debug_set_balance(p_user_id uuid, p_balance integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Require admin role
  IF NOT has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  UPDATE user_credits
  SET balance = p_balance, updated_at = now()
  WHERE user_id = p_user_id;

  IF p_balance = 0 THEN
    UPDATE credit_batches SET remaining = 0 WHERE user_id = p_user_id;
  END IF;

  INSERT INTO credit_transactions (user_id, amount, type, feature, description, balance_after)
  VALUES (p_user_id, p_balance - COALESCE((SELECT balance FROM user_credits WHERE user_id = p_user_id), 0), 'adjustment', 'debug', 'Debug: set balance to ' || p_balance, p_balance);
END;
$$;

-- Secure debug_add_credits: require admin role
CREATE OR REPLACE FUNCTION public.debug_add_credits(p_user_id uuid, p_amount integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_new_balance integer;
BEGIN
  -- Require admin role
  IF NOT has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  UPDATE user_credits
  SET balance = balance + p_amount,
      total_purchased = total_purchased + p_amount,
      updated_at = now()
  WHERE user_id = p_user_id;

  SELECT balance INTO v_new_balance FROM user_credits WHERE user_id = p_user_id;

  INSERT INTO credit_batches (user_id, amount, remaining, source_type, expires_at, reference_id)
  VALUES (p_user_id, p_amount, p_amount, 'topup', now() + interval '30 days', 'debug-' || gen_random_uuid());

  INSERT INTO credit_transactions (user_id, amount, type, feature, description, balance_after)
  VALUES (p_user_id, p_amount, 'admin_adjustment', 'debug', 'Debug: added ' || p_amount || ' credits', v_new_balance);
END;
$$;
