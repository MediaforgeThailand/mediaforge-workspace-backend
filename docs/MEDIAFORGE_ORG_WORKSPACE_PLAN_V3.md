# MediaForge — Org Workspace-Only Module
## Implementation Plan v3.0

**Version:** 3.0 (Replaces v2.0 scope)
**Date:** 2026-04-28
**Status:** 📝 Draft — awaiting CEO review
**Owner:** MediaForge CEO (MF)
**Target:** Schools / Universities — workspace-only access via SSO

---

## 0. Why v3 (vs v2)

v2 was scoped as a full **University User Management System** (classes, enrollment 4 ways, model access 3 layers, renewal cron, etc.). After re-audit, the actual requirement is much narrower:

> "ระบบสำหรับโรงเรียน/มหาวิทยาลัยที่มี domain เฉพาะ (เช่น `@silpakorn.ac.th`). Login ผ่าน SSO ของ domain นั้นๆ เท่านั้น (Google Workspace / Microsoft Entra). User ขององค์กรเข้าได้แค่ **workspace** เท่านั้น — ฟีเจอร์อื่นทั้งหมด block. ห้ามกระทบระบบหลัก"

| v2 plan | v3 (this doc) |
|---|---|
| 7 phases / 7-8 weeks | **4 phases / ~3-4 weeks** |
| 16 new tables | **4 new tables** |
| 23 staging migrations | **~7 migrations** |
| Classes + Departments + Enrollment 4 ways + Model access 3 layers | ❌ all out of scope |
| Renewal cron + class expiry | ❌ use `org.contract_end_date` (manual) |
| Activity ingest webhook | ⏸️ optional Phase 4 |

> **v2 staging migrations** in `Mediaforgetest-backend/supabase/migrations-mf-um-staging/` are **NOT used by v3**. They can stay there for reference or be deleted. v3 uses prefix `mf_um_v3_*` to keep them separate.

---

## 1. Approved Decisions

These are CEO decisions made on 2026-04-28 (audit follow-up):

```
✅ Identity model: auth.users ร่วม + flag ใน profiles
   (เพิ่ม org_id NULLABLE + account_type ใน public.profiles)

✅ Login flow: SSO ขององค์กร + email OTP fallback
   (ถ้า domain ตรงกับ org → แสดงเฉพาะ SSO buttons + OTP, ซ่อน password/Google ทั่วไป/LINE)

✅ Allowed routes for org user:
   - /app/workspace*       (the only feature)
   - /app/settings         (logout/profile only — billing/refer/etc. blocked)
   - /auth/*               (login flow)
   - Notification center   (admin can notify members)

✅ handle_new_user trigger: ห้ามแตะ
   - Orphan rows ใน user_credits/cash_wallets ของ org user — ปล่อยไว้ (no impact)

✅ Naming: prefix ใหม่ทุกตาราง = mf_um_v3_* / edge fn = mf-um-*
   (V2 staging ใช้ mf_um_* — แยกชัดเจน)
```

---

## 2. Existing System Reality (re-confirmed 2026-04-28)

### 2.1 Prod Supabase
- Project: `yonnvlhgwdxkuirhdfaz` (mediaforge), Postgres 17, ap-southeast-1
- 88 tables in public, 200 migrations, 64 users
- Identity providers in use: google (13), email (3) — **no Microsoft yet**
- `app_role` enum: `admin, user, creator, sales`
- 1 trigger on auth.users: `on_auth_user_created` → calls `handle_new_user()`

### 2.2 `handle_new_user()` — what it does (do not modify)
Inserts into 5 tables on every new user:
1. `public.profiles`
2. `public.user_roles` (role='user')
3. `public.user_credits` (balance=0)
4. `public.referral_codes` (own MF-XXXXXX code)
5. `public.cash_wallets`
6. `public.referrals` (only if `raw_user_meta_data.referral_code_used` is set)

**For org users:** these rows will be created automatically. They sit unused but cause no harm. Total cost: ~5 KB per org user.

### 2.3 Workspace tables (target feature for org users)
| Table | Owner column | RLS | Notes |
|---|---|---|---|
| `workspace_canvases` | `user_id` | `auth.uid() = user_id` | V2 canvas (TEXT workspace_id) |
| `workspace_chat_conversations` | `user_id` | `auth.uid() = user_id` ALL | Chat per canvas |
| `workspace_chat_messages` | (via conversation) | conversation owner | |
| `brand_elements` | `user_id` | `auth.uid() = user_id` | Brand assets |
| `spaces` / `space_nodes` / `space_edges` | `spaces.user_id` | owner-only | V1 workspace (still alive) |

