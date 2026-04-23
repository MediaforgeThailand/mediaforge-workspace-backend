-- ════════════════════════════════════════
-- STEP 1: Create trigger on auth.users
-- ════════════════════════════════════════
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ════════════════════════════════════════
-- STEP 2: Backfill orphan users (idempotent)
-- ════════════════════════════════════════
DO $$
DECLARE
  orphan RECORD;
  v_new_code TEXT;
  v_ref_code_used TEXT;
  v_ref_code_id UUID;
  v_referrer_id UUID;
  v_code_type TEXT;
  v_orphan_count INT := 0;
  v_backfilled_count INT := 0;
BEGIN
  -- Count orphans first
  SELECT COUNT(*) INTO v_orphan_count
  FROM auth.users u
  WHERE NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = u.id)
     OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = u.id)
     OR NOT EXISTS (SELECT 1 FROM public.user_credits WHERE user_id = u.id)
     OR NOT EXISTS (SELECT 1 FROM public.referral_codes WHERE user_id = u.id AND code_type = 'user_referral');

  RAISE NOTICE '[backfill] Found % orphan users to backfill', v_orphan_count;

  FOR orphan IN
    SELECT u.id, u.email, u.raw_user_meta_data
    FROM auth.users u
    WHERE NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = u.id)
       OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = u.id)
       OR NOT EXISTS (SELECT 1 FROM public.user_credits WHERE user_id = u.id)
       OR NOT EXISTS (SELECT 1 FROM public.referral_codes WHERE user_id = u.id AND code_type = 'user_referral')
  LOOP
    -- Block 1: Profile
    INSERT INTO public.profiles (user_id, display_name)
    VALUES (orphan.id, COALESCE(orphan.raw_user_meta_data->>'full_name', orphan.email))
    ON CONFLICT (user_id) DO NOTHING;

    -- Block 2: Role
    INSERT INTO public.user_roles (user_id, role)
    VALUES (orphan.id, 'user')
    ON CONFLICT (user_id, role) DO NOTHING;

    -- Block 3: Credits
    INSERT INTO public.user_credits (user_id, balance, total_purchased)
    VALUES (orphan.id, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;

    -- Block 4: Own referral code (only if missing)
    IF NOT EXISTS (SELECT 1 FROM public.referral_codes WHERE user_id = orphan.id AND code_type = 'user_referral') THEN
      LOOP
        v_new_code := 'MF-' || UPPER(substr(md5(random()::text || orphan.id::text), 1, 6));
        EXIT WHEN NOT EXISTS (SELECT 1 FROM public.referral_codes WHERE code = v_new_code);
      END LOOP;
      INSERT INTO public.referral_codes (user_id, code, code_type)
      VALUES (orphan.id, v_new_code, 'user_referral');
    END IF;

    -- Block 5: Cash wallet
    INSERT INTO public.cash_wallets (user_id) VALUES (orphan.id)
    ON CONFLICT (user_id) DO NOTHING;

    -- Block 6: Referral attribution (safe-fail)
    BEGIN
      v_ref_code_used := orphan.raw_user_meta_data->>'referral_code_used';
      IF v_ref_code_used IS NOT NULL AND v_ref_code_used <> '' THEN
        SELECT id, user_id, code_type
          INTO v_ref_code_id, v_referrer_id, v_code_type
        FROM public.referral_codes
        WHERE code = v_ref_code_used AND is_active = TRUE
        LIMIT 1;

        IF v_referrer_id IS NOT NULL AND v_referrer_id <> orphan.id THEN
          INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status, signup_device_fp)
          VALUES (v_referrer_id, orphan.id, v_ref_code_id, v_code_type, 'pending', orphan.raw_user_meta_data->>'device_fingerprint')
          ON CONFLICT (referred_user_id) DO NOTHING;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[backfill] referral attribution failed for %: %', orphan.id, SQLERRM;
    END;

    v_backfilled_count := v_backfilled_count + 1;
    RAISE NOTICE '[backfill] Backfilled user: % (%)', orphan.email, orphan.id;
  END LOOP;

  RAISE NOTICE '[backfill] Total backfilled: %', v_backfilled_count;
END $$;

-- ════════════════════════════════════════
-- STEP 3: Verify (rollback if any check fails)
-- ════════════════════════════════════════
DO $$
DECLARE
  v_remaining_orphans INT;
  v_trigger_exists INT;
BEGIN
  -- Check 1: No orphans remaining
  SELECT COUNT(*) INTO v_remaining_orphans
  FROM auth.users u
  WHERE NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = u.id)
     OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = u.id)
     OR NOT EXISTS (SELECT 1 FROM public.user_credits WHERE user_id = u.id)
     OR NOT EXISTS (SELECT 1 FROM public.referral_codes WHERE user_id = u.id AND code_type = 'user_referral');

  IF v_remaining_orphans > 0 THEN
    RAISE EXCEPTION '[verify] FAIL: % orphan users still exist after backfill', v_remaining_orphans;
  END IF;

  -- Check 2: Trigger is attached and enabled
  SELECT COUNT(*) INTO v_trigger_exists
  FROM pg_trigger
  WHERE tgname = 'on_auth_user_created'
    AND tgrelid = 'auth.users'::regclass
    AND tgenabled = 'O';

  IF v_trigger_exists = 0 THEN
    RAISE EXCEPTION '[verify] FAIL: trigger on_auth_user_created not found or disabled';
  END IF;

  RAISE NOTICE '[verify] PASS: 0 orphans, trigger active';
END $$;