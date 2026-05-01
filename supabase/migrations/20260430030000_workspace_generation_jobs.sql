-- Background generation jobs for Workspace V2 single-node runs.
--
-- The old workspace-run-node path was stateless: the browser kept the
-- request open and retried from the tab. This table gives each run a
-- durable server-side status row so the UI can enqueue, leave the
-- canvas, and later poll/recover the final output.

create table if not exists public.workspace_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id text,
  canvas_id text,
  node_id text,
  node_type text not null,
  provider text,
  model text,
  request jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed', 'permanent_failed')),
  attempts integer not null default 0,
  max_attempts integer not null default 18,
  result jsonb,
  error text,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.workspace_generation_jobs
  add column if not exists user_id uuid,
  add column if not exists workspace_id text,
  add column if not exists canvas_id text,
  add column if not exists node_id text,
  add column if not exists node_type text,
  add column if not exists provider text,
  add column if not exists model text,
  add column if not exists request jsonb not null default '{}'::jsonb,
  add column if not exists status text not null default 'queued',
  add column if not exists attempts integer not null default 0,
  add column if not exists max_attempts integer not null default 18,
  add column if not exists result jsonb,
  add column if not exists error text,
  add column if not exists last_error text,
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists workspace_generation_jobs_user_created_idx
  on public.workspace_generation_jobs (user_id, created_at desc);

create index if not exists workspace_generation_jobs_node_created_idx
  on public.workspace_generation_jobs (user_id, canvas_id, node_id, created_at desc);

create index if not exists workspace_generation_jobs_status_created_idx
  on public.workspace_generation_jobs (status, created_at desc);

create or replace function public.workspace_generation_jobs_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists workspace_generation_jobs_touch_trg on public.workspace_generation_jobs;
create trigger workspace_generation_jobs_touch_trg
  before update on public.workspace_generation_jobs
  for each row execute function public.workspace_generation_jobs_touch();

alter table public.workspace_generation_jobs enable row level security;

drop policy if exists "workspace_generation_jobs own select" on public.workspace_generation_jobs;
create policy "workspace_generation_jobs own select"
  on public.workspace_generation_jobs for select
  using (auth.uid() = user_id);

-- Writes are intentionally edge-function only. The frontend creates
-- jobs through workspace-run-node so the server can validate auth and
-- start the background worker with the original request body.

do $$
begin
  if exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) then
    alter publication supabase_realtime add table public.workspace_generation_jobs;
  end if;
exception
  when duplicate_object then null;
end $$;

comment on table public.workspace_generation_jobs is
  'Server-side background job rows for Workspace V2 node generation. Created and updated by workspace-run-node.';