All workspace tables are **per-user isolated** — no shared/org-wide canvas concept. Suits this requirement (each org user has their own workspace, no sharing required).

### 2.4 Frontend routing
- `WorkspaceGate` component already exists (currently allowlist-by-email, pre-GA gate)
  → **reverse the logic** for org users: `account_type='org_user'` always passes
- Routes that org users must NOT access:
  ```
  /app/home, /app/assets, /app/flow-studio*, /app/pricing,
  /app/transactions, /app/history, /app/analytics,
  /app/partner/*, /app/become-creator, /app/settings/refer,
  /redeem, /play/*, /demo, /partner-program, /creator/*
  ```

---

## 3. Database Schema (v3)

All migrations: additive, idempotent (`IF NOT EXISTS`), reversible.

### 3.1 Extend `profiles` (only schema change to existing table)

```sql
-- mf_um_v3_001_extend_profiles.sql

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS org_id UUID,
  ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'consumer'
    CHECK (account_type IN ('consumer', 'org_user'));

CREATE INDEX IF NOT EXISTS idx_profiles_org_id
  ON public.profiles(org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_account_type_org
  ON public.profiles(account_type) WHERE account_type = 'org_user';

-- FK constraint added in migration 002 after mf_um_organizations exists
```

### 3.2 Organizations

```sql
-- mf_um_v3_002_organizations.sql

CREATE TABLE IF NOT EXISTS mf_um_organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  logo_url TEXT,

  type TEXT NOT NULL DEFAULT 'school'
    CHECK (type IN ('school','university','enterprise')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','expired')),

  -- Contract metadata (NOT billing)
  contract_start_date DATE,
  contract_end_date DATE,
  primary_contact_name TEXT,
  primary_contact_email TEXT,
  primary_contact_phone TEXT,

  -- Workspace feature flags per org
  -- e.g. { "max_users": 500, "workspace_features": ["canvas","chat","brand_elements"] }
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mf_um_v3_orgs_slug
  ON mf_um_organizations(slug) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mf_um_v3_orgs_status
  ON mf_um_organizations(status) WHERE deleted_at IS NULL;

ALTER TABLE mf_um_organizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY mf_um_v3_orgs_super_admin_all ON mf_um_organizations
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY mf_um_v3_orgs_members_read ON mf_um_organizations
  FOR SELECT USING (
    id IN (SELECT org_id FROM public.profiles WHERE user_id = auth.uid())
  );

-- Now wire FK from profiles
ALTER TABLE public.profiles
  ADD CONSTRAINT fk_profiles_org_id
  FOREIGN KEY (org_id) REFERENCES mf_um_organizations(id) ON DELETE SET NULL;
```

### 3.3 Organization domains (the SSO routing key)

```sql
-- mf_um_v3_003_organization_domains.sql

CREATE TABLE IF NOT EXISTS mf_um_organization_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES mf_um_organizations(id) ON DELETE CASCADE,

  domain TEXT UNIQUE NOT NULL CHECK (domain = lower(domain)),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  is_verified BOOLEAN NOT NULL DEFAULT false,
  verification_method TEXT,
  verification_token TEXT,
  verified_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mf_um_v3_domains_domain
  ON mf_um_organization_domains(domain);
CREATE INDEX IF NOT EXISTS idx_mf_um_v3_domains_verified
  ON mf_um_organization_domains(domain) WHERE is_verified = true;

ALTER TABLE mf_um_organization_domains ENABLE ROW LEVEL SECURITY;

CREATE POLICY mf_um_v3_domains_super_admin_all ON mf_um_organization_domains
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY mf_um_v3_domains_org_admin_manage ON mf_um_organization_domains
  FOR ALL USING (mf_um_v3_is_org_admin(auth.uid(), org_id));

-- ⚠️ Public anon SELECT (verified only) — used by /auth resolve-login
CREATE POLICY mf_um_v3_domains_public_verified_read ON mf_um_organization_domains
  FOR SELECT USING (is_verified = true);
```

### 3.4 SSO providers

