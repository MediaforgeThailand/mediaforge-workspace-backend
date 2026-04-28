-- Server-side canvas persistence — Figma-style autosave for the
-- workspace V2 canvas. Replaces (or rather: backs) the unreliable
-- localStorage-only persist that occasionally lost user nodes when
-- the quota was hit.
--
-- The frontend now writes here on every change (debounced ~500ms)
-- and again via sendBeacon on `beforeunload` to catch tab closes
-- mid-edit. Workspace meta (the dashboard list) stays in
-- localStorage — it's tiny and changes rarely; the bulk-data
-- problem was only ever the canvas graphs.
--
-- RLS: a user can only read / write canvases they own.

create table if not exists public.workspace_canvases (
  id            uuid        primary key,
  user_id       uuid        not null references auth.users(id) on delete cascade,
  workspace_id  text        not null,
  name          text        not null default 'Untitled canvas',
  -- React Flow node + edge arrays straight off the store.
  nodes         jsonb       not null default '[]'::jsonb,
  edges         jsonb       not null default '[]'::jsonb,
  -- Optional viewport snapshot (pan / zoom). Restored on reopen so
  -- the user lands where they left off, not at fitView.
  viewport      jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Fast "list canvases for this workspace, newest first" — drives
-- the tab bar and the dashboard's "open most-recent" path.
create index if not exists workspace_canvases_user_workspace_idx
  on public.workspace_canvases (user_id, workspace_id, updated_at desc);

create index if not exists workspace_canvases_user_updated_idx
  on public.workspace_canvases (user_id, updated_at desc);

-- Keep updated_at fresh on every UPDATE without the client having
-- to send it. Idempotent insert + updates are upserts in practice.
create or replace function public.workspace_canvases_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists workspace_canvases_touch_trg on public.workspace_canvases;
create trigger workspace_canvases_touch_trg
  before update on public.workspace_canvases
  for each row execute function public.workspace_canvases_touch();

-- ── RLS — each user owns their canvases ──────────────────────
alter table public.workspace_canvases enable row level security;

drop policy if exists "workspace_canvases own select" on public.workspace_canvases;
create policy "workspace_canvases own select"
  on public.workspace_canvases for select
  using (auth.uid() = user_id);

drop policy if exists "workspace_canvases own insert" on public.workspace_canvases;
create policy "workspace_canvases own insert"
  on public.workspace_canvases for insert
  with check (auth.uid() = user_id);

drop policy if exists "workspace_canvases own update" on public.workspace_canvases;
create policy "workspace_canvases own update"
  on public.workspace_canvases for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "workspace_canvases own delete" on public.workspace_canvases;
create policy "workspace_canvases own delete"
  on public.workspace_canvases for delete
  using (auth.uid() = user_id);
