-- Billing documents: Stripe receipts/invoices plus manual ERP documents.

CREATE TABLE IF NOT EXISTS public.billing_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_transaction_id UUID REFERENCES public.payment_transactions(id) ON DELETE SET NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  document_type TEXT NOT NULL CHECK (
    document_type IN ('receipt', 'invoice', 'manual_receipt', 'manual_invoice')
  ),
  source TEXT NOT NULL CHECK (source IN ('stripe', 'manual')),
  source_reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (
    status IN ('draft', 'issued', 'emailed', 'email_failed', 'voided')
  ),
  document_number TEXT NOT NULL UNIQUE,
  title TEXT,
  currency TEXT NOT NULL DEFAULT 'thb',
  amount_minor INTEGER,
  amount_thb NUMERIC(12,2),
  credits_added INTEGER NOT NULL DEFAULT 0,
  stripe_session_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_charge_id TEXT,
  stripe_invoice_id TEXT,
  stripe_customer_id TEXT,
  receipt_url TEXT,
  invoice_url TEXT,
  invoice_pdf_url TEXT,
  email_to TEXT,
  email_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    email_status IN ('pending', 'sent', 'failed', 'skipped')
  ),
  email_error TEXT,
  email_sent_at TIMESTAMPTZ,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  created_by UUID,
  line_items JSONB NOT NULL DEFAULT '[]'::JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, document_type, source_reference)
);

CREATE INDEX IF NOT EXISTS billing_documents_user_created_idx
  ON public.billing_documents(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS billing_documents_org_created_idx
  ON public.billing_documents(organization_id, created_at DESC)
  WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS billing_documents_payment_transaction_idx
  ON public.billing_documents(payment_transaction_id);
CREATE INDEX IF NOT EXISTS billing_documents_stripe_payment_intent_idx
  ON public.billing_documents(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS billing_documents_email_status_idx
  ON public.billing_documents(email_status, created_at DESC);

DROP TRIGGER IF EXISTS update_billing_documents_updated_at ON public.billing_documents;
CREATE TRIGGER update_billing_documents_updated_at
BEFORE UPDATE ON public.billing_documents
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.billing_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own billing documents"
ON public.billing_documents FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Org admins can view organization billing documents"
ON public.billing_documents FOR SELECT
USING (
  organization_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.organization_memberships m
    WHERE m.organization_id = billing_documents.organization_id
      AND m.user_id = auth.uid()
      AND m.role = 'org_admin'
      AND m.status = 'active'
  )
);

CREATE POLICY "Admins can manage billing documents"
ON public.billing_documents FOR ALL
USING (public.has_role(auth.uid(), 'admin'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE TABLE IF NOT EXISTS public.billing_document_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_document_id UUID NOT NULL REFERENCES public.billing_documents(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_id UUID,
  actor_email TEXT,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_document_events_document_idx
  ON public.billing_document_events(billing_document_id, created_at DESC);

ALTER TABLE public.billing_document_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own billing document events"
ON public.billing_document_events FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM public.billing_documents d
    WHERE d.id = billing_document_events.billing_document_id
      AND d.user_id = auth.uid()
  )
);

CREATE POLICY "Admins can manage billing document events"
ON public.billing_document_events FOR ALL
USING (public.has_role(auth.uid(), 'admin'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));
