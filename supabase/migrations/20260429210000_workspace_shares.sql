-- Workspace share links: viewer or editor tokens minted by a
-- workspace owner. Tokens are URL-safe hex strings stored as the
-- canonical share identity; the public share URL embeds them as a
-- ?share=<token> query param.
--
-- Applied via mcp__supabase-workspace__apply_migration on
-- 2026-04-29; this file is committed for future fresh-environment
-- restores via `supabase db push`.

create table if not exists public.workspace_shares (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references public.workspaces(id) on delete cascade,
  -- Always the owner who minted the share. Used for audit + UI
  -- labelling. Foreign key intentionally cascade-delete: if the
  -- owner account is purged, the share link evaporates with it.
  created_by uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('viewer','editor')),
  -- The token that goes into the URL fragment / query. Hex 32 is
  -- plenty (~256 bits of entropy) and stays URL-safe.
  token text not null unique,
  -- Optional expiry. NULL = never. Default 30 days for safety.
  expires_at timestamptz default (now() + interval '30 days'),
  -- Manual revoke flag — set true on revoke; the row stays for
  -- audit instead of being deleted.
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists workspace_shares_workspace_idx
  on public.workspace_shares (workspace_id);
create index if not exists workspace_shares_token_idx
  on public.workspace_shares (token) where revoked = false;

alter table public.workspace_shares enable row level security;

drop policy if exists "owners_select_workspace_shares" on public.workspace_shares;
create policy "owners_select_workspace_shares"
  on public.workspace_shares for select
  using (auth.uid() = created_by);

drop policy if exists "owners_insert_workspace_shares" on public.workspace_shares;
create policy "owners_insert_workspace_shares"
  on public.workspace_shares for insert
  with check (auth.uid() = created_by);

drop policy if exists "owners_update_workspace_shares" on public.workspace_shares;
create policy "owners_update_workspace_shares"
  on public.workspace_shares for update
  using (auth.uid() = created_by);

-- A SIGNED-IN viewer/editor can read just their relevant share row
-- (no enumeration). Token check happens in the resolve edge function
-- via service-role; clients never query this table by token directly.

-- Audit table for share visits — every successful resolve writes a
-- row so the owner can see who's accessed their workspace. Primary
-- key (share_id, user_id, visited_at) lets the same user re-enter
-- without overwriting prior visits.
create table if not exists public.workspace_share_visits (
  share_id uuid not null references public.workspace_shares(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  visited_at timestamptz not null default now(),
  primary key (share_id, user_id, visited_at)
);

alter table public.workspace_share_visits enable row level security;

drop policy if exists "owners_select_share_visits" on public.workspace_share_visits;
create policy "owners_select_share_visits"
  on public.workspace_share_visits for select
  using (
    exists (
      select 1 from public.workspace_shares s
      where s.id = workspace_share_visits.share_id
        and s.created_by = auth.uid()
    )
  );

create index if not exists workspace_share_visits_share_idx
  on public.workspace_share_visits (share_id, visited_at desc);
