-- ─── 1. cash_wallet_withdrawals ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cash_wallet_withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  amount_thb NUMERIC(14,2) NOT NULL CHECK (amount_thb >= 500),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','paid','cancelled')),
  bank_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  bank_reference TEXT,
  rejection_reason TEXT,
  admin_note TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES auth.users(id),
  paid_at TIMESTAMPTZ,
  paid_by UUID REFERENCES auth.users(id),
  rejected_at TIMESTAMPTZ,
  rejected_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cww_status_requested
  ON public.cash_wallet_withdrawals (status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_cww_user
  ON public.cash_wallet_withdrawals (user_id, requested_at DESC);

ALTER TABLE public.cash_wallet_withdrawals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own withdrawals" ON public.cash_wallet_withdrawals;
CREATE POLICY "Users can view own withdrawals"
  ON public.cash_wallet_withdrawals FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins can view all withdrawals" ON public.cash_wallet_withdrawals;
CREATE POLICY "Admins can view all withdrawals"
  ON public.cash_wallet_withdrawals FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Admins can manage withdrawals" ON public.cash_wallet_withdrawals;
CREATE POLICY "Admins can manage withdrawals"
  ON public.cash_wallet_withdrawals FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER trg_cww_updated_at
  BEFORE UPDATE ON public.cash_wallet_withdrawals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─── 2. partner_admin_notes ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.partner_admin_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_user_id UUID NOT NULL REFERENCES public.partners(user_id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES auth.users(id),
  note TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal','partner_visible')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pan_partner_created
  ON public.partner_admin_notes (partner_user_id, created_at DESC);

ALTER TABLE public.partner_admin_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage all notes" ON public.partner_admin_notes;
CREATE POLICY "Admins can manage all notes"
  ON public.partner_admin_notes FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Partners view own visible notes" ON public.partner_admin_notes;
CREATE POLICY "Partners view own visible notes"
  ON public.partner_admin_notes FOR SELECT
  USING (
    auth.uid() = partner_user_id
    AND visibility = 'partner_visible'
  );

CREATE TRIGGER trg_pan_updated_at
  BEFORE UPDATE ON public.partner_admin_notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─── 3. partners tier override columns ──────────────────────────────
ALTER TABLE public.partners
  ADD COLUMN IF NOT EXISTS tier_override_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tier_override_reason TEXT,
  ADD COLUMN IF NOT EXISTS tier_override_set_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS tier_override_set_at TIMESTAMPTZ;
