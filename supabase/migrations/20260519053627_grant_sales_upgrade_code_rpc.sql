-- Atomic RPC for the 100K-sales upgrade-code grant.
--
-- The previous TS implementation in affiliate-portal called supabase-js three
-- times: INSERT referral_codes → INSERT affiliate_audit_log → SELECT refreshed
-- codes. A crash or network failure between INSERTs produces an orphan
-- (code without audit, or audit without code). Even if rare, it pollutes
-- the audit trail and confuses admin investigations.
--
-- Fold all three operations into one SECURITY DEFINER plpgsql function
-- running in a single transaction. The function also moves the
-- partner-status + threshold-met checks inside the transaction so a
-- partner being suspended mid-flow can't sneak past the gate.
--
-- The function is idempotent: if the partner already has any active
-- partner_affiliate code with discount_percent >= 20, returns NULL
-- without writing anything. The caller (affiliate-portal getStatus)
-- already short-circuits via `unlocked`, but defense in depth.

CREATE OR REPLACE FUNCTION public.grant_sales_upgrade_code(
  p_user_id uuid,
  p_email text,
  p_sales_total_thb numeric,
  p_threshold_thb numeric DEFAULT 100000,
  p_discount_percent numeric DEFAULT 20
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_code text;
  v_existing_active_code_id uuid;
  v_new_code text;
  v_base_seed text;
  v_inserted_id uuid;
  v_attempt int := 0;
BEGIN
  -- Gate 1: partner must exist and not be suspended
  IF NOT EXISTS (
    SELECT 1 FROM public.partners
    WHERE user_id = p_user_id AND suspended_at IS NULL
  ) THEN
    RETURN NULL;
  END IF;

  -- Gate 2: sales must clear the threshold
  IF COALESCE(p_sales_total_thb, 0) < COALESCE(p_threshold_thb, 100000) THEN
    RETURN NULL;
  END IF;

  -- Gate 3: idempotency — bail if the partner already has any active code
  -- at or above the target discount percent
  IF EXISTS (
    SELECT 1 FROM public.referral_codes
    WHERE user_id = p_user_id
      AND code_type = 'partner_affiliate'
      AND is_active = true
      AND COALESCE(discount_percent, 0) >= p_discount_percent
  ) THEN
    RETURN NULL;
  END IF;

  -- Find an existing active code to derive a new code from (for instance,
  -- MF-AAH → MF-AAH-20). The partner may have several; pick any active.
  SELECT code INTO v_existing_code
  FROM public.referral_codes
  WHERE user_id = p_user_id
    AND code_type = 'partner_affiliate'
    AND is_active = true
  ORDER BY created_at
  LIMIT 1;

  IF v_existing_code IS NOT NULL THEN
    v_base_seed := upper(v_existing_code) || '-20';
  ELSE
    v_base_seed := 'MF-' || upper(coalesce(split_part(p_email, '@', 1), substr(p_user_id::text, 1, 8))) || '-20';
  END IF;

  -- Sanitize: keep [A-Z0-9-] only, collapse hyphens, trim
  v_base_seed := regexp_replace(v_base_seed, '[^A-Z0-9-]+', '-', 'g');
  v_base_seed := regexp_replace(v_base_seed, '-+', '-', 'g');
  v_base_seed := regexp_replace(v_base_seed, '^-|-$', '', 'g');

  -- Try the derived code; if it collides with an existing referral_codes.code
  -- (e.g., the partner already minted one in a different flow), append a
  -- numeric suffix until we find a free slot. Cap at 10 attempts then fall
  -- back to a random UUID-derived code.
  LOOP
    v_attempt := v_attempt + 1;
    IF v_attempt = 1 THEN
      v_new_code := v_base_seed;
    ELSIF v_attempt <= 10 THEN
      v_new_code := v_base_seed || '-' || v_attempt::text;
    ELSE
      v_new_code := 'MF-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)) || '-20';
    END IF;

    -- length cap to fit the existing CHECK on referral_codes.code (3-40)
    IF length(v_new_code) > 40 THEN
      v_new_code := substr(v_new_code, 1, 40);
      v_new_code := regexp_replace(v_new_code, '-$', '', 'g');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.referral_codes WHERE code = v_new_code) THEN
      EXIT;
    END IF;

    IF v_attempt > 20 THEN
      RAISE EXCEPTION 'grant_sales_upgrade_code: could not mint a unique code after 20 attempts';
    END IF;
  END LOOP;

  -- All-or-nothing: code + audit row inside one txn
  INSERT INTO public.referral_codes (
    user_id, code, code_type, is_active, campaign_label,
    discount_percent, stripe_coupon_id, discount_duration, updated_at
  ) VALUES (
    p_user_id, v_new_code, 'partner_affiliate', true, '100K sales upgrade',
    p_discount_percent, NULL, 'once', now()
  )
  RETURNING id INTO v_inserted_id;

  INSERT INTO public.affiliate_audit_log (actor_id, action, entity_type, entity_id, diff)
  VALUES (
    p_user_id,
    'workspace_affiliate_upgrade_code_granted',
    'referral_code',
    v_inserted_id::text,
    jsonb_build_object(
      'source', 'self_serve_sales_threshold',
      'partner_user_id', p_user_id,
      'sales_total_thb', p_sales_total_thb,
      'threshold_thb', p_threshold_thb,
      'discount_percent', p_discount_percent,
      'existing_code', v_existing_code,
      'new_code', v_new_code,
      'atomic_rpc', true
    )
  );

  RETURN v_inserted_id;
END;
$$;

REVOKE ALL ON FUNCTION public.grant_sales_upgrade_code(uuid, text, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.grant_sales_upgrade_code(uuid, text, numeric, numeric, numeric) TO service_role;
