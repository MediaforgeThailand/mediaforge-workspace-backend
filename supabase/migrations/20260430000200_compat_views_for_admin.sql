-- Backward-compatibility views for the prod admin frontend
-- (`mediaforge-admin-hub`) which still queries the old Schema-A names
-- `public.sso_organizations` and `public.teams`.
--
-- We dropped those tables in migration 010 and replaced them with
-- Schema C: `organizations` + `classes` (with richer columns). Rather
-- than rewriting every admin page, expose READ-ONLY views with the
-- Schema-A column names mapped onto Schema C rows.
--
-- These are VIEWs (not tables), so:
--   • SELECT works — what the prod pages actually need
--   • INSERT/UPDATE/DELETE will fail — admin pages that try to mutate
--     via these names will surface clear errors instead of silently
--     writing to the wrong shape
--   • Schema C remains the single source of truth for writes
--
-- Once the admin pages are rewired to use Schema C names directly
-- (organizations / classes), drop these views.

BEGIN;

-- ─── sso_organizations view ──────────────────────────────────────────
-- prod admin's WorkspaceSsoOrgsPage selects:
--   id, display_name, primary_domain, auth_sso_provider_id,
--   status, logo_url, brand_color, contact_notes, created_at, updated_at

CREATE OR REPLACE VIEW public.sso_organizations AS
SELECT
  o.id,
  COALESCE(o.display_name, o.name) AS display_name,
  -- primary_domain comes from organization_domains where is_primary = true
  (
    SELECT od.domain
    FROM public.organization_domains od
    WHERE od.organization_id = o.id AND od.is_primary
    LIMIT 1
  ) AS primary_domain,
  -- Schema C uses organization_sso_providers + Supabase native auth.sso_providers
  -- separately. Schema-A's auth_sso_provider_id flattened the SAML link.
  -- For the demo we expose NULL (we use OAuth, not SAML).
  NULL::uuid AS auth_sso_provider_id,
  o.status,
  o.logo_url,
  o.brand_color,
  o.contact_notes,
  o.created_at,
  o.updated_at
FROM public.organizations o
WHERE o.deleted_at IS NULL;

COMMENT ON VIEW public.sso_organizations IS
  'Compat view for prod admin. Maps Schema-A sso_organizations onto Schema-C organizations. READ-ONLY.';

-- Grant select to anon + authenticated since the admin runs as authenticated.
-- RLS on the underlying organizations table still applies through views.
GRANT SELECT ON public.sso_organizations TO anon, authenticated, service_role;


-- ─── teams view ──────────────────────────────────────────────────────
-- prod admin's WorkspaceTeamsPage selects:
--   id, name, slug, owner_user_id, organization_id, plan_id,
--   credit_balance, stripe_customer_id, created_at, updated_at
--
-- Schema C's `classes` is a closer match than a "team" but the column
-- shape differs — we map and synthesize.

CREATE OR REPLACE VIEW public.teams AS
SELECT
  c.id,
  c.name,
  c.code AS slug,                 -- classes.code is the human-friendly tag
  c.primary_instructor_id AS owner_user_id,
  c.organization_id,
  NULL::uuid AS plan_id,           -- no per-class plan in Schema C yet
  -- credit_balance = remaining unconsumed pool
  GREATEST(c.credit_pool - c.credit_pool_consumed, 0) AS credit_balance,
  NULL::text AS stripe_customer_id,
  c.created_at,
  c.updated_at
FROM public.classes c
WHERE c.deleted_at IS NULL;

COMMENT ON VIEW public.teams IS
  'Compat view for prod admin. Maps Schema-A teams onto Schema-C classes. READ-ONLY.';

GRANT SELECT ON public.teams TO anon, authenticated, service_role;

COMMIT;
