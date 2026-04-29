-- Schema reset: drop Schema A (sso_orgs + teams) before Schema C lands.
--
-- Why: workspace dev project temporarily ran two competing org schemas
-- side-by-side (`sso_orgs_and_teams.sql` was applied; `migrations-mf-um-v3/`
-- was staged but never applied). After the audit in
-- `docs/WORKSPACE_DB_AUDIT.md` we picked a unified Schema C; this
-- migration cleans the slate so Schema C can land on a known-empty surface.
--
-- Idempotent: every drop is `IF EXISTS`. Running this twice is a no-op.
--
-- Order matters (children before parents):
--   1. RPCs that reference team tables
--   2. team_credit_transactions      (FK → teams)
--   3. team_members                  (FK → teams)
--   4. teams                         (FK → sso_organizations)
--   5. sso_organization_domains      (FK → sso_organizations)
--   6. sso_organizations
--   7. workspaces.team_id, workspace_canvases.team_id columns
--
-- Schema-B staging files were never applied to a DB, so there is nothing
-- to drop on that side. The files in `migrations-mf-um-v3/` and
-- `migrations-mf-um-staging/` will be deleted from the repo separately
-- once Schema C is verified.

BEGIN;

-- 1. Drop team-aware credit RPCs first (they reference teams + transactions)
DROP FUNCTION IF EXISTS public.consume_credits_for(uuid, uuid, integer, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.refund_credits_for(uuid, uuid, integer, text, text, text, text);
DROP FUNCTION IF EXISTS public.workspace_team_id(text);

-- 2. Drop team-side tables (children → parents)
DROP TABLE IF EXISTS public.team_credit_transactions CASCADE;
DROP TABLE IF EXISTS public.team_members CASCADE;
DROP TABLE IF EXISTS public.teams CASCADE;

-- 3. Drop sso-organization tables
DROP TABLE IF EXISTS public.sso_organization_domains CASCADE;
DROP TABLE IF EXISTS public.sso_organizations CASCADE;

-- 4. Drop touch-trigger functions (recreated under new names in Schema C)
DROP FUNCTION IF EXISTS public.sso_orgs_touch() CASCADE;
DROP FUNCTION IF EXISTS public.teams_touch() CASCADE;

-- 5. Remove team_id columns from workspaces / workspace_canvases
ALTER TABLE public.workspaces DROP COLUMN IF EXISTS team_id;
ALTER TABLE public.workspace_canvases DROP COLUMN IF EXISTS team_id;

COMMIT;
