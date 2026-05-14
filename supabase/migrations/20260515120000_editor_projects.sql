-- Editor projects table — stores serialized MediaForge Studio (video
-- editor) project documents per user. Each row holds a single project's
-- JSON payload plus thumbnail / metadata for the project picker UI.
--
-- Why a dedicated table (not piggybacking on workspaces):
--   - Video editor projects have a totally different shape (timeline,
--     tracks, clips, transitions) than workspace canvases.
--   - Auto-save writes happen on every clip edit (debounced 2s); keeping
--     the row narrow avoids bloating the workspace tables.
--   - Lets us drop / migrate the editor independently.
--
-- RLS: per-user only. There is no shared-editing model yet.
create table if not exists public.editor_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Untitled Project',
  data jsonb not null default '{}'::jsonb,
  thumbnail text,
  duration_sec int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_editor_projects_user
  on public.editor_projects(user_id, updated_at desc);

alter table public.editor_projects enable row level security;

-- One policy that covers select / insert / update / delete via FOR ALL.
drop policy if exists "Users manage their own editor projects"
  on public.editor_projects;
create policy "Users manage their own editor projects"
  on public.editor_projects
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Trigger: bump updated_at on every update so the dashboard's
-- "Most recent" sort works without the client having to set it.
create or replace function public.update_editor_project_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists editor_projects_updated_at on public.editor_projects;
create trigger editor_projects_updated_at
  before update on public.editor_projects
  for each row execute function public.update_editor_project_updated_at();
