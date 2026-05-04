-- Team seat checkout and self-serve team accounts.
--
-- Team is a Workspace-native shared-credit account. It reuses the existing
-- organizations + organization_memberships + classes tables, but does not
-- require ERP provisioning or a verified domain. Stripe webhook calls the
-- RPC below after a successful in-app PromptPay/card PaymentIntent.

BEGIN;

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_type_check;

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_type_check
  CHECK (type IN ('school', 'university', 'enterprise', 'agency', 'team'));

ALTER TABLE public.payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_payment_scope_check;

ALTER TABLE public.payment_transactions
  ADD CONSTRAINT payment_transactions_payment_scope_check
  CHECK (payment_scope IN ('user', 'organization', 'team'));

ALTER TABLE public.pool_transactions
  DROP CONSTRAINT IF EXISTS pool_transactions_reason_check;

ALTER TABLE public.pool_transactions
  ADD CONSTRAINT pool_transactions_reason_check CHECK (reason IN (
    'member_grant',
    'cycle_reset',
    'cycle_drip',
    'class_revoke',
    'class_pool_allocation',
    'class_pool_consumed',
    'class_pool_revoked',
    'org_pool_topup',
    'org_pool_allocation',
    'org_pool_revoked',
    'org_node_run',
    'org_node_run_refund',
    'education_space_grant',
    'education_space_revoke',
    'team_seat_purchase'
  ));

