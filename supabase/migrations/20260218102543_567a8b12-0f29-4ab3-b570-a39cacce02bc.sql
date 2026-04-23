CREATE OR REPLACE FUNCTION public.expire_credit_batches()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch record;
  v_total_expired integer := 0;
  v_user record;
BEGIN
  -- Find all expired batches that still have remaining credits
  FOR v_batch IN
    SELECT id, user_id, remaining
    FROM credit_batches
    WHERE expires_at <= now() AND remaining > 0
    FOR UPDATE
  LOOP
    -- Zero out the batch
    UPDATE credit_batches SET remaining = 0 WHERE id = v_batch.id;

    -- Deduct from user balance
    UPDATE user_credits
    SET balance = GREATEST(balance - v_batch.remaining, 0),
        updated_at = now()
    WHERE user_id = v_batch.user_id;

    -- Record expiration transaction
    INSERT INTO credit_transactions (user_id, amount, type, feature, description, balance_after)
    VALUES (
      v_batch.user_id,
      -v_batch.remaining,
      'expiration',
      'system',
      'Credits expired',
      GREATEST((SELECT balance FROM user_credits WHERE user_id = v_batch.user_id), 0)
    );

    v_total_expired := v_total_expired + v_batch.remaining;
  END LOOP;

  -- Sync balance for all users to prevent drift
  FOR v_user IN
    SELECT uc.user_id, uc.balance as current_balance,
      COALESCE(SUM(cb.remaining) FILTER (WHERE cb.expires_at > now() AND cb.remaining > 0), 0)::integer as actual_balance
    FROM user_credits uc
    LEFT JOIN credit_batches cb ON cb.user_id = uc.user_id
    GROUP BY uc.user_id, uc.balance
    HAVING uc.balance != COALESCE(SUM(cb.remaining) FILTER (WHERE cb.expires_at > now() AND cb.remaining > 0), 0)::integer
  LOOP
    UPDATE user_credits
    SET balance = v_user.actual_balance, updated_at = now()
    WHERE user_id = v_user.user_id;
  END LOOP;

  RETURN v_total_expired;
END;
$$;