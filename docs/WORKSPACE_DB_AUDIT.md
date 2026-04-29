# Workspace DB Schema Audit & Redesign Proposal

**Project:** `fymncypboeubdikpbmqc` (workspace dev)
**Date:** 2026-04-29
**Author:** AI architecture review
**Status:** 📝 Audit + proposal — awaiting CEO approval before any apply

---

## 0. Executive Summary

The workspace dev project currently has **two competing schemas** trying to solve the same org-management problem:

1. **Schema A** (`sso_orgs_and_teams.sql`) — already applied to dev DB
2. **Schema B** (`migrations-mf-um-v3/`) — written, not applied

Both have valuable design choices and gaps. **Recommendation: design a unified Schema C that supersedes both**, before applying anything else. The current dev DB has Schema A applied; we'll need a clean migration path (drop + recreate, or rename + adapt).

The schema must support **two user populations**:

- **Org users** (priority 1): SSO-authenticated, tied to an org, credits come from org/group pool
- **Consumer users** (later): personal email, identity may live in prod (`yonnvlhgwdxkuirhdfaz`), workspace usage links back via cross-project identifier

---

## 1. Current state — what's in the dev DB right now

### Schema A: applied (`migrations/20260429120000_sso_orgs_and_teams.sql`)

```
public.sso_organizations          (display_name, primary_domain, auth_sso_provider_id, status, branding…)
public.sso_organization_domains   (org_id, domain, verified_at)
public.teams                      (name, slug, owner_user_id, organization_id?, plan_id, credit_balance, stripe_customer_id)
public.team_members               (team_id, user_id, role: owner/admin/editor/viewer, monthly_credit_cap)
public.team_credit_transactions   (ledger)
public.workspaces                 ↳ added column `team_id`
public.workspace_canvases         ↳ added column `team_id`
RPCs: consume_credits_for, refund_credits_for, workspace_team_id
```

**Strengths:**
- Clean naming (`sso_*`, `teams`, no project-specific prefix)
- Forward-compatible (existing personal users untouched)
- Uses Supabase's native `auth.sso_providers` for SAML — leverages Supabase Auth's built-in tooling
- Rich team roles (owner/admin/editor/viewer) — better than 2-role model
- Per-member `monthly_credit_cap` — prevents one student burning the whole budget
- Credit ledger model (`team_credit_transactions`) — auditable

**Gaps:**
- **No "class" concept** — fine for B2B agency, but for universities, an org needs sub-groupings (faculty/department/class) where credit budgets flow down independently
- **No SSO mode for OAuth providers** — Supabase native `auth.sso_providers` is SAML-only. Google Workspace and Microsoft Entra are typically OAuth/OIDC, not SAML. Missing config for them.
- **No email-domain auto-routing on signup** — a user signs up with `@chula.ac.th` but doesn't land in the right team unless manually added
- **No `account_type` discriminator on profiles** — frontend has no easy way to gate routes for org users
- **`teams.organization_id` is optional** — design lets a team exist without an org, which conflicts with edu use case where every team must belong to a school

### Schema B: written, NOT applied (`migrations-mf-um-v3/`)

```
public.mf_um_organizations            (name, slug, type, contract_*, settings, credit_pool*)
public.mf_um_organization_domains     (org_id, domain, is_verified, is_primary, verification_method)
public.mf_um_organization_sso_providers (provider: google_workspace/microsoft_entra/email_otp, config jsonb)
public.mf_um_org_memberships          (role: org_admin/member, credits_balance, lifetime_*)
public.mf_um_classes                  (org_id, code, term, year, primary_instructor_id, credit_policy, credit_pool*)
public.mf_um_class_teachers           (class_id, user_id, role: primary/co)
public.mf_um_class_memberships        (with credit policy + cycle dates)
public.mf_um_class_enrollment_codes
public.mf_um_class_enrollment_requests
public.mf_um_activity_logs            (login/model_use/credits_*/enrollment)
public.profiles                       ↳ added `org_id`, `account_type`
auth.users                            ↳ added trigger `zz_mf_um_v3_post_auth_org_assign`
```