```sql
-- mf_um_v3_004_organization_sso_providers.sql

CREATE TABLE IF NOT EXISTS mf_um_organization_sso_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES mf_um_organizations(id) ON DELETE CASCADE,

  provider TEXT NOT NULL
    CHECK (provider IN ('google_workspace','microsoft_entra','email_otp')),
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  is_primary BOOLEAN NOT NULL DEFAULT false,

  -- Provider-specific config (no secrets — those live in Supabase Auth dashboard)
  -- google: { hd_hint: 'silpakorn.ac.th' }
  -- microsoft: { tenant_id: 'xxx' }  (or 'common' for multi-tenant)
  -- email_otp: {}
  config JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(org_id, provider)
);

ALTER TABLE mf_um_organization_sso_providers ENABLE ROW LEVEL SECURITY;

CREATE POLICY mf_um_v3_sso_super_admin_all ON mf_um_organization_sso_providers
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY mf_um_v3_sso_org_admin_manage ON mf_um_organization_sso_providers
  FOR ALL USING (mf_um_v3_is_org_admin(auth.uid(), org_id));

-- ⚠️ Public anon SELECT — required so resolve-login can return providers list
CREATE POLICY mf_um_v3_sso_public_read ON mf_um_organization_sso_providers
  FOR SELECT USING (is_enabled = true);
```

### 3.5 Org memberships

```sql
-- mf_um_v3_005_org_memberships.sql

CREATE TABLE IF NOT EXISTS mf_um_org_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES mf_um_organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('org_admin','member')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended')),

  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invited_by UUID REFERENCES auth.users(id),
  suspended_at TIMESTAMPTZ,
  suspended_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_mf_um_v3_mem_user
  ON mf_um_org_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_mf_um_v3_mem_org_role
  ON mf_um_org_memberships(org_id, role);

ALTER TABLE mf_um_org_memberships ENABLE ROW LEVEL SECURITY;

CREATE POLICY mf_um_v3_mem_super_admin_all ON mf_um_org_memberships
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY mf_um_v3_mem_user_read_own ON mf_um_org_memberships
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY mf_um_v3_mem_org_admin_manage ON mf_um_org_memberships
  FOR ALL USING (mf_um_v3_is_org_admin(auth.uid(), org_id));
```

### 3.6 Helper functions

```sql
-- mf_um_v3_006_helpers.sql

-- Resolve org from email (used by edge fn + post-auth trigger)
CREATE OR REPLACE FUNCTION mf_um_v3_org_from_email(p_email TEXT)
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.org_id
  FROM mf_um_organization_domains d
  JOIN mf_um_organizations o ON o.id = d.org_id
  WHERE d.domain = lower(split_part(p_email, '@', 2))
    AND d.is_verified = true
    AND o.status = 'active'
    AND o.deleted_at IS NULL
  LIMIT 1;
$$;

-- Permission check helper (used by RLS in 003-005)
CREATE OR REPLACE FUNCTION mf_um_v3_is_org_admin(p_user_id UUID, p_org_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_user_id AND role = 'admin'::app_role
  ) OR EXISTS(
    SELECT 1 FROM mf_um_org_memberships
    WHERE user_id = p_user_id AND org_id = p_org_id
      AND role = 'org_admin' AND status = 'active'
  );
$$;

GRANT EXECUTE ON FUNCTION mf_um_v3_org_from_email(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION mf_um_v3_is_org_admin(UUID, UUID) TO authenticated;
```

> **Note on apply order:** RLS policies in 003/004/005 reference `mf_um_v3_is_org_admin()` which is created in 006. Since plpgsql/sql resolves names lazily at first call, this is safe — but we run 006 immediately after 002 (i.e. before 003) just to be tidy. Reorder if you prefer.

### 3.7 Post-auth trigger (NEW trigger, second on auth.users — does NOT touch handle_new_user)

