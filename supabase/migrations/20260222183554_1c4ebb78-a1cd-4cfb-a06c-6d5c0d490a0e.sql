-- Add subscription_grant to credit_transactions type check
ALTER TABLE public.credit_transactions DROP CONSTRAINT IF EXISTS credit_transactions_type_check;
ALTER TABLE public.credit_transactions ADD CONSTRAINT credit_transactions_type_check 
  CHECK (type = ANY (ARRAY['purchase'::text, 'usage'::text, 'bonus'::text, 'refund'::text, 'admin_adjustment'::text, 'topup'::text, 'expiration'::text, 'subscription_renewal'::text, 'subscription_grant'::text]));
