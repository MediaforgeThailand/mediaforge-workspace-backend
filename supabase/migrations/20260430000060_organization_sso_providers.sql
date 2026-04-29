-- public.organization_sso_providers — per-org SSO config.
--
-- Provider modes (Q4: SAML deferred):
--   google_workspace
--     Google's "hosted domain" OAuth. config = { hd_hint: 'silpakorn.ac.th' }
--     The hint pre-selects the workspace at the Google consent page so
--     a user with multiple Google accounts auto-picks their school's.
--
--   microsoft_entra
--     Azure AD / Entra ID OAuth (OIDC). config = { tenant_id: '<uuid>' }
--     For multi-tenant orgs (rare in edu), use 'common' instead of a UUID.
--
--   email_otp
--     Magic-link / one-time-code fallback for orgs that don't have either
--     Google Workspace or Entra. config = {} (no per-org settings).
--
--   saml
--     RESERVED — not implemented. When the first SAML-only customer signs,
--     extend this table or use Supabase native auth.sso_providers and
--     point at it from config.
--
-- One row per (org, provider) — UNIQUE constraint prevents duplicates.
-- An org can enable multiple providers simultaneously (e.g. Google
-- Workspace as primary + email_otp as fallback).
--
-- Anon-readable for enabled rows so the resolve-login edge fn can return
-- "your org supports these providers" without auth.

BEGIN;

CREATE TABLE IF NOT EXISTS public.organization_sso_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  provider TEXT NOT NULL
    CHECK (provider IN ('google_workspace', 'microsoft_entra', 'email_otp', 'saml')),
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  is_primary BOOLEAN NOT NULL DEFAULT false,

  -- Provider-specific config (no secrets — those live in Supabase Auth dashboard)
  config JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (organization_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_org_sso_org
  ON public.organization_sso_providers(organization_id);

-- ── Touch trigger ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.org_sso_providers_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS org_sso_providers_touch_trg ON public.organization_sso_providers;
CREATE TRIGGER org_sso_providers_touch_trg
  BEFORE UPDATE ON public.organization_sso_providers
  FOR EACH ROW EXECUTE FUNCTION public.org_sso_providers_touch();

-- ── RLS ──────────────────────────────────────────────────────────────
ALTER TABLE public.organization_sso_providers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_sso_super_admin_all ON public.organization_sso_providers;
CREATE POLICY org_sso_super_admin_all ON public.organization_sso_providers
  FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS org_sso_org_admin_manage ON public.organization_sso_providers;
CREATE POLICY org_sso_org_admin_manage ON public.organization_sso_providers
  FOR ALL
  USING (public.is_org_admin(auth.uid(), organization_id))
  WITH CHECK (public.is_org_admin(auth.uid(), organization_id));

-- ⚠️ Anon-readable for enabled rows — needed by resolve-login edge fn.
DROP POLICY IF EXISTS org_sso_public_read_enabled ON public.organization_sso_providers;
CREATE POLICY org_sso_public_read_enabled ON public.organization_sso_providers
  FOR SELECT
  USING (is_enabled = true);

COMMENT ON TABLE public.organization_sso_providers IS
  'Per-org SSO config. OAuth/OTP for now; SAML reserved (deferred).';

COMMIT;
