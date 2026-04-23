-- ═══════════════════════════════════════════════════════════════
-- Debug Helpers for Affiliate E2E Testing
-- Service-role-only RPCs (called via erp-affiliate-bridge with X-Bridge-Token).
-- These bypass time gates so QA can verify lifecycle without waiting 30 days.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. debug_fast_forward_commissions ─────────────────────────
-- Sets hold_until = now() - 1h for all 'holding' commissions of a partner
-- (or all partners if NULL), then calls release_commission() to flip them
-- to 'available'.
CREATE OR REPLACE FUNCTION public.debug_fast_forward_commissions(
  p_target_user_id UUID DEFAULT NULL,
  p_actor_id       UUID DEFAULT NULL
)
RETURNS TABLE (
  commissions_updated  INT,
  commissions_released INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated         INT;
  v_avail_before    INT;
  v_avail_after     INT;
BEGIN
  -- NOTE: This RPC is intended to be called only by the erp-affiliate-bridge
  -- edge function using the service_role key. The bridge enforces auth via
  -- X-Bridge-Token. When called via service_role, auth.uid() is NULL, so we
  -- accept an explicit p_actor_id from the bridge for the audit trail.
  -- If invoked directly by a client (auth.uid() IS NOT NULL), require admin.
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'not_authorized: admin role required';
  END IF;

  -- Fast-forward hold_until on still-holding commissions
  UPDATE public.commission_events
  SET hold_until = now() - INTERVAL '1 hour'
  WHERE status = 'holding'
    AND (p_target_user_id IS NULL OR partner_user_id = p_target_user_id);
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- Snapshot 'available' count before/after release
  SELECT COUNT(*) INTO v_avail_before
  FROM public.commission_events
  WHERE status = 'available'
    AND (p_target_user_id IS NULL OR partner_user_id = p_target_user_id);

  PERFORM public.release_commission();

  SELECT COUNT(*) INTO v_avail_after
  FROM public.commission_events
  WHERE status = 'available'
    AND (p_target_user_id IS NULL OR partner_user_id = p_target_user_id);

  -- Audit trail
  INSERT INTO public.affiliate_audit_log (actor_id, action, entity_type, entity_id, diff)
  VALUES (
    COALESCE(auth.uid(), p_actor_id),
    'debug_fast_forward_commissions',
    'commission_event',
    COALESCE(p_target_user_id::text, 'all'),
    jsonb_build_object(
      'hold_until_updated', v_updated,
      'newly_released',     GREATEST(v_avail_after - v_avail_before, 0)
    )
  );

  RETURN QUERY SELECT v_updated, GREATEST(v_avail_after - v_avail_before, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.debug_fast_forward_commissions(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.debug_fast_forward_commissions(UUID, UUID) TO service_role;


-- ── 2. debug_commission_timeline ──────────────────────────────
-- Returns full lifecycle history of commission_events for a partner.
CREATE OR REPLACE FUNCTION public.debug_commission_timeline(
  p_target_user_id UUID
)
RETURNS TABLE (
  commission_id            UUID,
  referral_id              UUID,
  referred_user_email      TEXT,
  commission_amount_thb    NUMERIC,
  gross_amount_thb         NUMERIC,
  net_amount_thb           NUMERIC,
  status                   TEXT,
  billing_cycle            TEXT,
  cycle_index              INT,
  stripe_invoice_id        TEXT,
  stripe_payment_intent_id TEXT,
  hold_until               TIMESTAMPTZ,
  available_at             TIMESTAMPTZ,
  paid_at                  TIMESTAMPTZ,
  reversed_at              TIMESTAMPTZ,
  reversal_reason          TEXT,
  created_at               TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'not_authorized: admin role required';
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.referral_id,
    u.email::text,
    c.commission_amount_thb,
    c.gross_amount_thb,
    c.net_amount_thb,
    c.status,
    c.billing_cycle,
    c.cycle_index,
    c.stripe_invoice_id,
    c.stripe_payment_intent_id,
    c.hold_until,
    c.available_at,
    c.paid_at,
    c.reversed_at,
    c.reversal_reason,
    c.created_at
  FROM public.commission_events c
  LEFT JOIN public.referrals r  ON r.id = c.referral_id
  LEFT JOIN auth.users     u  ON u.id = c.referred_user_id
  WHERE c.partner_user_id = p_target_user_id
  ORDER BY c.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.debug_commission_timeline(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.debug_commission_timeline(UUID) TO service_role;


-- ── 3. debug_create_test_referral ─────────────────────────────
-- Creates synthetic click + referral for manual testing, bypassing
-- the /track-click flow. Uses the partner's existing active referral_code
-- (code_type = 'partner_affiliate'), or fails if none exists.
CREATE OR REPLACE FUNCTION public.debug_create_test_referral(
  p_partner_user_id UUID,
  p_referred_email  TEXT,
  p_actor_id        UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code_id          UUID;
  v_code             TEXT;
  v_click_id         BIGINT;
  v_referred_user_id UUID;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'not_authorized: admin role required';
  END IF;

  -- Find the partner's active affiliate code
  SELECT id, code INTO v_code_id, v_code
  FROM public.referral_codes
  WHERE user_id    = p_partner_user_id
    AND code_type  = 'partner_affiliate'
    AND is_active  = true
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_code_id IS NULL THEN
    RAISE EXCEPTION 'no_active_affiliate_code_for_partner: %', p_partner_user_id;
  END IF;

  -- Resolve referred user via auth.users.email
  SELECT id INTO v_referred_user_id
  FROM auth.users
  WHERE email = p_referred_email
  LIMIT 1;

  IF v_referred_user_id IS NULL THEN
    RAISE EXCEPTION 'referred_user_not_found: %', p_referred_email;
  END IF;

  -- Synthetic click
  INSERT INTO public.referral_clicks (
    code_id, code, ip_hash, device_fp, user_agent, referrer_url, landing_path, clicked_at
  ) VALUES (
    v_code_id,
    v_code,
    encode(digest('127.0.0.1-debug', 'sha256'), 'hex'),
    'debug-fp-' || gen_random_uuid()::TEXT,
    'DebugTestAgent/1.0',
    'https://debug.mediaforge.local',
    '/',
    now()
  ) RETURNING id INTO v_click_id;

  -- Insert referral (idempotent on referred_user_id unique constraint)
  INSERT INTO public.referrals (
    referrer_user_id, referred_user_id, code_id, code_type, attribution_status, confirmed_at
  ) VALUES (
    p_partner_user_id, v_referred_user_id, v_code_id, 'partner_affiliate', 'confirmed', now()
  )
  ON CONFLICT (referred_user_id) DO NOTHING;

  -- Audit
  INSERT INTO public.affiliate_audit_log (actor_id, action, entity_type, entity_id, diff)
  VALUES (
    COALESCE(auth.uid(), p_actor_id),
    'debug_create_test_referral',
    'referral',
    v_referred_user_id::text,
    jsonb_build_object(
      'partner_user_id', p_partner_user_id,
      'click_id',        v_click_id,
      'code_id',         v_code_id,
      'code',            v_code
    )
  );

  RETURN jsonb_build_object(
    'success',          true,
    'click_id',         v_click_id,
    'code_id',          v_code_id,
    'code',             v_code,
    'referred_user_id', v_referred_user_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.debug_create_test_referral(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.debug_create_test_referral(UUID, TEXT, UUID) TO service_role;