```sql
-- mf_um_v3_007_post_auth_trigger.sql

CREATE OR REPLACE FUNCTION mf_um_v3_post_auth_org_assign()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  matched_org UUID;
BEGIN
  IF NEW.email IS NULL THEN RETURN NEW; END IF;

  matched_org := mf_um_v3_org_from_email(NEW.email);
  IF matched_org IS NULL THEN RETURN NEW; END IF;

  -- Mark profile as org_user (only if not already assigned — preserves manual overrides)
  UPDATE public.profiles
  SET org_id = matched_org,
      account_type = 'org_user',
      updated_at = NOW()
  WHERE user_id = NEW.id AND org_id IS NULL;

  -- Create membership (idempotent)
  INSERT INTO mf_um_org_memberships (org_id, user_id, role, status)
  VALUES (matched_org, NEW.id, 'member', 'active')
  ON CONFLICT (org_id, user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- ⚠️ zz_ prefix forces this trigger to fire AFTER on_auth_user_created.
-- PostgreSQL fires same-event triggers in alphabetical order; 'o' < 'z'.
-- Verify after apply:
--   SELECT tgname FROM pg_trigger WHERE tgrelid='auth.users'::regclass
--     AND NOT tgisinternal ORDER BY tgname;
--   Expected order: on_auth_user_created → zz_mf_um_v3_post_auth_org_assign
DROP TRIGGER IF EXISTS zz_mf_um_v3_post_auth_org_assign ON auth.users;
CREATE TRIGGER zz_mf_um_v3_post_auth_org_assign
  AFTER INSERT OR UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION mf_um_v3_post_auth_org_assign();
```

---

## 4. Authentication Flow

### 4.1 Microsoft Entra App Registration (CEO action — required before Phase 2)

```
1. portal.azure.com → Microsoft Entra ID → App registrations → New registration
   - Name: "MediaForge SSO"
   - Supported account types: Multi-tenant
   - Redirect URI: Web → https://yonnvlhgwdxkuirhdfaz.supabase.co/auth/v1/callback

2. After creation, copy:
   - Application (client) ID
   - Directory (tenant) ID

3. Certificates & secrets → New client secret (24-month, copy value once)

4. API permissions → Microsoft Graph → Delegated:
   openid, email, profile, offline_access, User.Read
   → Grant admin consent

5. Supabase Dashboard for project yonnvlhgwdxkuirhdfaz:
   - Authentication → Providers → Azure → Enable
   - Paste Client ID + Client Secret
   - URL Configuration → ensure consumer redirect URLs are allowed
```

### 4.2 Edge function: `mf-um-resolve-login`

```
POST /functions/v1/mf-um-resolve-login
Body: { "email": "user@silpakorn.ac.th" }

Response when domain matches:
{
  "is_org": true,
  "org": {
    "id": "uuid",
    "name": "Silpakorn University",
    "slug": "silpakorn",
    "logo_url": "https://..."
  },
  "providers": [
    { "provider": "google_workspace", "is_primary": true,  "config": {"hd_hint": "silpakorn.ac.th"} },
    { "provider": "email_otp",        "is_primary": false, "config": {} }
  ],
  "blocked_methods": ["password", "google_consumer", "line", "phone"]
}

Response when domain does not match:
{ "is_org": false }
```

- **Public function** (`verify_jwt = false`)
- Uses anon key → relies on public SELECT policies on `mf_um_organization_domains` and `mf_um_organization_sso_providers`
- Must NOT leak existence of users in the database — only check domain table

### 4.3 Frontend Auth.tsx — 2-step flow

```
Step 1 (initial): user enters email
  → POST /mf-um-resolve-login { email }
  → response decides next step

Step 2:
  IF is_org:
    Render <OrgLoginPanel />
      - Show org logo + name
      - Render only the providers from response (Google/Microsoft/OTP)
      - Hide password form, hide consumer Google button, hide LINE button
  ELSE:
    Render existing flow (password + Google + LINE + maybe Phone OTP)
```

Cache the resolve response by email (5 min) to avoid re-hitting on small UI changes.

---

## 5. Frontend Lockdown

### 5.1 AuthContext extension

In `Mediaforgetest-frontend/src/contexts/AuthContext.tsx`:

```ts
interface Profile {
  // existing fields...
  org_id: string | null;          // NEW
  account_type: 'consumer' | 'org_user';  // NEW
}
```

`fetchProfile`: add `org_id, account_type` to `.select(...)`. Default account_type to `'consumer'` for legacy rows that pre-date the migration.

Add helpers:
```ts
export const useIsOrgUser = () => useAuth().profile?.account_type === 'org_user';
export const useOrgId = () => useAuth().profile?.org_id ?? null;
```

### 5.2 `OrgUserBlockGate` (new)

`Mediaforgetest-frontend/src/components/OrgUserBlockGate.tsx`:

