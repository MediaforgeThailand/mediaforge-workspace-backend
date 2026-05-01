-- Workspace org shared credits.
--
-- Schema C uses organizations as the top-level account for universities,
-- enterprises, agencies, and schools. This migration makes that account a
-- real shared-credit scope for Workspace generation:
--   - login resolution still uses verified organization_domains
--   - org users spend from organizations.credit_pool atomically
--   - refunds return to the same org pool
--   - CMO Group is seeded as an enterprise org with 1,000,000 credits

BEGIN;

-- Existing org-domain docs mention manual admin verification, while an older
-- API path used admin_assert. Accept both so old pending rows and new UI rows
-- do not fight the CHECK constraint.
ALTER TABLE public.organization_domains
  DROP CONSTRAINT IF EXISTS organization_domains_verification_method_check;

ALTER TABLE public.organization_domains
  ADD CONSTRAINT organization_domains_verification_method_check
  CHECK (verification_method IN ('dns_txt', 'manual', 'admin_assert'));

-- Generation jobs need enough metadata to refund the exact shared pool after
-- background failures/timeouts.
ALTER TABLE public.workspace_generation_jobs
  ADD COLUMN IF NOT EXISTS credit_organization_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS credit_scope TEXT NOT NULL DEFAULT 'user'
    CHECK (credit_scope IN ('user', 'organization', 'team'));

CREATE INDEX IF NOT EXISTS workspace_generation_jobs_credit_org_idx
  ON public.workspace_generation_jobs (credit_organization_id, created_at DESC)
  WHERE credit_organization_id IS NOT NULL;

-- Pool ledger reasons for direct org-level Workspace runs.
ALTER TABLE public.pool_transactions
  DROP CONSTRAINT IF EXISTS pool_transactions_reason_check;

ALTER TABLE public.pool_transactions
  ADD CONSTRAINT pool_transactions_reason_check CHECK (reason IN (
    -- user_id rows
    'member_grant',
    'cycle_reset',
    'cycle_drip',
    'class_revoke',
    -- class_id rows
    'class_pool_allocation',
    'class_pool_consumed',
    'class_pool_revoked',
    -- organization_id rows
    'org_pool_topup',
    'org_pool_allocation',
    'org_pool_revoked',
    'org_node_run',
    'org_node_run_refund'
  ));