**Strengths:**
- Hierarchical: org → class → student (matches uni/school reality exactly)
- Explicit OAuth provider config (`google_workspace` with `hd_hint`, `microsoft_entra` with `tenant_id`)
- Auto-onboarding via post-auth trigger (signup with verified domain → auto-org-member)
- Activity log for teacher analytics ("how much did each student use?")
- 3-level credit pool: `org.credit_pool` → `class.credit_pool` → `member.credits_balance`
- Credit cycle policies (manual / monthly_reset / weekly_drip) — matches edu term structure
- Role-aware: org_admin, primary instructor, co-teacher, member

**Gaps:**
- Verbose `mf_um_v3_*` prefix on every name — design noise that ages badly
- No explicit support for non-edu B2B (agency teams without classes)
- Doesn't use Supabase's native `auth.sso_providers` at all — reinvents SSO config in custom table. SAML wouldn't fit here.
- `account_type` is binary — no room for future "team_user" or "agency_user" without enum migration
- No workspace ownership extension — workspaces stay strictly per-user, breaking the "team-shared workspace" use case Schema A solved
- 17 migrations is a lot for what Schema A does in 1

---

## 2. Where they collide / overlap

| Concept | Schema A | Schema B | Verdict |
|---|---|---|---|
| Org table | `sso_organizations` | `mf_um_organizations` | **Pick one.** Schema B has more fields (contract metadata, settings) but worse name. |
| Domain mapping | `sso_organization_domains` | `mf_um_organization_domains` | **Schema B is richer** (verification_method, is_primary). |
| SSO config | Native `auth.sso_providers` (SAML) | Custom `mf_um_organization_sso_providers` (OAuth) | **Both needed.** SAML for true SSO, OAuth metadata for Google Workspace/Entra hd_hint/tenant_id. |
| Org → user link | `team_members` (via team) | `mf_um_org_memberships` (direct) | **Schema B is correct** — direct membership, classes/teams are sub-grouping, not the membership root. |
| Sub-grouping | `teams` (flat, with credit pool) | `mf_um_classes` (with credit policy, term, instructor) | **Merge.** Generalize "class" + "team" into one `groups` table with `type` discriminator. |
| Credit accounting | `teams.credit_balance` + `team_credit_transactions` | 3-level pool + per-member balance + activity_logs | **Hybrid.** Use 3-level pool model + ledger transactions (not just balance scalar). |
| Workspace ownership | `workspaces.team_id` | (none) | **Keep Schema A's design.** Workspaces can be team-owned. |
| User identity | Personal users, no profile flag | `profiles.account_type` | **Schema B is correct** — frontend gating needs the flag. |
| Auto-onboarding | Manual | Post-auth trigger | **Schema B is correct** — saves human work. |

---

## 3. Architectural questions (need decisions)

Before I draft Schema C, please confirm:

### Q1. Org sub-grouping: classes only? Or generic groups?
- **Option A:** Use `classes` exclusively. Edu-shaped only. Non-edu agencies feel awkward.
- **Option B:** Use `groups` with `type IN ('class', 'team', 'department', 'project')`. One table, polymorphic.

→ **Recommendation: B**, because:
- It's strictly more general — `class` is a `group` whose type happens to be 'class'
- One RLS, one credit pool model, one ledger
- Future-proof: agency wants `project` groups, no schema change

### Q2. Workspace ownership model
- **Option A:** Workspaces are always per-user (`owner_user_id`); group affiliation tracked separately via `workspace_groups` join table.
- **Option B:** Workspaces have `owner_user_id` AND optional `group_id`. If `group_id` is set, credits come from group pool; otherwise from owner's personal balance. (Schema A's approach.)

→ **Recommendation: B** — simpler, matches what Schema A already shipped. Can always add a join table later if multi-group sharing emerges.

### Q3. Credit model
- **Option A:** Single per-user balance + transactions (consumer style).
- **Option B:** 3-level (org pool → group pool → user balance) + transactions, where personal users skip the org/group hops.
- **Option C:** Group balance only (no per-user); group is the wallet.

