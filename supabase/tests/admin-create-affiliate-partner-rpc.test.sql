-- Tests for admin_create_affiliate_partner_atomic RPC.
-- Migration 20260519054033_admin_create_affiliate_partner_rpc.sql.

\set ON_ERROR_STOP on

-- ─────────────────────────────────────────────────────────────
-- TEST 1: Happy path — RPC creates application, partner, code, audit
--         all in one txn; returns jsonb with the three ids/rows.
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_user UUID;
  v_actor UUID;
  v_result jsonb;
  v_app_count INT;
  v_partner_count INT;
  v_code_count INT;
  v_audit_count INT;
BEGIN
  SELECT user_id INTO v_user
  FROM public.user_credits
  WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
    AND user_id NOT IN (SELECT user_id FROM public.referral_codes)
    AND user_id NOT IN (SELECT user_id FROM public.partners)
  ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_actor FROM public.user_credits WHERE user_id <> v_user ORDER BY user_id LIMIT 1;

  IF v_user IS NULL THEN
    RAISE EXCEPTION 'TEST 1 SETUP FAILED';
  END IF;

  v_result := public.admin_create_affiliate_partner_atomic(
    p_user_id          => v_user,
    p_actor_id         => v_actor,
    p_actor_email      => 'admin@example.com',
    p_invited_email    => 'creator@example.com',
    p_legal_first_name => 'Test',
    p_legal_last_name  => 'Creator',
    p_phone_e164       => '+66811112222',
    p_bank_name        => 'SCB',
    p_bank_account_no  => '0123456789',
    p_bank_account_name=> 'Test Creator',
    p_social_profile_url => 'https://example.com',
    p_social_platform  => 'YouTube',
    p_follower_count   => 5000,
    p_commission_rate  => 0.3,
    p_code             => 'MF-ATOMIC-CREATE',
    p_discount_percent => 20,
    p_campaign_label   => 'Invited creator'
  );

  IF v_result IS NULL OR (v_result->>'application_id') IS NULL THEN
    RAISE EXCEPTION 'TEST 1 FAIL: RPC returned %', v_result;
  END IF;

  SELECT count(*) INTO v_app_count FROM public.partner_applications WHERE user_id = v_user AND status = 'approved';
  SELECT count(*) INTO v_partner_count FROM public.partners WHERE user_id = v_user AND suspended_at IS NULL;
  SELECT count(*) INTO v_code_count FROM public.referral_codes WHERE user_id = v_user AND code = 'MF-ATOMIC-CREATE';
  SELECT count(*) INTO v_audit_count FROM public.affiliate_audit_log
    WHERE action = 'workspace_affiliate_partner_manual_created' AND entity_id = v_user::text;

  IF v_app_count = 1 AND v_partner_count = 1 AND v_code_count = 1 AND v_audit_count = 1 THEN
    RAISE NOTICE '✅ TEST 1 PASS: all four rows written atomically';
  ELSE
    RAISE EXCEPTION 'TEST 1 FAIL: app=%/1 partner=%/1 code=%/1 audit=%/1',
      v_app_count, v_partner_count, v_code_count, v_audit_count;
  END IF;
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 2: Missing bank info → RPC raises, no partial writes
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_user UUID;
  v_actor UUID;
  v_app_count INT;
