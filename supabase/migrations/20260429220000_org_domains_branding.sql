-- Org subdomain routing + branding (multi-tenant frontend chrome).
--
-- The `sso_organizations` table already carries logo_url + brand_color
-- for the SSO sign-in screen, but the workspace product also needs to:
--
--   1. Map a *web* hostname (e.g. `dmd.mediaforge.co`) → org, so the
--      frontend can swap its sidebar / login logo when the tenant
--      lands on their own subdomain. This is distinct from the
--      *email-domain* claim in `sso_organization_domains`, which
--      only routes SAML — a single org may have multiple subdomains
--      (alumni / staff / preview) and email domains do not always
--      match host names.
--
--   2. Show a short org acronym next to the logo ("DMD", "PSC", "BUU")
--      because `display_name` is too long for sidebar chrome.
--
-- Decision: keep `sso_organizations` as the org anchor (it's the only
-- org-shaped table that exists in this DB — `profiles.organization_id`
-- is referenced in legacy FE code but the column was never added here),
-- attach a sibling `org_domains` for hostname routing, and add
-- `display_name_short` directly on `sso_organizations`.

-- ───────────────────────────────────────────────────────────────
-- 1. SCHEMA — short display name
-- ───────────────────────────────────────────────────────────────

alter table public.sso_organizations
  add column if not exists display_name_short text
    check (
      display_name_short is null
      or (char_length(display_name_short) between 2 and 8)
    );

comment on column public.sso_organizations.display_name_short is
  'Short acronym shown beside logo in the sidebar/login chrome (2–8 chars, e.g. "DMD", "PSC"). NULL falls back to display_name.';


-- ───────────────────────────────────────────────────────────────
-- 2. TABLE — web-hostname → org mapping
-- ───────────────────────────────────────────────────────────────
-- One row per subdomain claimed by an org. The frontend reads this
-- at boot, matches `window.location.hostname` (case-insensitive),
-- and swaps brand. Hostname is stored lower-cased; a partial unique
-- index guarantees only ONE org can ever own a given hostname.

create table if not exists public.org_domains (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.sso_organizations(id) on delete cascade,
  -- Lower-cased web hostname (no scheme, no path). Examples:
  --   dmd.mediaforge.co
  --   alumni.dmd.mediaforge.co
  hostname      text not null,
  -- One primary subdomain per org. Used as the canonical link
  -- target in admin UIs and on outbound emails. Other subdomains
  -- are still recognised but a user landing on them gets redirected
  -- (handled FE-side, not in this migration).
  is_primary    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Hostname is the routing key — one host can only belong to one org.
  -- Unique on lower(hostname) so casing differences don't sneak through.
  constraint org_domains_hostname_lower_chk
    check (hostname = lower(hostname))
);

create unique index if not exists org_domains_hostname_unique_idx
  on public.org_domains (hostname);

create index if not exists org_domains_org_idx
  on public.org_domains (org_id);

-- Only one primary per org; partial unique index keeps the constraint
-- cheap to enforce without forcing a CASE expression.
create unique index if not exists org_domains_one_primary_per_org_idx
  on public.org_domains (org_id) where is_primary = true;

comment on table public.org_domains is
  'Web hostname → sso_organization mapping. Drives multi-tenant frontend branding (sidebar logo + login screen) when a tenant lands on their own subdomain.';


-- ───────────────────────────────────────────────────────────────
-- 3. RLS — read-public, write through service role
-- ───────────────────────────────────────────────────────────────
-- Hostname → org mapping is intentionally readable by ANYONE
-- (including unauthenticated visitors) — the frontend has to look
-- up the brand before the user even sees the login form. Writes
-- are restricted to service-role / org admins (admin UI calls a
-- service-role edge function, not the public PostgREST endpoint,
-- to add domains).

alter table public.org_domains enable row level security;

drop policy if exists "anyone can read org domains" on public.org_domains;
create policy "anyone can read org domains"
  on public.org_domains for select
  using (true);

-- No INSERT / UPDATE / DELETE policy → anon and authenticated users
-- cannot mutate. Admin UI uses service-role via an edge function.


-- ───────────────────────────────────────────────────────────────
-- 4. TOUCH trigger — keep updated_at fresh
-- ───────────────────────────────────────────────────────────────

create or replace function public.org_domains_touch()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists org_domains_touch_trg on public.org_domains;
create trigger org_domains_touch_trg
  before update on public.org_domains
  for each row execute function public.org_domains_touch();


-- ───────────────────────────────────────────────────────────────
-- 5. STORAGE — public bucket for org logos
-- ───────────────────────────────────────────────────────────────
-- Logos are referenced from the unauthenticated login screen, so
-- the bucket has to be public-read. Path convention:
--   org-branding/<org_id>/logo.<ext>
-- Writes are still gated by RLS at the storage layer (admin UI
-- uses service-role to upload — direct user uploads are rejected).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'org-branding',
  'org-branding',
  true,
  2 * 1024 * 1024, -- 2 MB cap, plenty for a logo
  array['image/png','image/jpeg','image/svg+xml','image/webp']
)
on conflict (id) do nothing;

-- Public read on the bucket's objects. (Service-role bypasses RLS,
-- so the admin UI's edge function can always upload regardless of
-- whether we add a write policy here — and we deliberately don't,
-- to keep direct-from-browser uploads out.)
drop policy if exists "anyone can read org-branding" on storage.objects;
create policy "anyone can read org-branding"
  on storage.objects for select
  using (bucket_id = 'org-branding');
