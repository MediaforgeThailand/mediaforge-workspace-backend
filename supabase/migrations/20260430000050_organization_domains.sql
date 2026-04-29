-- public.organization_domains — email-domain claim → org routing.
--
-- This is the ONE table anonymous (not-yet-signed-in) users can read,
-- because the auth screen needs to look up `mit.edu` → `MIT University`
-- before the user has authenticated. Read-policy is broad-open for
-- verified rows only.
--
-- A single org can claim multiple domains (faculty + student domains
-- are typically separate at Thai universities — `chula.ac.th` vs
-- `student.chula.ac.th`). The `domain` column is globally unique so a
-- domain can only ever resolve to one org.
--
-- Verification flow:
--   1. Org admin / super-admin INSERTs a row with verification_method='dns_txt'
--      and verification_token = random nonce
--   2. They publish a TXT record `_mediaforge-verify.<domain>` with the token
--   3. Cron / admin button polls DNS, on match sets verified_at = NOW()
--   4. Until verified, the auth screen treats the domain as "your org may
--      have SSO — ask IT to finish setup" (does NOT auto-route)

BEGIN;

CREATE TABLE IF NOT EXISTS public.organization_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  domain TEXT UNIQUE NOT NULL CHECK (domain = lower(domain)),
  is_primary BOOLEAN NOT NULL DEFAULT false,

  verification_method TEXT CHECK (verification_method IN ('dns_txt', 'manual')),
  verification_token TEXT,
  verified_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_domains_domain
  ON public.organization_domains(domain);
CREATE INDEX IF NOT EXISTS idx_org_domains_verified
  ON public.organization_domains(domain) WHERE verified_at IS NOT NULL;

-- ── RLS ──────────────────────────────────────────────────────────────
ALTER TABLE public.organization_domains ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_domains_super_admin_all ON public.organization_domains;
CREATE POLICY org_domains_super_admin_all ON public.organization_domains
  FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

-- Org admins manage their own org's domains. is_org_admin() comes from
-- the helpers migration (012); we forward-reference here because the
-- function won't be CALLED until something INSERTs/UPDATEs at runtime.
DROP POLICY IF EXISTS org_domains_org_admin_manage ON public.organization_domains;
CREATE POLICY org_domains_org_admin_manage ON public.organization_domains
  FOR ALL
  USING (public.is_org_admin(auth.uid(), organization_id))
  WITH CHECK (public.is_org_admin(auth.uid(), organization_id));

-- ⚠️ Anonymous SELECT — REQUIRED for the auth screen's domain-lookup.
-- Restricted to verified rows so an unverified pending org doesn't leak.
DROP POLICY IF EXISTS org_domains_public_verified_read ON public.organization_domains;
CREATE POLICY org_domains_public_verified_read ON public.organization_domains
  FOR SELECT
  USING (verified_at IS NOT NULL);

COMMENT ON TABLE public.organization_domains IS
  'Email-domain → org routing. Anon-readable for verified rows so /auth can route an email pre-login.';

COMMIT;