```tsx
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";

const ALLOWED_FOR_ORG_USER = [
  /^\/app\/workspace(\/|$)/,
  /^\/app\/settings(\/|$)/,    // logout/profile only — billing tab will be hidden inside Settings
  /^\/auth(\/|$)/,
];

export default function OrgUserBlockGate({ children }: { children: React.ReactNode }) {
  const { profile, loading } = useAuth();
  const { pathname } = useLocation();

  if (loading) return <>{children}</>;  // let route render; ProtectedRoute handles loading
  if (profile?.account_type !== 'org_user') return <>{children}</>;

  const allowed = ALLOWED_FOR_ORG_USER.some(rx => rx.test(pathname));
  if (!allowed) return <Navigate to="/app/workspace" replace />;
  return <>{children}</>;
}
```

Wrap `<Routes>` in `App.tsx`:
```tsx
<BrowserRouter>
  <OrgUserBlockGate>
    <Routes>...</Routes>
  </OrgUserBlockGate>
</BrowserRouter>
```

### 5.3 `WorkspaceGate` — revise

`Mediaforgetest-frontend/src/components/WorkspaceGate.tsx`:

```tsx
const isOrg = profile?.account_type === 'org_user';
const isAllowlistEmail = isWorkspaceAllowedEmail(user.email);

if (!isOrg && !isAllowlistEmail) {
  return <Navigate to="/app/home" replace />;
}
```

Allowlist stays for now (so dev/QA can test). Remove allowlist when workspace is GA for consumers.

### 5.4 Sidebar — hide nav for org users

`Mediaforgetest-frontend/src/components/home/DashboardSidebar.tsx`:

For org users, render only:
- Logo
- Workspace nav item
- Settings (bottom)
- Notification center
- Avatar dropdown with **only** Settings + Logout (hide Become Creator, Refer, Redeem, Language toggle stays)

Hide:
- Home, Library nav items
- Creator Studio link
- Credits indicator + Upgrade button
- Refer link

### 5.5 Settings page — filter tabs/sections for org users

In `Mediaforgetest-frontend/src/pages/dashboard/Settings.tsx` (or whichever file):
- Org users see: Profile (display name, avatar, language), Logout
- Org users do NOT see: Billing, Subscription, Refer, Become Creator, Transactions, Stripe portal

### 5.6 Microsoft sign-in hook

`Mediaforgetest-frontend/src/hooks/useMicrosoftSignIn.ts`:

```ts
const signIn = async (redirectPath?: string) => {
  await supabase.auth.signInWithOAuth({
    provider: 'azure',
    options: {
      scopes: 'email openid profile',
      redirectTo: `${window.location.origin}/auth${redirectPath ? `?redirect=${redirectPath}` : ''}`,
    },
  });
};
```

### 5.7 Google sign-in — accept hosted domain hint

Modify `useGoogleSignIn.ts`: accept optional `hdHint` param, pass via `queryParams` to OAuth call so Google Workspace tenant is locked in.

### 5.8 Backend defense-in-depth

Create `Mediaforgetest-backend/supabase/functions/_shared/orgUserGuard.ts`:

```ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export async function rejectIfOrgUser(supabase: any, userId: string): Promise<Response | null> {
  const { data } = await supabase.from('profiles')
    .select('account_type').eq('user_id', userId).maybeSingle();
  if (data?.account_type === 'org_user') {
    return new Response(JSON.stringify({ error: 'forbidden_for_org_users' }), {
      status: 403, headers: { 'content-type': 'application/json' },
    });
  }
  return null;
}
```

Add the guard to edge functions that org users must NOT call:
- `create-checkout`, `create-topup`, `create-promptpay-intent`, `customer-portal`
- `redeem-code`, `redeem-demo`
- `submit-flow-for-review`, `submit-flow-review`
- `creator-bridge`, `erp-creator-bridge`, `erp-affiliate-bridge`
- `run-flow`, `run-flow-init`, `run-flow-status` (flow runs are not workspace)
- `quote-flow`, `freepik-stock`

Functions org users CAN use:
- `workspace-run-node` (the only execution path inside workspace)
- `auth-email-hook`, `phone-otp-send/verify` (if email_otp fallback enabled)
- `mf-um-resolve-login`, `mf-um-org-admin-api` (new, this plan)

---

## 6. Admin UI (in `Mediaforgetest-admin`)

### 6.1 Edge function: `mf-um-org-admin-api`

Single Deno function with route table:

