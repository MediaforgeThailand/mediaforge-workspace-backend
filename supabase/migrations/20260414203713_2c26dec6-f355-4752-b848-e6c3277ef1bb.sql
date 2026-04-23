ALTER TABLE public.credit_transactions DROP CONSTRAINT IF EXISTS credit_transactions_type_check;
ALTER TABLE public.credit_transactions ADD CONSTRAINT credit_transactions_type_check
  CHECK (
    type = ANY (
      ARRAY[
        'purchase',
        'usage',
        'bonus',
        'refund',
        'admin_adjustment',
        'topup',
        'expiration',
        'subscription_renewal',
        'subscription_grant',
        'subscription',
        'demo_link',
        'cashback'
      ]
    )
  );