CREATE INDEX IF NOT EXISTS idx_organizations_team_owner
  ON public.organizations (((settings ->> 'owner_user_id')))
  WHERE type = 'team' AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.activate_team_seat_purchase(
  p_user_id UUID,
  p_buyer_email TEXT,
  p_buyer_name TEXT,
  p_payment_intent_id TEXT,
  p_seat_count INT,
  p_billing_cycle TEXT,
  p_amount_thb NUMERIC,
  p_base_credits INT,
  p_promo_credits INT,
  p_total_credits INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_payment RECORD;
  v_org RECORD;
  v_org_id UUID;
  v_slug TEXT;
  v_name TEXT;
  v_settings JSONB;
  v_current_seats INT;
  v_new_seats INT;
  v_now TIMESTAMPTZ := NOW();
  v_existing_found BOOLEAN := FALSE;
  v_org_found BOOLEAN := FALSE;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'activate_team_seat_purchase: user_id is required';
  END IF;
  IF p_payment_intent_id IS NULL OR length(trim(p_payment_intent_id)) = 0 THEN
    RAISE EXCEPTION 'activate_team_seat_purchase: payment_intent_id is required';
  END IF;
  IF p_seat_count IS NULL OR p_seat_count < 2 OR p_seat_count > 500 THEN
    RAISE EXCEPTION 'activate_team_seat_purchase: seat_count must be between 2 and 500';
  END IF;
  IF p_billing_cycle NOT IN ('monthly', 'annual') THEN
    RAISE EXCEPTION 'activate_team_seat_purchase: invalid billing cycle';
  END IF;
  IF p_amount_thb IS NULL OR p_amount_thb <= 0 THEN
    RAISE EXCEPTION 'activate_team_seat_purchase: amount_thb must be positive';
  END IF;
  IF p_base_credits IS NULL OR p_base_credits <= 0 OR
     p_promo_credits IS NULL OR p_promo_credits < 0 OR
     p_total_credits IS NULL OR p_total_credits <= 0 THEN
    RAISE EXCEPTION 'activate_team_seat_purchase: invalid credit amounts';
  END IF;

  SELECT id, organization_id, credits_added
    INTO v_existing_payment
    FROM public.payment_transactions
   WHERE stripe_payment_intent_id = p_payment_intent_id
     AND status = 'completed'
   LIMIT 1;
  v_existing_found := FOUND;

  IF v_existing_found THEN
    RETURN jsonb_build_object(
      'already_processed', true,
      'organization_id', v_existing_payment.organization_id,
      'credits_added', v_existing_payment.credits_added
    );
  END IF;

  SELECT o.*
    INTO v_org
    FROM public.organizations o
    JOIN public.organization_memberships om ON om.organization_id = o.id
   WHERE om.user_id = p_user_id
     AND om.role = 'org_admin'
     AND om.status = 'active'
     AND o.type = 'team'
     AND o.deleted_at IS NULL
   ORDER BY om.created_at ASC
   LIMIT 1
   FOR UPDATE OF o;
  v_org_found := FOUND;

  IF NOT v_org_found THEN
    v_name := COALESCE(NULLIF(trim(p_buyer_name), ''), split_part(COALESCE(p_buyer_email, 'Workspace Team'), '@', 1), 'Workspace Team');
    v_slug := 'team-' || left(replace(p_user_id::text, '-', ''), 12);

    WHILE EXISTS (SELECT 1 FROM public.organizations WHERE slug = v_slug) LOOP
      v_slug := 'team-' || left(replace(p_user_id::text, '-', ''), 10) || '-' || substr(md5(random()::text), 1, 4);
    END LOOP;

    INSERT INTO public.organizations (
      name,
      slug,
      display_name,
      type,
      status,
      primary_contact_email,
      settings,
      credit_pool,
      credit_pool_allocated
    ) VALUES (
      v_name,
      v_slug,
      v_name,
      'team',
      'active',
      NULLIF(lower(trim(COALESCE(p_buyer_email, ''))), ''),
      jsonb_build_object(
        'owner_user_id', p_user_id,
        'team_seats_purchased', 0,
        'team_seat_price_thb', 1600,
        'team_seat_platform_fee_thb', 300,
        'team_seat_base_credits_per_month', 65000,
        'team_seat_promo_credits_per_month', 25000,
        'team_credits_per_seat_month', 90000,
        'billing_source', 'workspace_checkout'
      ),
      0,
      0
    )
    RETURNING * INTO v_org;

    INSERT INTO public.organization_memberships (
      organization_id,
      user_id,
      role,
      status,
      invited_by,
      joined_at,
      approved_at,
      approved_by,
      source
    ) VALUES (
      v_org.id,
      p_user_id,
      'org_admin',
      'active',
      p_user_id,
      v_now,
      v_now,
      p_user_id,
      'admin_console'
    )
    ON CONFLICT (organization_id, user_id) DO UPDATE
      SET role = 'org_admin',
          status = 'active',
          approved_at = v_now,
          approved_by = p_user_id,
          updated_at = v_now;

    INSERT INTO public.classes (
      organization_id,
      name,
      code,
      description,
      status,
      primary_instructor_id,
      credit_policy,
      credit_amount,
      settings
    ) VALUES (
      v_org.id,
      'Company pool',
      'POOL',
      'Default team pool created from Workspace team checkout.',
      'active',
      p_user_id,
      'manual',
      0,
      jsonb_build_object('kind', 'team_default_pool')
    )
    ON CONFLICT (organization_id, code) DO NOTHING;
  END IF;

  v_org_id := v_org.id;
  v_settings := COALESCE(v_org.settings, '{}'::jsonb);
  v_current_seats := COALESCE(NULLIF(v_settings ->> 'team_seats_purchased', '')::INT, 0);
  v_new_seats := v_current_seats + p_seat_count;

  UPDATE public.organizations
     SET credit_pool = credit_pool + p_total_credits,
         settings = v_settings
           || jsonb_build_object(
                'team_seats_purchased', v_new_seats,
                'team_seat_price_thb', 1600,
                'team_seat_platform_fee_thb', 300,
                'team_seat_base_credits_per_month', 65000,
                'team_seat_promo_credits_per_month', 25000,
                'team_credits_per_seat_month', 90000,
                'team_last_purchase_at', v_now,
                'team_last_payment_intent_id', p_payment_intent_id,
                'billing_source', 'workspace_checkout'
              ),
         updated_at = v_now
   WHERE id = v_org_id;

  INSERT INTO public.pool_transactions (
    organization_id,
    triggered_by,
    amount,
    reason,
    description,
    metadata
  ) VALUES (
    v_org_id,
    p_user_id,
    p_total_credits,
    'team_seat_purchase',
    'Team seats purchased via Workspace checkout',
    jsonb_build_object(
      'payment_intent_id', p_payment_intent_id,
      'seat_count', p_seat_count,
      'seats_total', v_new_seats,
      'billing_cycle', p_billing_cycle,
      'amount_thb', p_amount_thb,
      'base_credits', p_base_credits,
      'promo_credits', p_promo_credits,
      'total_credits', p_total_credits
    )
  );

  INSERT INTO public.payment_transactions (
    user_id,
    organization_id,
    payment_scope,
    package_id,
    stripe_session_id,
    stripe_payment_intent_id,
    amount_thb,
    credits_added,
    status,
    payment_method
  ) VALUES (
    p_user_id,
    v_org_id,
    'team',
    NULL,
    NULL,
    p_payment_intent_id,
    p_amount_thb,
    p_total_credits,
    'completed',
    'stripe'
  );

  UPDATE public.profiles
     SET organization_id = v_org_id,
         account_type = 'org_user',
         updated_at = v_now
   WHERE user_id = p_user_id;

  INSERT INTO public.workspace_activity (
    user_id,
    organization_id,
    activity_type,
    credits_used,
    metadata
  ) VALUES (
    p_user_id,
    v_org_id,
    'enrollment',
    0,
    jsonb_build_object(
      'source', 'team_seat_checkout',
      'payment_intent_id', p_payment_intent_id,
      'seat_count', p_seat_count
    )
  );

  RETURN jsonb_build_object(
    'already_processed', false,
    'organization_id', v_org_id,
    'seats_added', p_seat_count,
    'seats_total', v_new_seats,
    'credits_added', p_total_credits
  );
END;
$$;

REVOKE ALL ON FUNCTION public.activate_team_seat_purchase(
  UUID, TEXT, TEXT, TEXT, INT, TEXT, NUMERIC, INT, INT, INT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.activate_team_seat_purchase(
  UUID, TEXT, TEXT, TEXT, INT, TEXT, NUMERIC, INT, INT, INT
) TO service_role;

COMMENT ON FUNCTION public.activate_team_seat_purchase(
  UUID, TEXT, TEXT, TEXT, INT, TEXT, NUMERIC, INT, INT, INT
) IS
  'Idempotently creates/extends a Workspace-native team account after a paid team-seat PaymentIntent.';

COMMIT;
