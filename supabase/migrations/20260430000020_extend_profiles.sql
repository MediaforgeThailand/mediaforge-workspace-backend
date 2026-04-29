-- Extend public.profiles with org-aware columns + future consumer link.
--
-- Why these three columns:
--   account_type
--     Discriminator the frontend uses to decide what UI to render and
--     which routes to gate. 'consumer' keeps current behaviour; 'org_user'
--     unlocks the workspace-only path + blocks billing/refer/etc.
--
--   organization_id
--     Direct FK to public.organizations so we can join from a profile to
--     its org in one hop without going through organization_memberships
--     for the common "what org does this user belong to" query. The
--     authoritative N:1 relationship still lives in organization_memberships
--     (a user could in principle belong to multiple orgs in the future),
--     but right now this denormalised pointer is what the post-auth
--     trigger sets and what RLS policies key off.
--
--   external_user_id
--     Reserved for Phase 2 (consumer crossover). When a consumer who
--     already has an account on the prod-DB project (`yonnvlhgwdxkuirhdfaz`)
--     signs into workspace, we'll match them by email and stamp their
--     prod auth.users.id here, letting workspace surface their prod credit
--     / plan / history without a schema migration at the time of switch.
--     NULL today; the sync job that fills this is future work.
--
-- FKs are added later: `organization_id` after public.organizations exists
-- (next migration). `external_user_id` has no FK because it points at a
-- different Supabase project and Postgres can't constrain across DBs.

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'consumer'
    CHECK (account_type IN ('consumer', 'org_user')),
  ADD COLUMN IF NOT EXISTS organization_id UUID,
  ADD COLUMN IF NOT EXISTS external_user_id UUID;

-- Indexes are partial: skip rows where the column is NULL (most consumers,
-- pre-Phase 2). Keeps the index small + fast for org-side queries.
CREATE INDEX IF NOT EXISTS idx_profiles_organization_id
  ON public.profiles(organization_id) WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_account_type_org
  ON public.profiles(account_type) WHERE account_type = 'org_user';

CREATE INDEX IF NOT EXISTS idx_profiles_external_user_id
  ON public.profiles(external_user_id) WHERE external_user_id IS NOT NULL;

COMMENT ON COLUMN public.profiles.account_type IS
  'Discriminator: ''consumer'' (default) or ''org_user''. Drives frontend feature gating.';
COMMENT ON COLUMN public.profiles.organization_id IS
  'Denormalised pointer to the user''s organization. Source of truth = organization_memberships (added in 005). Set by post-auth trigger.';
COMMENT ON COLUMN public.profiles.external_user_id IS
  'Reserved for Phase 2: link to prod project auth.users.id when a consumer crosses over. NULL today.';

COMMIT;
