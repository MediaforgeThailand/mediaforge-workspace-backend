-- Workspace multi-currency payment registry.
--
-- Thailand keeps the existing PromptPay QR monthly flow. International
-- checkout uses Stripe Billing subscriptions with card-first Checkout and
-- localized presentment currencies. Rates here are seed defaults; admins can
-- update them as FX moves.

BEGIN;

CREATE TABLE IF NOT EXISTS public.workspace_payment_currencies (
  currency TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  country_hint TEXT NOT NULL,
  thb_per_unit NUMERIC(12,6) NOT NULL CHECK (thb_per_unit > 0),
  buffer_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (buffer_percent >= 0 AND buffer_percent <= 40),
  zero_decimal BOOLEAN NOT NULL DEFAULT FALSE,
  payment_strategy TEXT NOT NULL CHECK (payment_strategy IN ('promptpay_oneoff', 'stripe_subscription')),
  card_first BOOLEAN NOT NULL DEFAULT TRUE,
  local_methods TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  popularity_percent NUMERIC(6,3),
  sort_order INT NOT NULL DEFAULT 100,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.workspace_payment_currencies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view workspace payment currencies" ON public.workspace_payment_currencies;
CREATE POLICY "Anyone can view workspace payment currencies"
  ON public.workspace_payment_currencies
  FOR SELECT
  USING (TRUE);

DROP POLICY IF EXISTS "Admins can manage workspace payment currencies" ON public.workspace_payment_currencies;
CREATE POLICY "Admins can manage workspace payment currencies"
  ON public.workspace_payment_currencies
  FOR ALL
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

INSERT INTO public.workspace_payment_currencies (
  currency,
  display_name,
  country_hint,
  thb_per_unit,
  buffer_percent,
  zero_decimal,
  payment_strategy,
  card_first,
  local_methods,
  popularity_percent,
  sort_order
) VALUES
  ('thb', 'Thai baht', 'TH', 1.000000, 0, FALSE, 'promptpay_oneoff', FALSE, ARRAY['promptpay'], NULL, 0),
  ('usd', 'United States dollar', 'US', 32.400000, 25, FALSE, 'stripe_subscription', TRUE, ARRAY['card'], 48.460, 1),
  ('eur', 'Euro', 'EU', 37.550000, 23, FALSE, 'stripe_subscription', TRUE, ARRAY['card', 'sepa_debit', 'ideal'], 23.560, 2),
  ('gbp', 'Pound sterling', 'GB', 42.790000, 22, FALSE, 'stripe_subscription', TRUE, ARRAY['card', 'bacs_debit'], 7.060, 3),
  ('jpy', 'Japanese yen', 'JP', 0.213000, 30, TRUE, 'stripe_subscription', TRUE, ARRAY['card'], 3.700, 4),
  ('cad', 'Canadian dollar', 'CA', 23.150000, 25, FALSE, 'stripe_subscription', TRUE, ARRAY['card'], 3.110, 5),
  ('cny', 'Chinese renminbi', 'CN', 4.550000, 30, FALSE, 'stripe_subscription', TRUE, ARRAY['card'], 2.890, 6),
  ('hkd', 'Hong Kong dollar', 'HK', 4.170000, 28, FALSE, 'stripe_subscription', TRUE, ARRAY['card'], 1.910, 7),
  ('aud', 'Australian dollar', 'AU', 20.980000, 25, FALSE, 'stripe_subscription', TRUE, ARRAY['card', 'au_becs_debit'], 1.490, 8),
  ('sgd', 'Singapore dollar', 'SG', 24.990000, 25, FALSE, 'stripe_subscription', TRUE, ARRAY['card'], 1.430, 9)
ON CONFLICT (currency) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  country_hint = EXCLUDED.country_hint,
  thb_per_unit = EXCLUDED.thb_per_unit,
  buffer_percent = EXCLUDED.buffer_percent,
  zero_decimal = EXCLUDED.zero_decimal,
  payment_strategy = EXCLUDED.payment_strategy,
  card_first = EXCLUDED.card_first,
  local_methods = EXCLUDED.local_methods,
  popularity_percent = EXCLUDED.popularity_percent,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();

ALTER TABLE public.payment_transactions
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'thb',
  ADD COLUMN IF NOT EXISTS amount_original NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS exchange_rate_thb NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS price_buffer_percent NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS checkout_metadata JSONB NOT NULL DEFAULT '{}'::JSONB;

CREATE INDEX IF NOT EXISTS idx_payment_transactions_stripe_subscription
  ON public.payment_transactions(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_transactions_stripe_invoice_completed
  ON public.payment_transactions(stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL AND status = 'completed';

COMMENT ON TABLE public.workspace_payment_currencies IS
  'Supported Workspace checkout currencies. THB uses PromptPay one-off QR; international currencies use Stripe Billing subscriptions.';

COMMENT ON COLUMN public.workspace_payment_currencies.buffer_percent IS
  'Commercial FX/platform buffer above converted THB price. Defaults target 20-30 percent depending on currency risk and settlement spread.';

COMMIT;
