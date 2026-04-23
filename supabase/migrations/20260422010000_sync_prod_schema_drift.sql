-- ═══════════════════════════════════════════════════════════════════
-- Sync local schema with prod: columns that were added directly on
-- Lovable prod but never captured in a migration file.
-- ═══════════════════════════════════════════════════════════════════

-- ── topup_packages: promo support ──────────────────────────────────
ALTER TABLE public.topup_packages
  ADD COLUMN IF NOT EXISTS is_promo BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bonus_percent INTEGER,
  ADD COLUMN IF NOT EXISTS original_credits INTEGER,
  ADD COLUMN IF NOT EXISTS one_time_per_user BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS badge_label TEXT;

-- ── flows: per-flow markup override ────────────────────────────────
ALTER TABLE public.flows
  ADD COLUMN IF NOT EXISTS markup_multiplier_override NUMERIC;

-- ── flow_runs: dismissed_at for user dismissal ─────────────────────
ALTER TABLE public.flow_runs
  ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;

-- ── payment_transactions: refund tracking ──────────────────────────
ALTER TABLE public.payment_transactions
  ADD COLUMN IF NOT EXISTS stripe_refund_id TEXT,
  ADD COLUMN IF NOT EXISTS refund_amount_thb INTEGER,
  ADD COLUMN IF NOT EXISTS refund_reason TEXT,
  ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;

-- ── referrals: commission window ───────────────────────────────────
ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS commission_window_ends_at TIMESTAMPTZ;

-- ── commission_events: reversal tracking ───────────────────────────
ALTER TABLE public.commission_events
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_by_refund_id TEXT,
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT;
