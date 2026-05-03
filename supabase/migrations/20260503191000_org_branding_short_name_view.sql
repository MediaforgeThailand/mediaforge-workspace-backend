-- Surface Workspace org short branding through the public compatibility view.
-- The actual value is stored in organizations.settings so we can support it
-- without another fragile direct write path to the read-only sso_* view.

BEGIN;

CREATE OR REPLACE VIEW public.sso_organizations AS
SELECT
  o.id,
  COALESCE(o.display_name, o.name) AS display_name,
  (
    SELECT od.domain
    FROM public.organization_domains od
    WHERE od.organization_id = o.id AND od.is_primary
    LIMIT 1
  ) AS primary_domain,
  NULL::uuid AS auth_sso_provider_id,
  o.status,
  o.logo_url,
  o.brand_color,
  o.contact_notes,
  o.created_at,
  o.updated_at,
  NULLIF(COALESCE(o.settings ->> 'display_name_short', o.settings ->> 'brand_short_name'), '') AS display_name_short
FROM public.organizations o
WHERE o.deleted_at IS NULL;

COMMENT ON VIEW public.sso_organizations IS
  'Compat view for prod admin and tenant branding. Maps organizations to Schema-A sso_organizations and exposes display_name_short from settings.';

GRANT SELECT ON public.sso_organizations TO anon, authenticated, service_role;

COMMIT;