BEGIN
  SELECT user_id INTO v_user
  FROM public.user_credits
  WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
    AND user_id NOT IN (SELECT user_id FROM public.referral_codes)
    AND user_id NOT IN (SELECT user_id FROM public.partners)
  ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_actor FROM public.user_credits WHERE user_id <> v_user ORDER BY user_id LIMIT 1;

  IF v_user IS NULL THEN
    RAISE EXCEPTION 'TEST 2 SETUP FAILED';
  END IF;

  BEGIN
    PERFORM public.admin_create_affiliate_partner_atomic(
      p_user_id          => v_user,
      p_actor_id         => v_actor,
      p_actor_email      => 'admin@example.com',
      p_invited_email    => 'creator2@example.com',
      p_legal_first_name => 'Test',
      p_legal_last_name  => 'NoBank',
      p_phone_e164       => '+66811112222',
      p_bank_name        => '',   -- empty
      p_bank_account_no  => '',   -- empty
      p_bank_account_name=> 'Test',
      p_social_profile_url => '',
      p_social_platform  => '',
      p_follower_count   => 0,
      p_commission_rate  => 0.3,
      p_code             => 'MF-NO-BANK',
      p_discount_percent => 20,
      p_campaign_label   => 'Invited'
    );
    RAISE EXCEPTION 'TEST 2 FAIL: missing bank info was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'bank_name and bank_account_no are required%' THEN
      RAISE EXCEPTION 'TEST 2 FAIL: wrong exception "%"', SQLERRM;
    END IF;
  END;

  SELECT count(*) INTO v_app_count FROM public.partner_applications WHERE user_id = v_user;
  IF v_app_count <> 0 THEN
    RAISE EXCEPTION 'TEST 2 FAIL: % partial application row(s) leaked', v_app_count;
  END IF;

  RAISE NOTICE '✅ TEST 2 PASS: missing bank info refused, no partial writes';
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────
-- TEST 3: Code already owned by ANOTHER partner → raises with clear msg
--         and the second partner is NOT created.
-- ─────────────────────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_user_a UUID;
  v_user_b UUID;
  v_actor UUID;
  v_app_a UUID;
  v_partners_b INT;
BEGIN
  SELECT user_id INTO v_user_a
  FROM public.user_credits
  WHERE user_id NOT IN (SELECT user_id FROM public.partner_applications)
    AND user_id NOT IN (SELECT user_id FROM public.referral_codes)
    AND user_id NOT IN (SELECT user_id FROM public.partners)
  ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_user_b
  FROM public.user_credits
  WHERE user_id <> v_user_a
    AND user_id NOT IN (SELECT user_id FROM public.partner_applications)
    AND user_id NOT IN (SELECT user_id FROM public.referral_codes)
    AND user_id NOT IN (SELECT user_id FROM public.partners)
  ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_actor FROM public.user_credits
    WHERE user_id NOT IN (v_user_a, v_user_b) ORDER BY user_id LIMIT 1;

  IF v_user_a IS NULL OR v_user_b IS NULL THEN
    RAISE EXCEPTION 'TEST 3 SETUP FAILED';
  END IF;

  -- Pre-seed partner A with the conflicting code
  INSERT INTO public.partner_applications (user_id, legal_first_name, legal_last_name, phone_e164, bank_name, bank_account_no, bank_account_name, status)
    VALUES (v_user_a, 'A', 'Existing', '+66811112222', 'SCB', '0123456789', 'A', 'approved') RETURNING id INTO v_app_a;
  INSERT INTO public.partners (user_id, application_id, commission_rate, approved_at) VALUES (v_user_a, v_app_a, 0.3, now());
  INSERT INTO public.referral_codes (user_id, code, code_type, is_active, discount_percent)
    VALUES (v_user_a, 'MF-CONFLICT', 'partner_affiliate', true, 20);

  BEGIN
    PERFORM public.admin_create_affiliate_partner_atomic(
      p_user_id          => v_user_b,
      p_actor_id         => v_actor,
      p_actor_email      => 'admin@example.com',
      p_invited_email    => 'b@example.com',
      p_legal_first_name => 'B',
      p_legal_last_name  => 'New',
      p_phone_e164       => '+66811112222',
      p_bank_name        => 'SCB',
      p_bank_account_no  => '0123456789',
      p_bank_account_name=> 'B',
      p_social_profile_url => '',
      p_social_platform  => '',
      p_follower_count   => 0,
      p_commission_rate  => 0.3,
      p_code             => 'MF-CONFLICT',   -- already owned by A
      p_discount_percent => 20,
      p_campaign_label   => 'Invited'
    );
    RAISE EXCEPTION 'TEST 3 FAIL: conflicting code was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%already owned by another partner%' THEN
      RAISE EXCEPTION 'TEST 3 FAIL: wrong exception "%"', SQLERRM;
    END IF;
  END;

  -- Partner B's record must not exist
  SELECT count(*) INTO v_partners_b FROM public.partners WHERE user_id = v_user_b;
  IF v_partners_b <> 0 THEN
    RAISE EXCEPTION 'TEST 3 FAIL: partner B leaked (% rows)', v_partners_b;
  END IF;

  RAISE NOTICE '✅ TEST 3 PASS: code conflict refused, partner B not created';
END $$;
ROLLBACK;
