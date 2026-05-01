-- consume_credits_for / refund_credits_for — team-aware wrappers.
--
-- Workspace product is moving toward team accounts (see the SSO +
-- teams migration). Each team has its own credit pool
-- (`teams.credit_balance`); workspaces flagged with a `team_id`
-- should debit the team pool, not the personal `user_credits`
-- ledger of whoever happened to click Run.
--
-- These RPCs are additive — every existing call to `consume_credits`
-- and `refund_credits` keeps working unchanged. New code paths
-- (workspace-run-node when the workspace has a team_id) call the
-- `_for` variants and pass `p_team_id`. When `p_team_id IS NULL` the
-- functions delegate to the legacy per-user RPCs.
--
-- Returns boolean (success/insufficient) for the consume side, mirror
-- of the legacy contract. Refund side returns void.
--
-- NOTE: this migration was authored as part of Wave 3 cleanup but
-- not auto-applied (the sandbox blocks security-definer RPCs that
-- move credits between accounts). Apply manually with:
--     supabase db push
-- once the workspace-frontend dispatcher rewire (next file) is ready
-- to consume the new RPCs.

create or replace function public.consume_credits_for(
  p_user_id      uuid,
  p_team_id      uuid,                  -- nullable: NULL = personal flow
  p_amount       integer,
  p_feature      text,
  p_description  text,
  p_reference_id text,
  p_workspace_id text default null,
  p_canvas_id    text default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance integer;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'consume_credits_for: amount must be positive';
  end if;

  -- Personal-flow path → delegate to the legacy RPC unchanged.
  if p_team_id is null then
    return public.consume_credits(
      p_user_id,
      p_amount,
      p_feature,
      p_description,
      p_reference_id
    );
  end if;

  -- Team-flow path → atomic SELECT … FOR UPDATE on the team row +
  -- conditional decrement. Locks just the single team row; concurrent
  -- runs from other team members serialise here.
  select credit_balance into v_balance
    from public.teams
   where id = p_team_id
   for update;

  if not found then
    raise exception 'consume_credits_for: team % not found', p_team_id;
  end if;

  if v_balance < p_amount then
    return false;  -- insufficient; caller surfaces the "top up" prompt
  end if;

  update public.teams
     set credit_balance = credit_balance - p_amount,
         updated_at     = now()
   where id = p_team_id;

  insert into public.team_credit_transactions (
    team_id, triggered_by, workspace_id, canvas_id,
    amount, reason, description
  ) values (
    p_team_id, p_user_id, p_workspace_id, p_canvas_id,
    -p_amount, 'node_run', coalesce(p_description, p_feature)
  );

  return true;
end;
$$;

revoke all on function public.consume_credits_for(
  uuid, uuid, integer, text, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.consume_credits_for(
  uuid, uuid, integer, text, text, text, text, text
) to authenticated, service_role;


create or replace function public.refund_credits_for(
  p_user_id      uuid,
  p_team_id      uuid,
  p_amount       integer,
  p_reason       text,
  p_reference_id text default null,
  p_workspace_id text default null,
  p_canvas_id    text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_amount is null or p_amount <= 0 then
    return;  -- silent no-op, mirrors refund_credits behaviour
  end if;

  -- Personal-flow refund → legacy RPC.
  if p_team_id is null then
    perform public.refund_credits(
      p_user_id,
      p_amount,
      coalesce(p_reason, 'workspace refund'),
      p_reference_id
    );
    return;
  end if;

  -- Team-flow refund — credit balance back, tag the transaction as
  -- a refund (positive amount, reason = 'node_run_refund').
  update public.teams
     set credit_balance = credit_balance + p_amount,
         updated_at     = now()
   where id = p_team_id;

  insert into public.team_credit_transactions (
    team_id, triggered_by, workspace_id, canvas_id,
    amount, reason, description
  ) values (
    p_team_id, p_user_id, p_workspace_id, p_canvas_id,
    p_amount, 'node_run_refund', coalesce(p_reason, 'workspace refund')
  );
end;
$$;

revoke all on function public.refund_credits_for(
  uuid, uuid, integer, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.refund_credits_for(
  uuid, uuid, integer, text, text, text, text
) to authenticated, service_role;


-- Helper for the dispatcher: given a workspace_id (text), return the
-- team_id (uuid) the workspace belongs to, or NULL for personal
-- workspaces. Lets the dispatcher pick the right pool with a single
-- SELECT instead of joining the workspaces row inline.
create or replace function public.workspace_team_id(p_workspace_id text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_team_id uuid;
begin
  if p_workspace_id is null then
    return null;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'workspaces'
      and column_name = 'team_id'
  ) then
    return null;
  end if;

  execute 'select team_id from public.workspaces where id = $1'
    into v_team_id
    using p_workspace_id;

  return v_team_id;
end;
$$;

grant execute on function public.workspace_team_id(text)
  to authenticated, service_role;
