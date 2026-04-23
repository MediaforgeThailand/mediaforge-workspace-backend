-- ═══════════════════════════════════════════════════════════════
-- Track A — Cash Wallet 100 THB bonus for user_referral
-- Track B — Fraud signal wiring on referral signup attribution
-- ═══════════════════════════════════════════════════════════════

-- ── 0. Expand cash_wallet_transactions.tx_type to include all
--    values actually used across the codebase (release_commission,
--    refund_commission, reverse_commission, award_user_referral_bonus,
--    payout_debit). Original constraint was too narrow.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.cash_wallet_transactions
  DROP CONSTRAINT IF EXISTS cash_wallet_transactions_tx_type_check;

ALTER TABLE public.cash_wallet_transactions
  ADD CONSTRAINT cash_wallet_transactions_tx_type_check
  CHECK (tx_type IN (
    'referral_bonus',      -- Track A: 100 THB user_referral bonus
    'topup_discount',      -- credits applied at checkout
    'admin_adjust',        -- manual admin credit/debit
    'refund',              -- payment refund reversal
    'commission_released', -- partner commission released from holding
    'commission_refunded', -- partner commission reversed via stripe refund
    'commission_clawback', -- partner commission clawback after payout
    'payout_debit',        -- payout paid to partner (balance decrement)
    'payout_reversal'      -- failed payout returned to balance
  ));

-- Prevent duplicate referral_bonus per referral_id
-- (tx is identified by tx_type + reference_id in the table;
-- reference_id stores the referral UUID as text).
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_wallet_tx_referral_bonus_uniq
  ON public.cash_wallet_transactions (reference_id)
  WHERE tx_type = 'referral_bonus';

