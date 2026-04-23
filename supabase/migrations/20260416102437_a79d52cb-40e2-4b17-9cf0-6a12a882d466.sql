INSERT INTO credit_batches (user_id, amount, remaining, source_type, reference_id, expires_at)
VALUES (
  '20756cd6-6c3e-43f2-914f-dfa45ff3a1a8',
  100000,
  100000,
  'redemption',
  'manual-fix-002',
  now() + interval '90 days'
);

UPDATE user_credits
SET balance = COALESCE(balance, 0) + 100000, updated_at = now()
WHERE user_id = '20756cd6-6c3e-43f2-914f-dfa45ff3a1a8';

INSERT INTO credit_transactions (user_id, amount, type, feature, description, reference_id, balance_after)
VALUES (
  '20756cd6-6c3e-43f2-914f-dfa45ff3a1a8',
  100000,
  'redemption',
  'credit_grant',
  'Manual credit grant - system fix',
  'manual-fix-002',
  100000
);