```
GET    /orgs                            list orgs (paginated)
POST   /orgs                            create org
GET    /orgs/:id                        detail (incl. domains, members count, SSO providers)
PATCH  /orgs/:id                        update
DELETE /orgs/:id                        soft delete

POST   /orgs/:id/domains                add domain (initially unverified)
POST   /orgs/:id/domains/:dId/verify    mark verified (super admin only)
DELETE /orgs/:id/domains/:dId           remove

GET    /orgs/:id/sso                    list SSO providers
POST   /orgs/:id/sso                    add/upsert provider config
PATCH  /orgs/:id/sso/:pId               update
DELETE /orgs/:id/sso/:pId               remove

GET    /orgs/:id/members                list (paginated, search)
POST   /orgs/:id/members/invite         manual email invite (sends OTP signup link)
PATCH  /orgs/:id/members/:userId        change role / suspend
DELETE /orgs/:id/members/:userId        remove (also clears profiles.org_id)
```

Auth pattern (per existing convention):
- Verify Supabase JWT (caller user)
- Allow if `has_role(user, 'admin')` OR `mf_um_v3_is_org_admin(user, org_id)` (org-scoped routes)
- All writes log to `admin_audit_logs` (existing table) with action prefix `mf_um_v3_*`

### 6.2 Admin pages

In `Mediaforgetest-admin/src/pages/`:
- `OrganizationsListPage.tsx` — table with search, "Create org" button
- `OrganizationDetailPage.tsx` — tabs: Overview, Domains, SSO Providers, Members, Audit Log
- `OrgInviteDialog.tsx` — single/bulk email invite flow

Routing in `Mediaforgetest-admin/src/App.tsx`:
```
/orgs                         → OrganizationsListPage
/orgs/new                     → OrganizationDetailPage (create mode)
/orgs/:id                     → OrganizationDetailPage (edit mode)
```

Permissions in `Mediaforgetest-admin/src/lib/permissions.ts`:
- `app_role='admin'` → access everything
- `app_role='sales'` → read-only access to /orgs (optional, for sales overview)

---

## 7. Phase Plan

### Phase 0 — Pre-implementation (1-2 days, parallel with Phase 1)
- [ ] CEO: register Microsoft Entra app + provide Client ID/Secret
- [ ] CEO: enable Azure provider in Supabase Dashboard
- [ ] Decide target DB: Supabase branch (recommended) or separate dev project
- [ ] Create branches in 3 repos:
  - `Mediaforgetest-backend`: `feat/mf-um-v3`
  - `Mediaforgetest-frontend`: `feat/mf-um-v3-frontend`
  - `Mediaforgetest-admin`: `feat/mf-um-v3-admin`

### Phase 1 — Foundation (2-3 days)
- [ ] Migrations 001-006 (extend profiles, orgs, domains, sso, memberships, helpers)
- [ ] Apply on Supabase branch
- [ ] Smoke test:
  - existing user signup still works (handle_new_user untouched)
  - `mf_um_v3_org_from_email('test@unknown.com')` returns NULL
  - INSERT/SELECT on profiles still works for existing users
- [ ] Seed test org: "Silpakorn University Test" + domain "test.silpakorn.ac.th"

### Phase 2 — SSO + Auth flow (3-4 days)
- [ ] Migration 007 (post-auth trigger)
- [ ] Verify trigger fire order: `on_auth_user_created` → `zz_mf_um_v3_post_auth_org_assign`
- [ ] Deploy edge function `mf-um-resolve-login`
- [ ] Frontend: extend `Auth.tsx` with 2-step flow
- [ ] Frontend: `OrgLoginPanel.tsx`, `useMicrosoftSignIn.ts`, `orgLoginResolver.ts`
- [ ] Frontend: extend `useGoogleSignIn.ts` with `hd_hint`
- [ ] End-to-end test:
  - Sign up with `@test.silpakorn.ac.th` email via Google Workspace
  - Verify profile.org_id is set + membership row created
  - Verify trigger does NOT touch user where domain doesn't match

### Phase 3 — Frontend lockdown (4-5 days)
- [ ] AuthContext extension (org_id + account_type)
- [ ] `OrgUserBlockGate` component, wrap `<Routes>`
- [ ] `WorkspaceGate` reverse logic
- [ ] `DashboardSidebar` org-user branch (hide consumer nav)
- [ ] `Settings.tsx` org-user branch (hide billing/refer)
- [ ] `_shared/orgUserGuard.ts` + add to ~14 edge functions
- [ ] Smoke test:
  - Consumer user: full access to all routes (no regression)
  - Org user: visiting any non-allowed route → redirect to /app/workspace
  - Org user: edge function calls to non-workspace fns → 403