→ **Recommendation: B** with this twist: `user_credits.balance` becomes the ONE source of truth for what a user can currently spend; org/group pools track *allocation*, not *spending*. When a user runs a node:
  - Personal user → debit `user_credits` directly (existing prod-style flow)
  - Org user → debit `user_credits` (the user's class-allocated balance), refill happens via grant from class pool

This means `consume_credits` doesn't need to know about orgs. Refills are the org-specific path.

### Q4. SSO integration
- **Option A:** Use Supabase native `auth.sso_providers` (SAML) only. Forces every org onto SAML.
- **Option B:** Use native SAML for SAML-shop orgs; have a parallel `organization_oauth_providers` table for Google Workspace / Microsoft Entra (which are OAuth/OIDC, not SAML).
- **Option C:** Skip SAML entirely, use only OAuth/OIDC + email_otp. Universities in Thailand mostly use Google Workspace anyway.

→ **Recommendation: B**. Defer real SAML implementation to when the first SAML-only customer signs (some enterprise IT depts insist on SAML); use OAuth + email_otp for current edu pilots which is the bulk of the market.

### Q5. Consumer users in workspace
- **Option A:** Workspace DB is fully independent — consumer signs up fresh, gets a new identity, no link to prod.
- **Option B:** Workspace DB profiles get optional `external_user_id` field linking to prod's `auth.users.id`. When a consumer signs into workspace using same Google email as prod, we resolve their prod identity and copy/link relevant data.
- **Option C:** Cross-project federation (workspace's auth defers to prod).

→ **Recommendation: A for now, B as future option**. For Phase 1 (org users only), make workspace DB self-contained. Add a NULLABLE `profiles.external_user_id` field now so we can wire option B without a migration when we get there. Skip C — too complex for the projected scale.

### Q6. handle_new_user — extend or replace?
- prod's `handle_new_user` inserts: profiles, user_roles, user_credits, referral_codes, cash_wallets.
- For workspace dev, we don't need: cash_wallets (no payouts), referral_codes (no referral program in workspace).
- **Option A:** Keep prod's full handle_new_user — orphan rows in cash_wallets/referrals are wasted but harmless (~5 KB/user).
- **Option B:** Slim the workspace handle_new_user to only profiles + user_roles + user_credits.

→ **Recommendation: B**. Workspace DB is its own product — no need to carry consumer-app cruft. The orphan rows confuse readers and complicate cleanup later.

---

## 4. Schema C — proposed unified design

Naming convention: **no prefix on tables** (the project itself is workspace-only, prefixes are noise). Use clear English names.

### 4.1 Identity layer

```sql
-- Existing: public.profiles (extended)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'consumer'
    CHECK (account_type IN ('consumer', 'org_user')),
  ADD COLUMN IF NOT EXISTS organization_id UUID,  -- FK added later
  ADD COLUMN IF NOT EXISTS external_user_id UUID; -- nullable; reserved for prod-DB link

CREATE INDEX idx_profiles_organization ON public.profiles(organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX idx_profiles_external ON public.profiles(external_user_id) WHERE external_user_id IS NOT NULL;
```

### 4.2 Organizations

```sql
CREATE TABLE public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  display_name TEXT,           -- branded version of `name` for sign-in screens
  type TEXT NOT NULL DEFAULT 'school'
    CHECK (type IN ('school', 'university', 'enterprise', 'agency')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'suspended', 'expired')),

  -- Branding
  logo_url TEXT,
  brand_color TEXT,

  -- Billing reference (B2B invoice; separate from consumer billing)
  stripe_customer_id TEXT,

  -- Contract metadata
  contract_start_date DATE,
  contract_end_date DATE,
  primary_contact_name TEXT,
  primary_contact_email TEXT,
  primary_contact_phone TEXT,
  contact_notes TEXT,

  -- Aggregate credit allocation
  credit_pool INTEGER NOT NULL DEFAULT 0 CHECK (credit_pool >= 0),
  credit_pool_allocated INTEGER NOT NULL DEFAULT 0
    CHECK (credit_pool_allocated >= 0 AND credit_pool_allocated <= credit_pool),

  settings JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

ALTER TABLE public.profiles
  ADD CONSTRAINT fk_profiles_organization FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id) ON DELETE SET NULL;
```

### 4.3 Domains (email → org routing)

```sql
CREATE TABLE public.organization_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  domain TEXT NOT NULL CHECK (domain = lower(domain)),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  verification_method TEXT,       -- 'dns_txt' | 'manual'
  verification_token TEXT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (domain)
);
CREATE INDEX idx_org_domains_verified ON public.organization_domains(domain) WHERE verified_at IS NOT NULL;
```

### 4.4 SSO providers (per-org, OAuth/OTP)

```sql
CREATE TABLE public.organization_sso_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  provider TEXT NOT NULL
    CHECK (provider IN ('google_workspace', 'microsoft_entra', 'email_otp', 'saml')),
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  is_primary BOOLEAN NOT NULL DEFAULT false,

  -- Provider-specific config (no secrets — those live in Supabase Auth dashboard)
  --  google_workspace: { hd_hint: 'silpakorn.ac.th' }
  --  microsoft_entra:  { tenant_id: '<uuid>' }   ('common' for multi-tenant)
  --  email_otp:        {}
  --  saml:             { auth_sso_provider_id: <auth.sso_providers.id> }
  config JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, provider)
);

ALTER TABLE public.organization_sso_providers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anyone reads enabled providers"
  ON public.organization_sso_providers FOR SELECT USING (is_enabled = true);
```

### 4.5 Memberships (org-direct)

```sql
CREATE TABLE public.organization_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('org_admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended')),
  invited_by UUID REFERENCES auth.users(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  suspended_at TIMESTAMPTZ,
  suspended_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, user_id)
);
```

### 4.6 Groups (generalizes "class" + "team")

```sql
CREATE TABLE public.groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  type TEXT NOT NULL DEFAULT 'class'
    CHECK (type IN ('class', 'team', 'department', 'project')),
  name TEXT NOT NULL,
  code TEXT NOT NULL,         -- short reference (used in QR codes, URLs)
  description TEXT,

  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'scheduled', 'ended', 'archived')),

  -- Term metadata (only meaningful for type='class', NULLable otherwise)
  term TEXT,
  year INTEGER,
  start_date DATE,
  end_date DATE,
  max_members INTEGER CHECK (max_members IS NULL OR max_members > 0),

  -- Owner / primary contact
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,

  -- Credit policy
  credit_policy TEXT NOT NULL DEFAULT 'manual'
    CHECK (credit_policy IN ('manual', 'monthly_reset', 'weekly_drip')),
  credit_amount INTEGER NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  reset_day_of_month INTEGER NOT NULL DEFAULT 1 CHECK (reset_day_of_month BETWEEN 1 AND 28),
  reset_day_of_week INTEGER NOT NULL DEFAULT 1 CHECK (reset_day_of_week BETWEEN 0 AND 6),

  credit_pool INTEGER NOT NULL DEFAULT 0 CHECK (credit_pool >= 0),
  credit_pool_consumed INTEGER NOT NULL DEFAULT 0 CHECK (credit_pool_consumed >= 0),

  settings JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  UNIQUE (organization_id, code)
);
CREATE INDEX idx_groups_org_type ON public.groups(organization_id, type) WHERE deleted_at IS NULL;
```

### 4.7 Group membership (M:N, with role)

```sql
CREATE TABLE public.group_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Role inside the group:
  --   owner   = group creator / primary teacher / team owner
  --   admin   = co-teacher, can invite/remove members
  --   member  = student / regular team member
  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('owner', 'admin', 'member')),

  -- Per-member credit allocation (optional; NULL = use group default)
  credit_cap INTEGER,
  credits_balance INTEGER NOT NULL DEFAULT 0 CHECK (credits_balance >= 0),
  credits_lifetime_received INTEGER NOT NULL DEFAULT 0,
  credits_lifetime_used INTEGER NOT NULL DEFAULT 0,

  invited_by UUID REFERENCES auth.users(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'left')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, user_id)
);
```

### 4.8 Enrollment (codes + requests)

```sql
CREATE TABLE public.group_enrollment_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  code TEXT UNIQUE NOT NULL,            -- short, QR-friendly
  expires_at TIMESTAMPTZ,
  max_uses INTEGER,                      -- NULL = unlimited
  uses_count INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.group_enrollment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  via_code UUID REFERENCES public.group_enrollment_codes(id),
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 4.9 Credit transactions (unified ledger)

```sql
CREATE TABLE public.credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Polymorphic owner — exactly ONE of these is set
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  group_id UUID REFERENCES public.groups(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,

  triggered_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  workspace_id TEXT,
  canvas_id TEXT,

  -- Negative for deductions, positive for grants/refunds
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN (
    'node_run', 'node_run_refund',
    'subscription_grant', 'topup_grant',
    'cycle_reset', 'cycle_drip',
    'manual_adjustment', 'expiry',
    'org_pool_allocation', 'group_pool_allocation', 'member_grant'
  )),
  description TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraint: exactly one of user_id / group_id / organization_id is set
  CHECK (
    (user_id IS NOT NULL)::int +
    (group_id IS NOT NULL)::int +
    (organization_id IS NOT NULL)::int = 1
  )
);
CREATE INDEX idx_credit_tx_user ON public.credit_transactions(user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX idx_credit_tx_group ON public.credit_transactions(group_id, created_at DESC) WHERE group_id IS NOT NULL;
CREATE INDEX idx_credit_tx_org ON public.credit_transactions(organization_id, created_at DESC) WHERE organization_id IS NOT NULL;
```

### 4.10 Activity log (analytics)

```sql
CREATE TABLE public.workspace_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  group_id UUID REFERENCES public.groups(id) ON DELETE SET NULL,

  activity_type TEXT NOT NULL CHECK (activity_type IN (
    'login', 'model_use', 'enrollment',
    'credits_granted', 'credits_revoked',
    'workspace_created', 'workspace_deleted'
  )),
  model_id TEXT,                  -- 'kling-v2.1', 'gpt-image-1', etc.
  credits_used INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_activity_user_time ON public.workspace_activity(user_id, created_at DESC);
CREATE INDEX idx_activity_org_time ON public.workspace_activity(organization_id, created_at DESC) WHERE organization_id IS NOT NULL;
CREATE INDEX idx_activity_group_time ON public.workspace_activity(group_id, created_at DESC) WHERE group_id IS NOT NULL;
```

### 4.11 Workspace ownership extension

```sql
-- Workspaces remain per-user (owner_user_id). Optional group affiliation
-- determines which credit pool fuels the workspace's runs.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES public.groups(id) ON DELETE SET NULL;

ALTER TABLE public.workspace_canvases
  ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES public.groups(id) ON DELETE SET NULL;

CREATE INDEX idx_workspaces_group ON public.workspaces(group_id) WHERE group_id IS NOT NULL;
CREATE INDEX idx_workspace_canvases_group ON public.workspace_canvases(group_id) WHERE group_id IS NOT NULL;
```

### 4.12 Helper functions

```sql
-- Resolve org from email domain (used in resolve-login edge fn)
CREATE OR REPLACE FUNCTION public.org_from_email(p_email TEXT) RETURNS UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_domain TEXT; v_org UUID;
BEGIN
  v_domain := lower(split_part(p_email, '@', 2));
  IF v_domain = '' THEN RETURN NULL; END IF;
  SELECT organization_id INTO v_org
    FROM public.organization_domains
    WHERE domain = v_domain AND verified_at IS NOT NULL
    LIMIT 1;
  RETURN v_org;
END;
$$;

-- Is this user an org admin?
CREATE OR REPLACE FUNCTION public.is_org_admin(p_user_id UUID, p_org_id UUID) RETURNS BOOLEAN
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships
     WHERE user_id = p_user_id AND organization_id = p_org_id
       AND role = 'org_admin' AND status = 'active'
  ) OR public.has_role(p_user_id, 'admin'::public.app_role);
$$;
```

### 4.13 Post-auth trigger (auto-onboarding)

```sql
CREATE OR REPLACE FUNCTION public.post_auth_org_assign() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org UUID;
BEGIN
  IF NEW.email IS NULL THEN RETURN NEW; END IF;
  v_org := public.org_from_email(NEW.email);
  IF v_org IS NULL THEN RETURN NEW; END IF;

  UPDATE public.profiles
    SET organization_id = v_org, account_type = 'org_user', updated_at = NOW()
    WHERE user_id = NEW.id AND organization_id IS NULL;

  INSERT INTO public.organization_memberships (organization_id, user_id, role, status)
    VALUES (v_org, NEW.id, 'member', 'active')
    ON CONFLICT (organization_id, user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_post_auth_org_assign ON auth.users;
CREATE TRIGGER zz_post_auth_org_assign
  AFTER INSERT OR UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.post_auth_org_assign();
```

---

## 5. Migration path from current state

The dev DB has Schema A applied. Schema B is staged but not applied. Two viable paths:

### Path 1 — Full reset (recommended if dev DB has no real data)
1. Drop all Schema A tables + RPCs:
   ```sql
   DROP TABLE IF EXISTS public.team_credit_transactions CASCADE;
   DROP TABLE IF EXISTS public.team_members CASCADE;
   DROP TABLE IF EXISTS public.teams CASCADE;
   DROP TABLE IF EXISTS public.sso_organization_domains CASCADE;
   DROP TABLE IF EXISTS public.sso_organizations CASCADE;
   ALTER TABLE public.workspaces DROP COLUMN IF EXISTS team_id;
   ALTER TABLE public.workspace_canvases DROP COLUMN IF EXISTS team_id;
   DROP FUNCTION IF EXISTS public.consume_credits_for(uuid,uuid,integer,text,text,text,text,text);
   DROP FUNCTION IF EXISTS public.refund_credits_for(uuid,uuid,integer,text,text,text,text);
   DROP FUNCTION IF EXISTS public.workspace_team_id(text);
   ```
2. Apply Schema C as a single fresh migration set
3. Delete `migrations-mf-um-v3/` (superseded)

### Path 2 — Incremental rename (if dev DB has data we must preserve)
1. Rename Schema A tables to Schema C names + add missing columns:
   ```sql
   ALTER TABLE public.sso_organizations RENAME TO organizations;
   ALTER TABLE public.teams RENAME TO groups;
   ALTER TABLE public.team_members RENAME TO group_members;
   -- … add columns: account_type on profiles, credit_pool on orgs, etc.
   ```
2. Add Schema C tables that don't exist yet (organization_memberships, enrollment_*, activity)
3. Backfill from existing rows
4. Drop deprecated columns

→ **Decision needed: which path?** Probably Path 1 since the dev DB is meant for testing, but check first whether sales/admin already started seeding orgs.

---

## 6. What stays from Schema A (kept verbatim)

- `consume_credits_for` / `refund_credits_for` RPC pattern (rename `team_id` → `group_id`)
- `workspaces.team_id` / `workspace_canvases.team_id` (rename `team_id` → `group_id`)
- Touch-trigger pattern for `updated_at`
- Forward-compatible ethos (don't break personal users)

## 7. What gets discarded from Schema B

- `mf_um_v3_*` prefix on every name → rename clean
- `mf_um_classes` + `mf_um_class_*` series → folded into `groups` + `group_members`
- 17-migration sprawl → consolidated to 5-6 migrations
- Custom-only SSO providers → augmented with native `auth.sso_providers` for SAML

---

## 8. Open items for CEO decision

- [ ] **Q1–Q6 above** — confirm each architectural choice
- [ ] **Path 1 or Path 2** for migration — depends on whether dev DB has seeded data we want to keep
- [ ] **Stripe customer per org** — does each org get its own Stripe customer (B2B invoice billing) immediately, or is this Phase 2?
- [ ] **Per-org feature flags** in `organizations.settings` — list which workspace features can be toggled per org?
- [ ] **External user link** — confirm Phase 1 = independent identity, Phase 2 = link to prod via `external_user_id`?
- [ ] **handle_new_user trim** — confirm we slim it for workspace project (drop cash_wallet/referral inserts)?

---

## 9. Migration plan after approval

```
01_extend_profiles.sql          # account_type, organization_id, external_user_id
02_organizations.sql            # core org table + RLS + FK back to profiles
03_organization_domains.sql     # domain → org routing (anon-readable)
04_organization_sso_providers.sql # OAuth/email_otp config (anon-readable)
05_organization_memberships.sql # user ↔ org direct link
06_groups.sql                   # generalized class/team
07_group_members.sql            # M:N + per-member credits
08_group_enrollment.sql         # codes + requests
09_credit_transactions.sql      # unified ledger
10_workspace_activity.sql       # analytics log
11_extend_workspaces.sql        # workspaces.group_id, workspace_canvases.group_id
12_helpers.sql                  # org_from_email, is_org_admin
13_post_auth_trigger.sql        # zz_post_auth_org_assign
14_credit_rpcs.sql              # consume_credits_for, refund_credits_for, grant_credits
```

Total: **~14 migrations**, vs. current 17 (Schema B) + 1 (Schema A applied). Net: cleaner, smaller, with clear separation of concerns.

---

**Next step:** confirm Q1–Q6 + path choice, then I draft the actual migration SQL files.
