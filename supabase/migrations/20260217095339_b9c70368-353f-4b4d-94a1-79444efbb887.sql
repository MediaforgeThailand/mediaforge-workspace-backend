
-- Function to expire credit batches and adjust user balances
CREATE OR REPLACE FUNCTION public.expire_credit_batches()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_batch record;
  v_total_expired integer := 0;
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

  RETURN v_total_expired;
END;
$$;

-- Trigger: run expiration check whenever someone reads their credits (lazy expiration)
CREATE OR REPLACE FUNCTION public.trigger_expire_on_credit_read()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Expire batches for this specific user only
  UPDATE credit_batches SET remaining = 0
  WHERE user_id = OLD.user_id AND expires_at <= now() AND remaining > 0;

  -- If any rows were updated, adjust balance
  IF FOUND THEN
    UPDATE user_credits
    SET balance = COALESCE((
      SELECT SUM(remaining) FROM credit_batches
      WHERE user_id = OLD.user_id AND remaining > 0 AND expires_at > now()
    ), 0),
    updated_at = now()
    WHERE user_id = OLD.user_id;
  END IF;

  RETURN OLD;
END;
$$;

-- Enable pg_cron extension for scheduled cleanup
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Schedule daily expiration at midnight UTC
SELECT cron.schedule(
  'expire-credit-batches',
  '0 0 * * *',
  $$SELECT public.expire_credit_batches()$$
);
