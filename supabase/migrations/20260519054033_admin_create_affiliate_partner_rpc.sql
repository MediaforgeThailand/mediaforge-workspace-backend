-- Atomic RPC for the admin-invite "create partner" flow.
--
-- The previous TS implementation in admin_workspace_affiliates called
-- supabase-js four times: upsert partner_applications → upsert partners →
-- upsertCode (which itself does a SELECT + INSERT/UPDATE + Stripe coupon) →
-- INSERT affiliate_audit_log. A failure between calls produced a partial
-- partner: an approved application without a partners row, or a partner
-- without a code, or all of those without an audit trail.
--
-- This RPC moves the four DB writes (application, partner, code, audit)
-- into a single transaction. Stripe coupon creation stays in TS because
-- pg_net is async and waiting for a coupon_id round-trip inside plpgsql
-- isn't worth the complexity — admin updates the code's stripe_coupon_id
-- via a separate UPDATE after the RPC succeeds, and a Stripe failure no
-- longer leaves the partner half-created.

CREATE OR REPLACE FUNCTION public.admin_create_affiliate_partner_atomic(
  p_user_id uuid,
  p_actor_id uuid,
  p_actor_email text,
  p_invited_email text,
  p_legal_first_name text,
  p_legal_last_name text,
  p_phone_e164 text,
  p_bank_name text,
  p_bank_account_no text,
  p_bank_account_name text,
  p_social_profile_url text,
  p_social_platform text,
  p_follower_count int,
  p_commission_rate numeric,
  p_code text,
  p_discount_percent numeric,
  p_campaign_label text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_app_id uuid;
  v_partner_row partners%ROWTYPE;
  v_code_row referral_codes%ROWTYPE;
  v_now timestamptz := now();
  v_tier text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;
  IF p_bank_name IS NULL OR length(btrim(p_bank_name)) = 0
     OR p_bank_account_no IS NULL OR length(btrim(p_bank_account_no)) = 0 THEN
    RAISE EXCEPTION 'bank_name and bank_account_no are required';
  END IF;

  v_tier := CASE WHEN p_discount_percent >= 20 THEN 'creator_20' ELSE 'standard' END;

  -- 1. Upsert partner_applications (approved by admin in one shot)
  INSERT INTO public.partner_applications (
    user_id, legal_first_name, legal_last_name, phone_e164,
    bank_name, bank_account_no, bank_account_name,
    social_profile_url, social_platform, follower_count,
    status, reviewed_by, reviewed_at, rejection_reason, needs_info_message,
    submitted_at, updated_at
  ) VALUES (
    p_user_id, p_legal_first_name, p_legal_last_name, COALESCE(p_phone_e164, '-'),
    p_bank_name, p_bank_account_no, p_bank_account_name,
    p_social_profile_url, p_social_platform, COALESCE(p_follower_count, 0),
    'approved', p_actor_id, v_now, NULL, NULL,
    v_now, v_now
  )
  ON CONFLICT (user_id) DO UPDATE SET
    legal_first_name   = EXCLUDED.legal_first_name,
    legal_last_name    = EXCLUDED.legal_last_name,
    phone_e164         = EXCLUDED.phone_e164,
    bank_name          = EXCLUDED.bank_name,
    bank_account_no    = EXCLUDED.bank_account_no,
    bank_account_name  = EXCLUDED.bank_account_name,
    social_profile_url = EXCLUDED.social_profile_url,
    social_platform    = EXCLUDED.social_platform,
    follower_count     = EXCLUDED.follower_count,
    status             = 'approved',
    reviewed_by        = EXCLUDED.reviewed_by,
    reviewed_at        = EXCLUDED.reviewed_at,
    rejection_reason   = NULL,
    needs_info_message = NULL,
    submitted_at       = COALESCE(public.partner_applications.submitted_at, EXCLUDED.submitted_at),
    updated_at         = EXCLUDED.updated_at
  RETURNING id INTO v_app_id;

  -- 2. Upsert partners. The previous version cleared suspended_at on
  --    every re-invite — silent ban bypass. Now: if the existing row is
  --    suspended, raise instead of un-suspending. Admin must explicitly
  --    reactivate via a separate path (audit trail intact).
  IF EXISTS (
    SELECT 1 FROM public.partners
    WHERE user_id = p_user_id AND suspended_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'partner_suspended: cannot re-invite a suspended partner; explicit unsuspend required';
  END IF;

  INSERT INTO public.partners (
    user_id, application_id, commission_rate, tier,
    approved_at, suspended_at, suspended_reason
  ) VALUES (
    p_user_id, v_app_id, p_commission_rate, v_tier,
    v_now, NULL, NULL
  )
  ON CONFLICT (user_id) DO UPDATE SET
    application_id    = EXCLUDED.application_id,
    commission_rate   = EXCLUDED.commission_rate,
    tier              = EXCLUDED.tier,
    approved_at       = EXCLUDED.approved_at
    -- DO NOT clear suspended_at / suspended_reason here. The IF EXISTS
    -- check above already short-circuited on suspended rows, and a non-
    -- suspended row had NULL values anyway — preserve whatever's stored.
  RETURNING * INTO v_partner_row;

  -- 3. Upsert referral_codes. The DO UPDATE branch must NEVER touch a row
  --    whose user_id doesn't match this invitation — otherwise a race
  --    between EXISTS and INSERT would let one admin rewrite another
  --    partner's is_active/campaign_label/discount_percent (the
  --    user_id stays unchanged but the metadata gets clobbered). We
  --    add WHERE referral_codes.user_id = p_user_id so a foreign row
  --    causes the INSERT to refuse-via-no-action; we then detect the
  --    "0 rows affected" case via FOUND and raise the expected error.
  INSERT INTO public.referral_codes (
    user_id, code, code_type, is_active, campaign_label,
    discount_percent, stripe_coupon_id, discount_duration, updated_at
  ) VALUES (
    p_user_id, p_code, 'partner_affiliate', true, COALESCE(p_campaign_label, 'Invited creator'),
    p_discount_percent, NULL, 'once', v_now
  )
  ON CONFLICT (code) DO UPDATE SET
    is_active        = true,
    campaign_label   = EXCLUDED.campaign_label,
    discount_percent = EXCLUDED.discount_percent,
    updated_at       = EXCLUDED.updated_at
    WHERE referral_codes.user_id = p_user_id
  RETURNING * INTO v_code_row;

  IF v_code_row.id IS NULL THEN
    -- ON CONFLICT matched a row owned by a different partner — the
    -- WHERE-on-DO-UPDATE filtered it out. Raise the expected message.
    RAISE EXCEPTION 'affiliate code % is already owned by another partner', p_code;
  END IF;

  -- 4. Audit log
  INSERT INTO public.affiliate_audit_log (actor_id, action, entity_type, entity_id, diff)
  VALUES (
    p_actor_id,
    'workspace_affiliate_partner_manual_created',
    'partner',
    p_user_id::text,
    jsonb_build_object(
      'actor_email', p_actor_email,
      'email', p_invited_email,
      'code', p_code,
      'discount_percent', p_discount_percent,
      'commission_rate', p_commission_rate,
      'atomic_rpc', true
    )
  );

  RETURN jsonb_build_object(
    'application_id', v_app_id,
    'partner', row_to_json(v_partner_row),
    'code', row_to_json(v_code_row)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_affiliate_partner_atomic(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text, int, numeric, text, numeric, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_affiliate_partner_atomic(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text, int, numeric, text, numeric, text
) TO service_role;