### Phase 4 — Admin UI (5-7 days)
- [ ] Edge function `mf-um-org-admin-api`
- [ ] Admin pages: List, Detail, Members, Invite Dialog
- [ ] Test: super admin creates org → adds domain → invites member → member receives OTP link → logs in via SSO → lands in /app/workspace

---

## 8. Order of Migration Apply (cheat sheet)

```bash
# 0. Make sure you are on the dev branch / dev project, NOT prod
npx supabase link --project-ref <branch-or-dev-ref>

# 1. Move v3 migration files into supabase/migrations/ with timestamps
#    (do NOT touch migrations-mf-um-staging/; that's v2 staging, separate)

# 2. Apply
npx supabase db push

# 3. Verify trigger order
psql $DATABASE_URL -c "SELECT tgname FROM pg_trigger WHERE tgrelid='auth.users'::regclass AND NOT tgisinternal ORDER BY tgname;"
# Expected:
#   on_auth_user_created
#   zz_mf_um_v3_post_auth_org_assign

# 4. Run smoke tests
psql $DATABASE_URL -f tests/v3_smoke.sql
```

---

## 9. Tables NEVER to Touch (re-confirm)

```
❌ auth.users, auth.sessions
❌ public.user_roles (schema)
❌ public.app_role (enum)
❌ public.handle_new_user (function/trigger)
❌ public.user_credits, credit_transactions, credit_costs, credit_packages,
   credit_batches, topup_packages, topup_redemptions
❌ public.subscription_plans, subscription_settings, payment_transactions
❌ public.cash_wallets, cash_wallet_transactions, cash_wallet_withdrawals
❌ public.commission_events, payout_requests, partner_*, referral_*
❌ public.flows, flow_versions, flow_nodes, flow_runs, flow_test_runs,
   flow_reviews, flow_metrics, flow_categories, flow_badges, flow_user_reviews
❌ public.spaces, space_nodes, space_edges (V1 workspace, leave alone)
❌ public.workspace_canvases, workspace_chat_*, brand_elements
   (org users use these as-is; existing RLS suffices because user_id = auth.uid())
❌ public.chat_conversations, chat_messages, user_assets, community_*
❌ public.bundles, bundle_flows, redemption_codes, demo_links, demo_budget
❌ public.api_usage_logs, pipeline_executions, processing_jobs
❌ public.email_send_log, email_send_state, suppressed_emails,
   sendgrid_events, email_suppressions, email_unsubscribe_tokens
❌ public.kyc_submissions, fraud_flags, retry_queue_*
❌ public.admin_accounts, admin_audit_logs, affiliate_audit_log
   (we'll APPEND to admin_audit_logs but not modify schema)
```

**Allowed change:** ADD COLUMN nullable to `public.profiles` only (migration 001).

---

## 10. Risks & Mitigation

| Risk | Mitigation |
|---|---|
| `handle_new_user` creates orphan rows in user_credits/cash_wallets for org users | Acceptable. ~5KB per user. Cleanup TODO if scale grows. |
| Trigger fire order regression (zz_ prefix) | Migration includes verification query in comments + manual check in Phase 2 step 2 |
| User with email `@silpakorn.ac.th` already exists pre-migration → trigger marks them as org_user unexpectedly | Trigger guard `WHERE org_id IS NULL` — pre-existing profiles are not converted |
| Admin manually overrides `account_type` on a profile | Trigger respects existing `org_id` (does not overwrite) |
| `mf-um-resolve-login` becomes a domain-enumeration oracle | Acceptable — domains are public anyway (org websites). Rate-limit at edge if abused. |
| Microsoft Entra setup delayed | Phase 1 + Google Workspace flow can ship first; Microsoft is independent |
| Org user finds bypass to consumer route via direct URL | Three layers of defense: `OrgUserBlockGate` (UI), `WorkspaceGate` (component-level), edge function guard (server) |
| Email OTP fallback bypasses SSO requirement | Edge function checks `email_otp` provider is enabled for that org's SSO before allowing OTP send |
| Existing Workspace allowlist (`mediaforge2026@gmail.com`) collides with org_user gate | Allowlist OR account_type — both pass. No collision. |

---

## 11. Success Criteria

System is successful when:

1. ✅ All 4 phases applied with smoke tests passing
2. ✅ Existing 64 consumer users see no behavior change (full regression suite)
3. ✅ Pilot org "Silpakorn Test":
   - Super admin creates org via admin panel
   - Adds verified domain `test.silpakorn.ac.th`
   - Configures Google Workspace SSO with hd_hint
   - Member with email `student@test.silpakorn.ac.th` signs up via Google
   - Lands in `/app/workspace` automatically
   - Cannot navigate to `/app/home`, `/app/pricing`, `/app/partner/*`, `/redeem`
   - Can use full workspace features (canvas, chat, brand elements)