-- ── 1. award_user_referral_bonus RPC ──────────────────────────
-- Triggered from stripe-webhook after a successful payment by a
-- referred user. Idempotent: safe to call multiple times.
--
-- Flow:
--   1. Look up the referred user's pending user_referral referral
--   2. Idempotency: return early if referral_bonus already granted
--      for this referral_id.
--   3. Flip attribution_status pending → confirmed
--   4. Credit 100 THB to REFERRER's cash_wallet
--   5. Insert cash_wallet_transactions row (reference_id=referral.id)
--   6. Return the new tx id, or NULL if no eligible referral / already granted.
--
-- Note: partner_affiliate commissions have their own engine
-- (accrue_commission / release_commission). This function is ONLY
-- for user_referral (friend-invites-friend) 100 THB flat bonus.
CREATE OR REPLACE FUNCTION public.award_user_referral_bonus(
  p_referred_user_id UUID
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_referral RECORD;
  v_tx_id    BIGINT;
  v_lock_key BIGINT;
  v_bonus    NUMERIC(12,2) := 100.00; -- fixed 100 THB bonus
BEGIN
  IF p_referred_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- 1. Resolve referral
  SELECT id, referrer_user_id, code_type, attribution_status
    INTO v_referral
  FROM public.referrals
  WHERE referred_user_id = p_referred_user_id
    AND code_type = 'user_referral'
    AND attribution_status IN ('pending', 'confirmed')
  LIMIT 1;

  IF v_referral.id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Cannot self-refer (guard against odd data)
  IF v_referral.referrer_user_id = p_referred_user_id THEN
    RETURN NULL;
  END IF;

  -- 2. Idempotency: already granted?
  SELECT id INTO v_tx_id
  FROM public.cash_wallet_transactions
  WHERE tx_type = 'referral_bonus'
    AND reference_id = v_referral.id::text
  LIMIT 1;

  IF v_tx_id IS NOT NULL THEN
    -- Already granted — still ensure attribution_status is confirmed.
    IF v_referral.attribution_status = 'pending' THEN
      UPDATE public.referrals
      SET attribution_status = 'confirmed', confirmed_at = now()
      WHERE id = v_referral.id;
    END IF;
    RETURN v_tx_id;
  END IF;

  -- 3. Promote attribution
  IF v_referral.attribution_status = 'pending' THEN
    UPDATE public.referrals
    SET attribution_status = 'confirmed', confirmed_at = now()
    WHERE id = v_referral.id;
  END IF;

  -- Per-user advisory lock for wallet update
  v_lock_key := ('x' || left(replace(v_referral.referrer_user_id::text, '-', ''), 15))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- 4. Ensure wallet exists, credit 100 THB
  INSERT INTO public.cash_wallets (user_id, balance_thb, lifetime_earned)
  VALUES (v_referral.referrer_user_id, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE public.cash_wallets
  SET balance_thb = balance_thb + v_bonus,
      lifetime_earned = lifetime_earned + v_bonus,
      updated_at = now()
  WHERE user_id = v_referral.referrer_user_id;

  -- 5. Ledger
  INSERT INTO public.cash_wallet_transactions (
    user_id, amount_thb, tx_type, reference_id, note
  ) VALUES (
    v_referral.referrer_user_id,
    v_bonus,
    'referral_bonus',
    v_referral.id::text,
    'User-referral 100 THB bonus: referred user first successful payment'
  )
  RETURNING id INTO v_tx_id;

  -- 6. Audit trail
  INSERT INTO public.affiliate_audit_log (actor_id, action, entity_type, entity_id, diff)
  VALUES (
    NULL, -- system action (called from webhook/service role)
    'award_user_referral_bonus',
    'referral',
    v_referral.id::text,
    jsonb_build_object(
      'referrer_user_id', v_referral.referrer_user_id,
      'referred_user_id', p_referred_user_id,
      'bonus_thb',        v_bonus,
      'wallet_tx_id',     v_tx_id
    )
  );

  RETURN v_tx_id;
END;
$$;

REVOKE ALL ON FUNCTION public.award_user_referral_bonus(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.award_user_referral_bonus(UUID) TO service_role;

COMMENT ON FUNCTION public.award_user_referral_bonus IS
  'Track A: Award 100 THB one-time bonus to the REFERRER when a user_referral reaches confirmed attribution. Idempotent per referral_id. Called from stripe-webhook after first successful payment.';

-- ═══════════════════════════════════════════════════════════════
-- #17 — Fraud Signals Wiring on Signup Attribution
-- ═══════════════════════════════════════════════════════════════
-- Populate referrals.risk_score + risk_flags at signup time,
-- based on signals captured during attribution:
--   • self_referral   : referrer == referred (+60)
--   • device_collision: same device_fp already in referrals (+40)
--   • ip_collision    : same ip_hash already in referrals (+20)
--   • velocity_signup : >= 5 signups attributed to this referrer in last 24h (+25)
--   • country_mismatch: signup_country != click country for most recent
--                       click on that code (+10)
--
-- risk_score >= 60 → attribution_status auto-set to 'fraud' (blocks bonus
-- and commission).
-- risk_score in [30,60) → kept 'pending' but flagged for manual review.
--
-- Implementation: trigger on referrals BEFORE INSERT — runs right
-- after handle_new_user() inserts the row.
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.score_referral_on_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_score  INT := 0;
  v_flags  JSONB := '[]'::jsonb;
  v_device_matches INT;
  v_ip_matches     INT;
  v_recent_signups INT;
  v_last_click_country TEXT;
BEGIN
  -- 1. Self-referral (hard block)
  IF NEW.referrer_user_id = NEW.referred_user_id THEN
    v_score := v_score + 60;
    v_flags := v_flags || jsonb_build_array('self_referral');
  END IF;

  -- 2. Device fingerprint collision (excluding this row)
  IF NEW.signup_device_fp IS NOT NULL AND NEW.signup_device_fp <> '' THEN
    SELECT COUNT(*) INTO v_device_matches
    FROM public.referrals
    WHERE signup_device_fp = NEW.signup_device_fp
      AND referred_user_id <> NEW.referred_user_id;

    IF v_device_matches > 0 THEN
      v_score := v_score + 40;
      v_flags := v_flags || jsonb_build_array('device_collision');
    END IF;
  END IF;

  -- 3. IP hash collision (excluding this row)
  IF NEW.signup_ip_hash IS NOT NULL AND NEW.signup_ip_hash <> '' THEN
    SELECT COUNT(*) INTO v_ip_matches
    FROM public.referrals
    WHERE signup_ip_hash = NEW.signup_ip_hash
      AND referred_user_id <> NEW.referred_user_id;

    IF v_ip_matches > 0 THEN
      v_score := v_score + 20;
      v_flags := v_flags || jsonb_build_array('ip_collision');
    END IF;
  END IF;

  -- 4. Velocity: > 5 signups to same referrer in past 24h
  SELECT COUNT(*) INTO v_recent_signups
  FROM public.referrals
  WHERE referrer_user_id = NEW.referrer_user_id
    AND created_at >= now() - interval '24 hours';

  IF v_recent_signups >= 5 THEN
    v_score := v_score + 25;
    v_flags := v_flags || jsonb_build_array('velocity_signup');
  END IF;

  -- 5. Country mismatch with most recent click on the same code
  IF NEW.signup_country IS NOT NULL AND NEW.code_id IS NOT NULL THEN
    SELECT country_code INTO v_last_click_country
    FROM public.referral_clicks
    WHERE code_id = NEW.code_id
      AND country_code IS NOT NULL
    ORDER BY clicked_at DESC
    LIMIT 1;

    IF v_last_click_country IS NOT NULL
       AND v_last_click_country <> NEW.signup_country THEN
      v_score := v_score + 10;
      v_flags := v_flags || jsonb_build_array('country_mismatch');
    END IF;
  END IF;

  -- 6. Cross-ref: signup_device_fp seen clicking OTHER partner's codes
  --    within the last 24h (click farm / multi-attribution fraud).
  IF NEW.signup_device_fp IS NOT NULL AND NEW.signup_device_fp <> '' THEN
    IF EXISTS (
      SELECT 1
      FROM public.referral_clicks c
      JOIN public.referral_codes rc ON rc.id = c.code_id
      WHERE c.device_fp = NEW.signup_device_fp
        AND c.clicked_at >= now() - interval '24 hours'
        AND rc.user_id <> NEW.referrer_user_id
    ) THEN
      v_score := v_score + 15;
      v_flags := v_flags || jsonb_build_array('cross_partner_device');
    END IF;
  END IF;

  NEW.risk_score := v_score;
  NEW.risk_flags := v_flags;

  -- Hard block if >= 60 → push straight to 'fraud' state so
  -- award_user_referral_bonus & accrue_commission will skip.
  IF v_score >= 60 AND NEW.attribution_status <> 'fraud' THEN
    NEW.attribution_status := 'fraud';
  END IF;

  RETURN NEW;
END;
$$;

-- The existing BEFORE INSERT trigger `trg_set_referral_commission_window`
-- runs first (sets commission_window_ends_at). This new trigger runs
-- after it, computes risk, and possibly flips to 'fraud'.
DROP TRIGGER IF EXISTS trg_score_referral_on_insert ON public.referrals;
CREATE TRIGGER trg_score_referral_on_insert
  BEFORE INSERT ON public.referrals
  FOR EACH ROW
  EXECUTE FUNCTION public.score_referral_on_insert();

-- Emit a fraud_flags row for high-severity scored referrals after insert.
-- Split from the BEFORE trigger because fraud_flags references
-- auth.users and we don't want RLS / dependency issues during insert.
CREATE OR REPLACE FUNCTION public.emit_referral_fraud_flag()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind TEXT;
BEGIN
  -- Map first flag to fraud_flags.kind
  IF NEW.risk_score >= 60 THEN
    v_kind := CASE
      WHEN NEW.risk_flags ? 'self_referral' THEN 'self_referral'
      WHEN NEW.risk_flags ? 'device_collision' OR NEW.risk_flags ? 'ip_collision' THEN 'ip_collision'
      WHEN NEW.risk_flags ? 'velocity_signup' THEN 'velocity_signup'
      ELSE 'manual_review'
    END;

    INSERT INTO public.fraud_flags (
      kind, severity, partner_id, referred_user_id, details
    ) VALUES (
      v_kind,
      'high',
      NEW.referrer_user_id,
      NEW.referred_user_id,
      jsonb_build_object(
        'referral_id',     NEW.id,
        'risk_score',      NEW.risk_score,
        'risk_flags',      NEW.risk_flags,
        'signup_ip_hash',  NEW.signup_ip_hash,
        'signup_device_fp',NEW.signup_device_fp,
        'signup_country',  NEW.signup_country
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_emit_referral_fraud_flag ON public.referrals;
CREATE TRIGGER trg_emit_referral_fraud_flag
  AFTER INSERT ON public.referrals
  FOR EACH ROW
  WHEN (NEW.risk_score >= 60)
  EXECUTE FUNCTION public.emit_referral_fraud_flag();

COMMENT ON FUNCTION public.score_referral_on_insert IS
  '#17: Score incoming referral rows with fraud heuristics (self-ref, device/IP collision, velocity, country mismatch). Scores >= 60 auto-flip to attribution_status=fraud.';

-- ─────────────────────────────────────────────────────────────
-- Patch handle_new_user so it captures signup_ip_hash and
-- signup_country from raw_user_meta_data (alongside device_fp).
-- Client/edge-function is expected to pass:
--   referral_code_used, device_fingerprint, signup_ip_hash, signup_country
-- in the auth.signUp user_metadata payload.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_code      TEXT;
  v_ref_code_used TEXT;
  v_ref_code_id   UUID;
  v_referrer_id   UUID;
  v_code_type     TEXT;
BEGIN
  -- Block 1: profile
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email));

  -- Block 2: role
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user');

  -- Block 3: credits
  INSERT INTO public.user_credits (user_id, balance, total_purchased)
  VALUES (NEW.id, 0, 0);

  -- Block 4: own referral code
  LOOP
    v_new_code := 'MF-' || UPPER(substr(md5(random()::text || NEW.id::text), 1, 6));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.referral_codes WHERE code = v_new_code);
  END LOOP;
  INSERT INTO public.referral_codes (user_id, code, code_type)
  VALUES (NEW.id, v_new_code, 'user_referral');

  -- Block 5: cash wallet
  INSERT INTO public.cash_wallets (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  -- Block 6: referral attribution (safe-fail)
  BEGIN
    v_ref_code_used := NEW.raw_user_meta_data->>'referral_code_used';

    IF v_ref_code_used IS NOT NULL AND v_ref_code_used <> '' THEN
      SELECT id, user_id, code_type
        INTO v_ref_code_id, v_referrer_id, v_code_type
      FROM public.referral_codes
      WHERE code = v_ref_code_used AND is_active = TRUE
      LIMIT 1;

      IF v_referrer_id IS NOT NULL AND v_referrer_id <> NEW.id THEN
        INSERT INTO public.referrals (
          referrer_user_id,
          referred_user_id,
          code_id,
          code_type,
          attribution_status,
          signup_device_fp,
          signup_ip_hash,
          signup_country
        ) VALUES (
          v_referrer_id,
          NEW.id,
          v_ref_code_id,
          v_code_type,
          'pending',
          NEW.raw_user_meta_data->>'device_fingerprint',
          NEW.raw_user_meta_data->>'signup_ip_hash',
          NEW.raw_user_meta_data->>'signup_country'
        )
        ON CONFLICT (referred_user_id) DO NOTHING;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[handle_new_user] referral attribution failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;
