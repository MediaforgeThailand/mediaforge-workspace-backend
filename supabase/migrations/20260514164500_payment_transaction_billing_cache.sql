-- Cache Stripe billing-document pointers on payment transactions.
-- The billing document sync helper writes these after reading Stripe Charge
-- and Invoice objects, so the table must carry every cached field it updates.

ALTER TABLE public.payment_transactions
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS invoice_pdf_url TEXT;

CREATE INDEX IF NOT EXISTS idx_payment_transactions_stripe_customer
  ON public.payment_transactions(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