-- Resolve the org credit scope for a user. A direct profile.organization_id
-- match wins; the membership table is the fallback for older rows.
CREATE OR REPLACE FUNCTION public.workspace_org_credit_scope(p_user_id UUID)
RETURNS TABLE (
  organization_id UUID,
  organization_name TEXT,
  organization_type TEXT,
  primary_domain TEXT,
  credit_balance INT,
  credit_allocated INT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH candidate AS (
    SELECT p.organization_id, 0 AS priority
    FROM public.profiles p
    WHERE p.user_id = p_user_id
      AND p.organization_id IS NOT NULL
    UNION ALL
    SELECT om.organization_id, 1 AS priority
    FROM public.organization_memberships om
    WHERE om.user_id = p_user_id
      AND om.status = 'active'
    ORDER BY priority, organization_id
    LIMIT 1
  )
  SELECT
    o.id,
    COALESCE(o.display_name, o.name) AS organization_name,
    o.type AS organization_type,
    (
      SELECT od.domain
      FROM public.organization_domains od
      WHERE od.organization_id = o.id
        AND od.verified_at IS NOT NULL
      ORDER BY od.is_primary DESC, od.created_at ASC
      LIMIT 1
    ) AS primary_domain,
    GREATEST(o.credit_pool - o.credit_pool_allocated, 0) AS credit_balance,
    o.credit_pool_allocated AS credit_allocated
  FROM candidate c
  JOIN public.organizations o ON o.id = c.organization_id
  WHERE o.status = 'active'
    AND o.deleted_at IS NULL
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.workspace_org_credit_scope(UUID)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.consume_workspace_org_credits(
  p_user_id UUID,
  p_organization_id UUID,
  p_amount INT,
  p_feature TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_reference_id TEXT DEFAULT NULL,
  p_workspace_id TEXT DEFAULT NULL,
  p_canvas_id TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_available INT;
  v_status TEXT;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'consume_workspace_org_credits: amount must be positive';
  END IF;

  -- The caller must be an active member of the org being charged. The Edge
  -- Function uses service-role, but this keeps the RPC safe if reused later.
  IF NOT EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.organization_id = p_organization_id
      AND om.user_id = p_user_id
      AND om.status = 'active'
  ) AND NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.user_id = p_user_id
      AND p.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'consume_workspace_org_credits: user is not in organization';
  END IF;

  SELECT status, GREATEST(credit_pool - credit_pool_allocated, 0)
    INTO v_status, v_available
    FROM public.organizations
   WHERE id = p_organization_id
     AND deleted_at IS NULL
   FOR UPDATE;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'consume_workspace_org_credits: organization % not found', p_organization_id;
  END IF;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'consume_workspace_org_credits: organization is not active';
  END IF;
  IF v_available < p_amount THEN
    RETURN FALSE;
  END IF;

  UPDATE public.organizations
     SET credit_pool = credit_pool - p_amount,
         updated_at = NOW()
   WHERE id = p_organization_id;

  INSERT INTO public.pool_transactions (
    organization_id, triggered_by, workspace_id, canvas_id,
    amount, reason, description, metadata
  ) VALUES (
    p_organization_id, p_user_id, p_workspace_id, p_canvas_id,
    -p_amount, 'org_node_run', COALESCE(p_description, p_feature),
    jsonb_build_object('reference_id', p_reference_id, 'feature', p_feature)
  );

  INSERT INTO public.workspace_activity (
    user_id, organization_id, activity_type, model_id, credits_used, metadata
  ) VALUES (
    p_user_id, p_organization_id, 'model_use', p_feature, p_amount,
    jsonb_build_object('reference_id', p_reference_id, 'workspace_id', p_workspace_id, 'canvas_id', p_canvas_id)
  );

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_workspace_org_credits(
  UUID, UUID, INT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_workspace_org_credits(
  UUID, UUID, INT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.refund_workspace_org_credits(
  p_user_id UUID,
  p_organization_id UUID,
  p_amount INT,
  p_reason TEXT DEFAULT NULL,
  p_reference_id TEXT DEFAULT NULL,
  p_workspace_id TEXT DEFAULT NULL,
  p_canvas_id TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN;
  END IF;

  UPDATE public.organizations
     SET credit_pool = credit_pool + p_amount,
         updated_at = NOW()
   WHERE id = p_organization_id
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund_workspace_org_credits: organization % not found', p_organization_id;
  END IF;

  INSERT INTO public.pool_transactions (
    organization_id, triggered_by, workspace_id, canvas_id,
    amount, reason, description, metadata
  ) VALUES (
    p_organization_id, p_user_id, p_workspace_id, p_canvas_id,
    p_amount, 'org_node_run_refund', COALESCE(p_reason, 'workspace refund'),
    jsonb_build_object('reference_id', p_reference_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.refund_workspace_org_credits(
  UUID, UUID, INT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_workspace_org_credits(
  UUID, UUID, INT, TEXT, TEXT, TEXT, TEXT
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_adjust_org_credit_pool(
  p_org_id UUID,
  p_delta INT,
  p_actor_id UUID DEFAULT NULL,
  p_description TEXT DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pool INT;
  v_allocated INT;
  v_new_pool INT;
BEGIN
  IF p_delta IS NULL OR p_delta = 0 THEN
    RAISE EXCEPTION 'admin_adjust_org_credit_pool: delta must be non-zero';
  END IF;

  SELECT credit_pool, credit_pool_allocated
    INTO v_pool, v_allocated
    FROM public.organizations
   WHERE id = p_org_id
     AND deleted_at IS NULL
   FOR UPDATE;

  IF v_pool IS NULL THEN
    RAISE EXCEPTION 'admin_adjust_org_credit_pool: organization % not found', p_org_id;
  END IF;

  v_new_pool := v_pool + p_delta;
  IF v_new_pool < v_allocated THEN
    RETURN -1;
  END IF;
  IF v_new_pool < 0 THEN
    RETURN -1;
  END IF;

  UPDATE public.organizations
     SET credit_pool = v_new_pool,
         updated_at = NOW()
   WHERE id = p_org_id;

  INSERT INTO public.pool_transactions (
    organization_id, triggered_by, amount, reason, description
  ) VALUES (
    p_org_id,
    p_actor_id,
    p_delta,
    CASE WHEN p_delta > 0 THEN 'org_pool_topup' ELSE 'org_pool_revoked' END,
    p_description
  );

  RETURN v_new_pool;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_adjust_org_credit_pool(UUID, INT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adjust_org_credit_pool(UUID, INT, UUID, TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.admin_allocate_class_pool(
  p_class_id UUID,
  p_delta INT,
  p_actor_id UUID DEFAULT NULL,
  p_description TEXT DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
  v_class_pool INT;
  v_class_consumed INT;
  v_org_pool INT;
  v_org_allocated INT;
  v_new_class_pool INT;
BEGIN
  IF p_delta IS NULL OR p_delta = 0 THEN
    RAISE EXCEPTION 'admin_allocate_class_pool: delta must be non-zero';
  END IF;

  SELECT organization_id, credit_pool, credit_pool_consumed
    INTO v_org_id, v_class_pool, v_class_consumed
    FROM public.classes
   WHERE id = p_class_id
     AND deleted_at IS NULL
   FOR UPDATE;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'admin_allocate_class_pool: class % not found', p_class_id;
  END IF;

  SELECT credit_pool, credit_pool_allocated
    INTO v_org_pool, v_org_allocated
    FROM public.organizations
   WHERE id = v_org_id
   FOR UPDATE;

  IF p_delta > 0 THEN
    IF v_org_pool - v_org_allocated < p_delta THEN
      RETURN -1;
    END IF;
    UPDATE public.organizations
       SET credit_pool_allocated = credit_pool_allocated + p_delta,
           updated_at = NOW()
     WHERE id = v_org_id;
    UPDATE public.classes
       SET credit_pool = credit_pool + p_delta,
           updated_at = NOW()
     WHERE id = p_class_id
     RETURNING credit_pool INTO v_new_class_pool;
  ELSE
    IF v_class_pool - v_class_consumed < ABS(p_delta) THEN
      RETURN -2;
    END IF;
    UPDATE public.classes
       SET credit_pool = credit_pool + p_delta,
           updated_at = NOW()
     WHERE id = p_class_id
     RETURNING credit_pool INTO v_new_class_pool;
    UPDATE public.organizations
       SET credit_pool_allocated = credit_pool_allocated + p_delta,
           updated_at = NOW()
     WHERE id = v_org_id;
  END IF;

  INSERT INTO public.pool_transactions (organization_id, triggered_by, amount, reason, description)
  VALUES (
    v_org_id,
    p_actor_id,
    -p_delta,
    CASE WHEN p_delta > 0 THEN 'org_pool_allocation' ELSE 'org_pool_revoked' END,
    p_description
  );
  INSERT INTO public.pool_transactions (class_id, triggered_by, amount, reason, description)
  VALUES (
    p_class_id,
    p_actor_id,
    p_delta,
    CASE WHEN p_delta > 0 THEN 'class_pool_allocation' ELSE 'class_pool_revoked' END,
    p_description
  );

  RETURN v_new_class_pool;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_allocate_class_pool(UUID, INT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_allocate_class_pool(UUID, INT, UUID, TEXT)
  TO service_role;

-- Seed CMO Group as the first enterprise shared-credit account.
WITH org AS (
  INSERT INTO public.organizations (
    name, slug, display_name, type, status, credit_pool, primary_contact_email, settings
  ) VALUES (
    'CMO Group',
    'cmo-group',
    'CMO Group',
    'enterprise',
    'active',
    1000000,
    'admin@cmo-group.com',
    jsonb_build_object('plan', 'enterprise', 'shared_credits', true)
  )
  ON CONFLICT (slug) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        type = 'enterprise',
        status = 'active',
        credit_pool = GREATEST(public.organizations.credit_pool, 1000000),
        settings = public.organizations.settings || EXCLUDED.settings,
        updated_at = NOW()
  RETURNING id
), domain_upsert AS (
  INSERT INTO public.organization_domains (
    organization_id, domain, is_primary, verification_method, verified_at
  )
  SELECT id, 'cmo-group.com', TRUE, 'manual', NOW()
  FROM org
  ON CONFLICT (domain) DO UPDATE
    SET organization_id = EXCLUDED.organization_id,
        is_primary = TRUE,
        verification_method = 'manual',
        verified_at = COALESCE(public.organization_domains.verified_at, NOW())
  RETURNING organization_id
), provider_upsert AS (
  INSERT INTO public.organization_sso_providers (
    organization_id, provider, is_enabled, is_primary, config
  )
  SELECT id, 'email_otp', TRUE, TRUE, '{}'::jsonb
  FROM org
  ON CONFLICT (organization_id, provider) DO UPDATE
    SET is_enabled = TRUE,
        is_primary = TRUE,
        updated_at = NOW()
  RETURNING organization_id
)
INSERT INTO public.organization_memberships (organization_id, user_id, role, status)
SELECT org.id, u.id, 'member', 'active'
FROM org
JOIN auth.users u ON lower(u.email) LIKE '%@cmo-group.com'
ON CONFLICT (organization_id, user_id) DO UPDATE
  SET status = 'active',
      updated_at = NOW();

UPDATE public.profiles p
   SET organization_id = o.id,
       account_type = 'org_user',
       updated_at = NOW()
  FROM public.organizations o
  JOIN auth.users u ON lower(u.email) LIKE '%@cmo-group.com'
 WHERE o.slug = 'cmo-group'
   AND p.user_id = u.id
   AND p.organization_id IS NULL;

COMMIT;
