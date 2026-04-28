-- Cross-device workspace sync.
--
-- Problem this fixes:
--   The workspace v2 frontend keeps the dashboard list of workspaces
--   in localStorage only. Each device has its own list, so a user
--   logged into the same Google account on two computers sees two
--   different sets of spaces. Canvases (nodes / edges) DO sync via
--   `workspace_canvases`, but the parent workspace rows that drive
--   the dashboard don't.
--
-- Fix:
--   Mirror the workspace meta server-side. The dashboard fetches
--   from this table on mount and merges with whatever is already
--   in localStorage; subsequent create / rename / delete fire a
--   fire-and-forget upsert. RLS keeps each user scoped to their
--   own rows.
--
-- Backfill:
--   Any workspace_id that already appears in workspace_canvases but
--   has no row here gets a synthetic "Recovered workspace" so
--   existing users don't lose their server-only canvases (canvases
--   created on a device before this table existed).

create table if not exists public.workspaces (
  id          text        primary key,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  name        text        not null default 'Untitled workspace',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Newest-first list per user — drives the dashboard's default sort.
create index if not exists workspaces_user_updated_idx
  on public.workspaces (user_id, updated_at desc);

-- Touch trigger — clients don't need to send updated_at on every
-- write; trust the server clock instead so sort order is consistent.
create or replace function public.workspaces_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists workspaces_touch_trg on public.workspaces;
create trigger workspaces_touch_trg
  before update on public.workspaces
  for each row
  execute function public.workspaces_touch();

-- RLS: a user can only see / mutate their own workspaces. The
-- canvases inside use `workspace_id` (text, foreign-key-style) but
-- aren't formally constrained — this is intentional so canvases
-- created on a device before the workspace row existed don't fail
-- to write. The backfill below handles those rows.
alter table public.workspaces enable row level security;

drop policy if exists "users can read their own workspaces" on public.workspaces;
create policy "users can read their own workspaces"
  on public.workspaces for select
  using (auth.uid() = user_id);

drop policy if exists "users can insert their own workspaces" on public.workspaces;
create policy "users can insert their own workspaces"
  on public.workspaces for insert
  with check (auth.uid() = user_id);

drop policy if exists "users can update their own workspaces" on public.workspaces;
create policy "users can update their own workspaces"
  on public.workspaces for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "users can delete their own workspaces" on public.workspaces;
create policy "users can delete their own workspaces"
  on public.workspaces for delete
  using (auth.uid() = user_id);

-- Backfill — REMOVED.
--
-- Original intent: when the workspaces table was first created,
-- create a synthetic "Recovered workspace" row for every orphan
-- workspace_id found in workspace_canvases so users wouldn't lose
-- access to their old data via the dashboard list.
--
-- Why it's gone: the backfill kept resurrecting "Recovered
-- workspace" cards every time someone re-ran this migration body
-- (via `supabase db push` against a fresh project, via the MCP
-- `apply_migration` tool, via the Studio SQL editor — anything that
-- replayed the file). The user reported the cards coming back over
-- and over after deletion. We tried gating on `count(*) = 0` first
-- but that only stops the gated body from re-firing — older copies
-- of the file (pre-gate) running through other channels still
-- inserted.
--
-- Permanent fix: delete the INSERT entirely. The frontend now does
-- the orphan-pickup itself (`loadCanvasesByWorkspaceFromServer` in
-- Canvas.tsx fetches every canvas for a workspace id, regardless of
-- whether the workspace row exists). Combined with the cascade-on-
-- delete in `deleteWorkspaceFromServer` and the tombstone tracking
-- in `useWorkspaceStore.deletedWorkspaceIds`, no orphan-recovery
-- migration body is needed.
--
-- If a future case ever needs a one-shot recovery sweep, write a
-- separate fenced script and run it deliberately — never put it in
-- a migration that re-runs whenever the schema is replayed.
