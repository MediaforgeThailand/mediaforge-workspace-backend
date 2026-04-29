-- Slim handle_new_user for workspace project (Q6).
--
-- The prod fork's handle_new_user (latest version at 20260222) inserts:
--   1. profiles                   (user_id, display_name)
--   2. user_roles                 (user_id, role='user')
--   3. user_credits               (user_id, balance=50, total_purchased=0)  ← welcome credits
--   4. credit_transactions        (welcome bonus tx)
--   5. credit_batches             (welcome bonus batch with expiry)
--   + occasionally referral_codes / cash_wallets via downstream migrations
--
-- For workspace product we DON'T want welcome credits (org users get
-- class-allocated credits; consumer crossover happens later via Phase 2).
-- Slim version keeps just:
--   1. profiles
--   2. user_roles  ('user' role)
--   3. user_credits  (balance=0)
--
-- The post-auth trigger zz_post_auth_org_assign (013) flips account_type
-- to 'org_user' if the email domain matches a verified org.
--
-- We preserve the existing trigger binding `on_auth_user_created` — only
-- the function body is rewritten. Both the existing trigger name and
-- this function name are unchanged so deployment is in-place.

BEGIN;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 1. profiles — display_name + avatar_url from OAuth metadata when available.
  INSERT INTO public.profiles (user_id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      split_part(COALESCE(NEW.email, ''), '@', 1),
      'New user'
    ),
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (user_id) DO NOTHING;

  -- 2. user_roles — every signup gets the default 'user' role.
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'user')
  ON CONFLICT (user_id, role) DO NOTHING;

  -- 3. user_credits — start at 0 for both populations:
  --    Org users get filled by class teacher (grant_credits_to_member).
  --    Consumer users (Phase 2) inherit from prod via external_user_id sync.
  INSERT INTO public.user_credits (user_id, balance, total_purchased, total_used)
  VALUES (NEW.id, 0, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user() IS
  'Slim signup handler for workspace project: profiles + user_roles + user_credits (balance=0). Org assignment lives in zz_post_auth_org_assign.';

COMMIT;
