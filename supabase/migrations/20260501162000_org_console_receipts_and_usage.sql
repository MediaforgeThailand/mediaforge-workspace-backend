-- Store Stripe receipt/invoice pointers for customer Admin Console billing history.
ALTER TABLE public.payment_transactions
  ADD COLUMN IF NOT EXISTS stripe_charge_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_invoice_id TEXT,
  ADD COLUMN IF NOT EXISTS receipt_url TEXT,
  ADD COLUMN IF NOT EXISTS invoice_url TEXT,
  ADD COLUMN IF NOT EXISTS receipt_number TEXT,
  ADD COLUMN IF NOT EXISTS receipt_generated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_payment_transactions_stripe_charge
  ON public.payment_transactions(stripe_charge_id)
  WHERE stripe_charge_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_transactions_stripe_invoice
  ON public.payment_transactions(stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_transactions_org_scope_created
  ON public.payment_transactions(organization_id, payment_scope, created_at DESC)
  WHERE organization_id IS NOT NULL;
