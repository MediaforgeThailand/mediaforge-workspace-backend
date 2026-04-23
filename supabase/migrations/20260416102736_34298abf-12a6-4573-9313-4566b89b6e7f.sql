INSERT INTO public.credit_batches (user_id, amount, remaining, source_type, reference_id, expires_at)
VALUES (
  '20756cd6-6c3e-43f2-914f-dfa45ff3a1a8'::uuid,
  100000,
  100000,
  'redemption',
  'test-insert-005',
  now() + interval '90 days'
);