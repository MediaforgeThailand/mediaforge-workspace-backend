-- SSO Organizations + Team accounts.
--
-- Workspace product moves toward B2B/edu sales — universities,
-- colleges, agency teams. This migration designs the data shape
-- ahead of any frontend wire-up so:
--
--   • sales / partnerships can already say "we support SSO + team
--     billing" with a real schema behind it
--   • admin hub can build the management UIs against stable tables
--   • when the first contract closes we can grant access without
--     a panicked schema scramble
--
-- The migration is FORWARD-COMPATIBLE — every existing user keeps
-- their personal account, personal credits, and personal workspaces
-- exactly as today. Team / SSO are additive rows, not replacements.
--
-- Out of scope for this file (separate follow-up migrations):
--   - Org-level credit ledger (uses teams.credit_balance for now)
--   - SAML attribute mappers
--   - Per-team rate limits
--   - Subscription billing for teams (Stripe customer.id link)


-- ───────────────────────────────────────────────────────────────
-- 1. SSO ORGANIZATIONS
-- ───────────────────────────────────────────────────────────────
-- One row per institutional / corporate identity provider. We
-- piggyback on Supabase's built-in `auth.sso_providers` +
-- `auth.sso_domains` for the actual SAML protocol — the table
-- below is OUR business-side mirror with display name, branding,
-- billing pointer, and the link back to Supabase's IdP entry.