4. ✅ Microsoft Entra SSO works end-to-end with at least one Azure tenant
5. ✅ Email OTP fallback works when org has it enabled
6. ✅ No modifications to credit / billing / flow / community / creator / admin code paths
7. ✅ No new migrations on prod until full Phase 1-3 verified on Supabase branch
8. ✅ `zz_mf_um_v3_post_auth_org_assign` trigger verified to fire AFTER `on_auth_user_created`

---

## 12. Open Items

- [ ] CEO confirm: Microsoft Entra registration who-does-it / when
- [ ] CEO confirm: target DB (Supabase branch vs separate dev project) for first apply
- [ ] CEO confirm: do org users see Notification center? (currently planned: yes — admin can push class-wide notices)
- [ ] CEO confirm: language toggle visible to org users? (planned: yes — TH/EN)
- [ ] Decide: should `/app/settings` show "Delete Account" for org users? (suggest: hide — admin manages lifecycle)
- [ ] Coordinate with workspace team: any future "shared canvas" feature would require RLS extension to org_id check

---

## Appendix A — Tables Created

```
mf_um_organizations
mf_um_organization_domains
mf_um_organization_sso_providers
mf_um_org_memberships
```

## Appendix B — Tables Extended

```
public.profiles  + org_id UUID NULL
                 + account_type TEXT DEFAULT 'consumer' CHECK in ('consumer','org_user')
```

## Appendix C — Edge Functions Created

```
mf-um-resolve-login          (public)
mf-um-org-admin-api          (admin, JWT-protected)
```

## Appendix D — Helper Functions

```
mf_um_v3_org_from_email(email TEXT) → UUID
mf_um_v3_is_org_admin(user_id UUID, org_id UUID) → BOOLEAN
mf_um_v3_post_auth_org_assign() → trigger
```

## Appendix E — Triggers Created

```
zz_mf_um_v3_post_auth_org_assign  ON auth.users  AFTER INSERT OR UPDATE OF email
  (fires AFTER on_auth_user_created due to alphabetical ordering)
```

## Appendix F — Frontend Files

**New:**
- `Mediaforgetest-frontend/src/components/OrgUserBlockGate.tsx`
- `Mediaforgetest-frontend/src/components/auth/OrgLoginPanel.tsx`
- `Mediaforgetest-frontend/src/hooks/useMicrosoftSignIn.ts`
- `Mediaforgetest-frontend/src/hooks/useIsOrgUser.ts`
- `Mediaforgetest-frontend/src/lib/orgLoginResolver.ts`

**Modified:**
- `Mediaforgetest-frontend/src/App.tsx` (wrap routes with OrgUserBlockGate)
- `Mediaforgetest-frontend/src/contexts/AuthContext.tsx` (extend Profile)
- `Mediaforgetest-frontend/src/components/WorkspaceGate.tsx` (reverse logic)
- `Mediaforgetest-frontend/src/components/home/DashboardSidebar.tsx` (org-user branch)
- `Mediaforgetest-frontend/src/pages/Auth.tsx` (2-step flow)
- `Mediaforgetest-frontend/src/pages/dashboard/Settings.tsx` (filter tabs)
- `Mediaforgetest-frontend/src/hooks/useGoogleSignIn.ts` (accept hd_hint)

## Appendix G — Admin Files

**New:**
- `Mediaforgetest-admin/src/pages/OrganizationsListPage.tsx`
- `Mediaforgetest-admin/src/pages/OrganizationDetailPage.tsx`
- `Mediaforgetest-admin/src/components/orgs/OrgInviteDialog.tsx`
- `Mediaforgetest-admin/src/components/orgs/OrgMembersTable.tsx`
- `Mediaforgetest-admin/src/components/orgs/OrgDomainsTab.tsx`
- `Mediaforgetest-admin/src/components/orgs/OrgSSOTab.tsx`
- `Mediaforgetest-admin/src/lib/orgAdminApi.ts`

**Modified:**
- `Mediaforgetest-admin/src/App.tsx` (add /orgs routes)
- `Mediaforgetest-admin/src/lib/permissions.ts` (allow sales read-only on /orgs)

---

**End of v3 plan.** Standing by for CEO review.
