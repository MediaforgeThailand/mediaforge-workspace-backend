-- public.organizations — top-level account for schools / universities /
-- enterprises. One row per institutional customer.
--
-- Workspace product is org-only (org users) + future consumer crossover.
-- This table holds the org identity, branding, contract metadata, and the
-- aggregate credit pool that classes draw from.
--
-- RLS strategy:
--   - Super-admins (public.user_roles 'admin') do everything
--   - Org members can read their own org row
--   - Org admins can update their own org row
--   - Anonymous users CANNOT read this table directly — domain → org
--     resolution happens via organization_domains (anon-readable) so the
--     auth screen can route an email without exposing org metadata.

BEGIN;

CREATE TABLE IF NOT EXISTS public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Internal name (used in admin UIs, search). e.g. "Silpakorn University"
  name TEXT NOT NULL,
  -- URL slug (used in /admin/orgs/<slug>, future workspace.mf.co/<slug>)
  slug TEXT UNIQUE NOT NULL CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
  -- Branded name shown to end users on sign-in screen
  display_name TEXT,

  type TEXT NOT NULL DEFAULT 'school'
    CHECK (type IN ('school', 'university', 'enterprise', 'agency')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'suspended', 'expired')),

  -- Branding (optional — surfaced on org-aware sign-in)
  logo_url TEXT,
  brand_color TEXT,

  -- Billing reference. Workspace orgs bill via Stripe invoice (B2B), kept
  -- separate from the consumer Stripe customers on profiles.
  stripe_customer_id TEXT,

  -- Contract metadata (for sales / renewal tracking — not the credit clock)
  contract_start_date DATE,
  contract_end_date DATE,
  primary_contact_name TEXT,
  primary_contact_email TEXT,
  primary_contact_phone TEXT,
  contact_notes TEXT,

  -- Per-org feature flags / limits, stored loose so we don't migrate every
  -- time we add a new toggle. Keys we'll respect:
  --   max_users           int   — hard cap on org_memberships.active
  --   workspace_features  text[] — subset of ['canvas','chat','brand_elements']
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Aggregate credit pool — budget allocated to the whole org by sales.
  -- Classes draw from this; per-user balances refill from class pool.
  credit_pool INTEGER NOT NULL DEFAULT 0 CHECK (credit_pool >= 0),
  credit_pool_allocated INTEGER NOT NULL DEFAULT 0
    CHECK (credit_pool_allocated >= 0 AND credit_pool_allocated <= credit_pool),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_organizations_status
  ON public.organizations(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_organizations_slug
  ON public.organizations(slug) WHERE deleted_at IS NULL;

-- Wire FK from profiles.organization_id (added in 001 without constraint
-- because the table didn't exist yet)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_profiles_organization_id') THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT fk_profiles_organization_id
      FOREIGN KEY (organization_id)
      REFERENCES public.organizations(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── Touch trigger: keep updated_at fresh ─────────────────────────────
CREATE OR REPLACE FUNCTION public.organizations_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS organizations_touch_trg ON public.organizations;
CREATE TRIGGER organizations_touch_trg
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.organizations_touch();

-- ── RLS ──────────────────────────────────────────────────────────────
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organizations_super_admin_all ON public.organizations;
CREATE POLICY organizations_super_admin_all ON public.organizations
  FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS organizations_members_read ON public.organizations;
CREATE POLICY organizations_members_read ON public.organizations
  FOR SELECT
  USING (
    id IN (
      SELECT organization_id FROM public.profiles
       WHERE user_id = auth.uid() AND organization_id IS NOT NULL
    )
  );

COMMENT ON TABLE public.organizations IS
  'Top-level org account (school / university / enterprise / agency). Owns credit_pool that classes draw from.';

COMMIT;
