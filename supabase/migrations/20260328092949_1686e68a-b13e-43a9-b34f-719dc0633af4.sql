
-- Sync user_credits.balance to match actual non-expired credit_batches
-- This fixes drift where balance field is stale but batches have expired
UPDATE user_credits uc
SET balance = sub.actual_balance, updated_at = now()
FROM (
  SELECT uc2.user_id,
    COALESCE(SUM(cb.remaining) FILTER (WHERE cb.expires_at > now() AND cb.remaining > 0), 0)::integer as actual_balance
  FROM user_credits uc2
  LEFT JOIN credit_batches cb ON cb.user_id = uc2.user_id
  GROUP BY uc2.user_id
) sub
WHERE uc.user_id = sub.user_id AND uc.balance != sub.actual_balance;

-- Add fresh credit batch for user fb4de7e2 so they can run flows
INSERT INTO credit_batches (user_id, amount, remaining, source_type, expires_at, reference_id)
VALUES (
  'fb4de7e2-9f6e-459b-bb1b-464f6ae14bea',
  20000, 20000, 'topup',
  now() + interval '90 days',
  'balance-sync-' || gen_random_uuid()
);

-- Update balance to include new batch
UPDATE user_credits
SET balance = 20000 + 180, total_purchased = total_purchased + 20000, updated_at = now()
WHERE user_id = 'fb4de7e2-9f6e-459b-bb1b-464f6ae14bea';