create table if not exists public.sso_organizations (
  id                  uuid primary key default gen_random_uuid(),
  -- Human-facing name shown in the org dashboard ("Chulalongkorn
  -- University", "BUUiC Design Lab", etc.).
  display_name        text not null,
  -- Email-domain claim, e.g. "chula.ac.th". Multiple domains allowed
  -- (BUU has both `buu.ac.th` and `go.buu.ac.th`) via the join table
  -- below. This column stores the PRIMARY domain for display.
  primary_domain      text not null,
  -- Pointer at the Supabase Auth SAML provider row that actually
  -- holds the SAML metadata + assertion mapping. NULL while the
  -- org is being onboarded and the IdP isn't wired up yet.
  auth_sso_provider_id uuid references auth.sso_providers(id) on delete set null,
  -- Onboarding lifecycle. `pending` orgs can't be claimed; `active`
  -- can; `suspended` blocks new sign-ins (existing users still in).
  status              text not null default 'pending'
    check (status in ('pending', 'active', 'suspended')),
  -- Optional brand assets surfaced on the org's sign-in screen.
  logo_url            text,
  brand_color         text,
  -- Loose admin notes / contract reference, sales side fills in.
  contact_notes       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists sso_organizations_status_idx
  on public.sso_organizations (status);

-- A single org can claim multiple email domains (e.g. faculty +
-- student domains). Lookups by domain need to be O(1) per sign-in
-- attempt → unique index on the lower-cased domain.
create table if not exists public.sso_organization_domains (
  organization_id uuid not null references public.sso_organizations(id) on delete cascade,
  domain          text not null,
  -- `verified_at` is set after the org's tech contact uploads the
  -- DNS TXT record we challenge for. Until then we DON'T auto-route
  -- new sign-ins through the IdP — they fall back to standard
  -- email/Google auth, but with a "your org has SSO available, ask
  -- IT to finish setup" hint.
  verified_at     timestamptz,
  created_at      timestamptz not null default now(),
  primary key (organization_id, domain)
);

create unique index if not exists sso_organization_domains_lower_domain_idx
  on public.sso_organization_domains ((lower(domain)));


-- ───────────────────────────────────────────────────────────────
-- 2. TEAMS (multi-user shared workspaces + credits)
-- ───────────────────────────────────────────────────────────────
-- A team has its own credit pool, member roster, and (optionally)
-- a parent SSO org. Workspaces created inside a team belong to the
-- team — credit deductions hit the team's balance, not the
-- individual member's.
--
-- Personal / individual users continue to work as today — they
-- just don't have a team_id on their workspaces. The `member_role`
-- column on the joins below stays NULL for personal flows.

create table if not exists public.teams (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  -- Slug used in URL paths (`workspace.mediaforge.co/team/<slug>`).
  -- Uniqueness scoped globally — sales picks them at onboarding.
  slug                 text not null,
  -- Owner is the user who initially created (or was provisioned
  -- as) the team. Cannot be deleted until ownership is transferred
  -- (see RLS policy below).
  owner_user_id        uuid not null references auth.users(id) on delete restrict,
  -- Optional link to a parent SSO org. Set when the team was
  -- provisioned through a university contract — used by reporting
  -- ("how much did Chula consume this month") and for org-level
  -- single sign-out cascade.
  organization_id      uuid references public.sso_organizations(id) on delete set null,
  -- Subscription plan. References public.subscription_plans (the
  -- existing plans table from the consumer billing schema) so
  -- pricing logic stays unified between consumer and team. NULL
  -- = free tier with low credit grant.
  plan_id              uuid,
  -- Live credit balance — integer math (1 THB = 25 credits) to
  -- match the consumer ledger. Replenished on subscription renew
  -- via the existing pricing helpers.
  credit_balance       integer not null default 0,
  -- Optional Stripe customer pointer for B2B invoice billing.
  -- Different from individual users' Stripe customers (those live
  -- on profiles).
  stripe_customer_id   text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create unique index if not exists teams_slug_idx
  on public.teams ((lower(slug)));
create index if not exists teams_organization_idx
  on public.teams (organization_id) where organization_id is not null;
create index if not exists teams_owner_idx
  on public.teams (owner_user_id);


create table if not exists public.team_members (
  team_id     uuid not null references public.teams(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  -- Role gates what the member can do inside the team:
  --   owner  → full control + billing + delete team
  --   admin  → invite/remove members, manage workspaces, NO billing
  --   editor → create/edit workspaces, run nodes (default)
  --   viewer → read-only (open workspaces, can't run nodes)
  role        text not null default 'editor'
    check (role in ('owner', 'admin', 'editor', 'viewer')),
  invited_at  timestamptz not null default now(),
  joined_at   timestamptz,
  -- Per-member credit cap (optional). Useful for university plans
  -- that want to prevent a single student from burning the whole
  -- faculty budget. NULL = no individual cap, share team pool freely.
  monthly_credit_cap integer,
  primary key (team_id, user_id)
);

create index if not exists team_members_user_idx
  on public.team_members (user_id);


-- ───────────────────────────────────────────────────────────────
-- 3. ATTACH TEAMS TO WORKSPACES (additive — keeps personal flow)
-- ───────────────────────────────────────────────────────────────
-- A workspace can belong to a team or stay personal. The dispatcher
-- looks at this column when deciding which credit pool to deduct
-- from at run time.

alter table public.workspaces
  add column if not exists team_id uuid
    references public.teams(id) on delete set null;

create index if not exists workspaces_team_idx
  on public.workspaces (team_id) where team_id is not null;

-- Same column on workspace_canvases too — denormalised for fast
-- "what does team X have" queries without a join to workspaces.
-- The workspace's team_id is the source of truth; canvases inherit.
alter table public.workspace_canvases
  add column if not exists team_id uuid
    references public.teams(id) on delete set null;

create index if not exists workspace_canvases_team_idx
  on public.workspace_canvases (team_id) where team_id is not null;


-- ───────────────────────────────────────────────────────────────
-- 4. CREDIT LEDGER — TEAM SIDE
-- ───────────────────────────────────────────────────────────────
-- Mirrors the consumer credit_transactions table but scoped to
-- teams instead of users. Lets billing reports treat individual
-- and team usage uniformly.

create table if not exists public.team_credit_transactions (
  id              uuid primary key default gen_random_uuid(),
  team_id         uuid not null references public.teams(id) on delete cascade,
  -- Which member triggered the deduction (for per-user reports +
  -- the optional monthly cap enforcement on team_members).
  triggered_by    uuid references auth.users(id) on delete set null,
  workspace_id    text,
  canvas_id       text,
  -- Negative for deductions (a node ran and burned credits),
  -- positive for refunds / grants (subscription renewal).
  amount          integer not null,
  reason          text not null
    check (reason in (
      'node_run',
      'node_run_refund',
      'subscription_grant',
      'topup_grant',
      'manual_adjustment',
      'expiry'
    )),
  description     text,
  created_at      timestamptz not null default now()
);

create index if not exists team_credit_transactions_team_time_idx
  on public.team_credit_transactions (team_id, created_at desc);
create index if not exists team_credit_transactions_member_time_idx
  on public.team_credit_transactions (triggered_by, created_at desc)
  where triggered_by is not null;


-- ───────────────────────────────────────────────────────────────
-- 5. RLS — strict by default; teams visible only to members
-- ───────────────────────────────────────────────────────────────

alter table public.sso_organizations enable row level security;
alter table public.sso_organization_domains enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.team_credit_transactions enable row level security;

-- SSO orgs: every signed-in user can READ the active list (needed
-- for the "your org has SSO" hint on auth screens). Only admins
-- mutate (handled by service-role from admin-api).
drop policy if exists "anyone can read active orgs" on public.sso_organizations;
create policy "anyone can read active orgs"
  on public.sso_organizations for select
  using (status = 'active');

-- SSO domain mapping: read by anyone (used to pre-route emails).
drop policy if exists "anyone can read sso domains" on public.sso_organization_domains;
create policy "anyone can read sso domains"
  on public.sso_organization_domains for select
  using (true);

-- Teams: members can read their team's row. Mutations route through
-- service-role + admin-api; no direct user write.
drop policy if exists "members can read their team" on public.teams;
create policy "members can read their team"
  on public.teams for select
  using (
    exists (
      select 1 from public.team_members tm
      where tm.team_id = teams.id and tm.user_id = auth.uid()
    )
  );

-- Team members: members can see the roster of their own team.
drop policy if exists "members can read team roster" on public.team_members;
create policy "members can read team roster"
  on public.team_members for select
  using (
    exists (
      select 1 from public.team_members tm
      where tm.team_id = team_members.team_id and tm.user_id = auth.uid()
    )
  );

-- Credit transactions: members read their own team's history.
-- Owner/admin role check is enforced at the application layer for
-- write actions (manual_adjustment).
drop policy if exists "members read team transactions" on public.team_credit_transactions;
create policy "members read team transactions"
  on public.team_credit_transactions for select
  using (
    exists (
      select 1 from public.team_members tm
      where tm.team_id = team_credit_transactions.team_id and tm.user_id = auth.uid()
    )
  );


-- ───────────────────────────────────────────────────────────────
-- 6. UPDATED_AT touch triggers
-- ───────────────────────────────────────────────────────────────

create or replace function public.sso_orgs_touch()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists sso_orgs_touch_trg on public.sso_organizations;
create trigger sso_orgs_touch_trg
  before update on public.sso_organizations
  for each row execute function public.sso_orgs_touch();

create or replace function public.teams_touch()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists teams_touch_trg on public.teams;
create trigger teams_touch_trg
  before update on public.teams
  for each row execute function public.teams_touch();
