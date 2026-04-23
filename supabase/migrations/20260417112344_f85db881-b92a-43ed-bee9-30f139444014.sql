CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_code TEXT;
  v_ref_code_used TEXT;
  v_ref_code_id UUID;
  v_referrer_id UUID;
  v_code_type TEXT;
BEGIN
  -- ── Block 1: Profile ──
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email));

  -- ── Block 2: Role ──
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'user');

  -- ── Block 3: Credits ──
  INSERT INTO public.user_credits (user_id, balance, total_purchased)
  VALUES (NEW.id, 0, 0);

  -- ── Block 4: Own referral code ──
  LOOP
    v_new_code := 'MF-' || UPPER(substr(md5(random()::text || NEW.id::text), 1, 6));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.referral_codes WHERE code = v_new_code);
  END LOOP;
  INSERT INTO public.referral_codes (user_id, code, code_type)
  VALUES (NEW.id, v_new_code, 'user_referral');

  -- ── Block 5: Cash wallet ──
  INSERT INTO public.cash_wallets (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  -- ── Block 6: NEW — Referral Attribution ──
  -- Safe-fail: ถ้า block นี้พัง ไม่ให้กระทบ signup flow
  BEGIN
    v_ref_code_used := NEW.raw_user_meta_data->>'referral_code_used';

    IF v_ref_code_used IS NOT NULL AND v_ref_code_used <> '' THEN
      SELECT id, user_id, code_type
        INTO v_ref_code_id, v_referrer_id, v_code_type
      FROM public.referral_codes
      WHERE code = v_ref_code_used
        AND is_active = TRUE
      LIMIT 1;

      IF v_referrer_id IS NOT NULL AND v_referrer_id <> NEW.id THEN
        INSERT INTO public.referrals (
          referrer_user_id,
          referred_user_id,
          code_id,
          code_type,
          attribution_status,
          signup_device_fp
        ) VALUES (
          v_referrer_id,
          NEW.id,
          v_ref_code_id,
          v_code_type,
          'pending',
          NEW.raw_user_meta_data->>'device_fingerprint'
        )
        ON CONFLICT (referred_user_id) DO NOTHING;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Log but don't fail signup
    RAISE WARNING '[handle_new_user] referral attribution failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;