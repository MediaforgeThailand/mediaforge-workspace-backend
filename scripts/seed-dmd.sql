-- Seed DMD (Digital Media Design) tenant for the subdomain demo.
--
-- Run this AFTER the 20260429220000_org_domains_branding migration
-- has been applied. Paste into the Supabase SQL editor (or run with
-- psql against the workspace DB).
--
-- Idempotent — re-running it is safe; it upserts on
-- (sso_organizations.primary_domain) and (org_domains.hostname).
--
-- After this runs:
--   • DMD has an sso_organizations row with logo placeholder + "DMD"
--     short name.
--   • dmd.mediaforge.co is mapped to that org.
--   • The admin user (admin@gmail.com) is NOT created here — make
--     them in the Supabase Auth dashboard, then optionally link them
--     by inserting a row into team_members or whichever role table
--     the FE checks. That part stays manual until we wire org-admin
--     promotion into the UI.

begin;

-- 1. The org itself. Upsert keyed on primary_domain so a re-run
--    doesn't create duplicates.
insert into public.sso_organizations
  (display_name, primary_domain, status, logo_url, brand_color, display_name_short)
values
  (
    'Digital Media Design',
    'dmd.mediaforge.co',
    'active',
    '/dmd-logo-placeholder.png', -- swap for the real Storage URL once the user uploads via /app/org-admin/branding
    '#FF3D8E',
    'DMD'
  )
on conflict (primary_domain) do update set
  display_name        = excluded.display_name,
  status              = excluded.status,
  logo_url            = excluded.logo_url,
  brand_color         = excluded.brand_color,
  display_name_short  = excluded.display_name_short;

-- 2. The hostname mapping. Upsert keyed on hostname (unique index).
insert into public.org_domains (org_id, hostname, is_primary)
select id, 'dmd.mediaforge.co', true
from public.sso_organizations
where primary_domain = 'dmd.mediaforge.co'
on conflict (hostname) do update set
  org_id     = excluded.org_id,
  is_primary = excluded.is_primary;

commit;

-- Verify
select o.id, o.display_name, o.display_name_short, d.hostname, d.is_primary
from public.sso_organizations o
join public.org_domains d on d.org_id = o.id
where o.primary_domain = 'dmd.mediaforge.co';
