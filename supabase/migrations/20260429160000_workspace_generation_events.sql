-- Workspace generation analytics — purpose-built event log.
--
-- Why this exists
-- ---------------
-- Workspace V2 (workspace-run-node edge function) is a stateless
-- sandbox: every Run is a single, fire-and-forget node call with no DB
-- write. That means we have ZERO visibility into per-model / per-tier
-- generation volume — pipeline_executions stays empty, and
-- credit_transactions only fires for the (currently disabled) credit
-- ledger path.
--
-- This table is the simplest fix: one row per successful generation,
-- written by the dispatcher right before it returns the response. The
-- admin analytics surface aggregates over it.
--
-- Failure-mode handling
-- ---------------------
-- The dispatcher writes are wrapped in try/catch — if this insert fails
-- (e.g. table missing on a stale function deploy, or a transient pg
-- hiccup) the user's run still returns successfully. We'd rather lose a
-- single analytics row than fail a working generation.
--
-- Privacy
-- -------
-- Stores user_id only (no email, no payload). The admin-hub already has
-- a user-lookup capability for joining on auth.users when an operator
-- needs to attribute a row to a person.

create table if not exists public.workspace_generation_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  workspace_id text,
  canvas_id text,
  node_id text,
  feature text not null,                 -- 'image' | 'video' | 'audio' | 'text' | 'model_3d'
  model text not null,                   -- e.g. 'nano-banana-2', 'kling-v2-6-pro'
  provider text,                         -- 'banana' | 'kling' | 'openai' | 'chat_ai' | ...
  output_tier text,                      -- 'low' | 'medium' | 'high' | '2k' | null
  output_count int not null default 1,
  width int,
  height int,
  duration_seconds numeric,
  aspect_ratio text,
  credits_spent int,
  status text not null default 'completed', -- only 'completed' rows recorded today
  task_id text,                          -- async job id when applicable (Kling/Tripo)
  created_at timestamptz not null default now()
);

-- Primary aggregation index. Analytics queries always group by
-- (feature, model, created_at), often filtered by since/until.
create index if not exists idx_wge_feature_model_created
  on public.workspace_generation_events (feature, model, created_at desc);

-- Tier rollup index. The "by tier" card filters on (feature, tier).
create index if not exists idx_wge_tier_created
  on public.workspace_generation_events (output_tier, created_at desc);

-- User-scoped lookups. The optional workspace-frontend "this month" pill
-- and any future per-user breakdowns hit this index.
create index if not exists idx_wge_user_created
  on public.workspace_generation_events (user_id, created_at desc);

-- Generic time-only scan, used by the 30-day timeseries query.
create index if not exists idx_wge_created
  on public.workspace_generation_events (created_at desc);

alter table public.workspace_generation_events enable row level security;

-- Owners can see their own events. The admin edge function uses the
-- service-role client and bypasses RLS entirely — that's the path the
-- admin analytics page reads through, so we don't add a separate admin
-- policy here. Keeping the user policy narrow (read-only, own rows)
-- means a future workspace-frontend "your usage" widget works without
-- any further RLS work.
drop policy if exists "wge_select_own" on public.workspace_generation_events;
create policy "wge_select_own"
  on public.workspace_generation_events
  for select
  using (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies. All writes flow through the
-- workspace-run-node edge function with service-role credentials.

comment on table public.workspace_generation_events is
  'One row per successful workspace generation (image/video/audio/etc). Written by workspace-run-node dispatcher; read by admin_workspace_analytics edge function.';
