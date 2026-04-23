
CREATE OR REPLACE FUNCTION public.debug_add_credits(p_user_id uuid, p_amount integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Log transaction with valid type
  INSERT INTO credit_transactions (user_id, amount, type, feature, description, balance_after)
  VALUES (p_user_id, p_amount, 'admin_adjustment', 'debug', 'Debug: added ' || p_amount || ' credits', v_new_balance);
END;
$function$;
