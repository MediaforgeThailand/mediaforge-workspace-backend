-- Phase 4b: consume_credits with runtime plan discount.
-- Caller passes raw amount (the price-list value); we look up the user's plan, derive
-- credit_discount_percent, and deduct floor(amount * (100 - discount) / 100). Free-tier
-- users (subscription_plan_id IS NULL) get 0% discount, identical to pre-migration behaviour.
create or replace function public.consume_credits(
  p_user_id uuid,
  p_amount integer,
  p_feature text default null,
  p_description text default null,
  p_reference_id text default null
) returns boolean
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_remaining integer;
  v_batch record;
  v_deduct integer;
  v_new_balance integer;
  v_lock_key bigint;
  v_discount integer := 0;
  v_effective integer;
begin
  if p_amount <= 0 then
    raise exception 'Amount must be positive';
  end if;

  -- Resolve user's plan discount (NULL plan => 0)
  select coalesce(sp.credit_discount_percent, 0)
    into v_discount
    from profiles pr
    left join subscription_plans sp on sp.id = pr.subscription_plan_id
   where pr.user_id = p_user_id;

  v_discount := coalesce(v_discount, 0);
  v_effective := greatest(1, floor(p_amount * (100 - v_discount) / 100.0)::int);
  v_remaining := v_effective;

  -- Use advisory lock based on user_id to prevent concurrent modifications
  v_lock_key := ('x' || left(replace(p_user_id::text, '-', ''), 15))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  -- Check total available credits across non-expired batches against the EFFECTIVE amount
  if (
    select coalesce(sum(remaining), 0)
      from credit_batches
     where user_id = p_user_id and remaining > 0 and expires_at > now()
  ) < v_effective then
    return false;
  end if;

  -- Consume from batches: top-up first, then subscription, ordered by expiry (earliest first)
  for v_batch in
    select id, remaining
      from credit_batches
     where user_id = p_user_id and remaining > 0 and expires_at > now()
     order by case source_type when 'topup' then 0 else 1 end,
              expires_at asc
  loop
    exit when v_remaining <= 0;
    v_deduct := least(v_remaining, v_batch.remaining);
    update credit_batches set remaining = remaining - v_deduct where id = v_batch.id;
    v_remaining := v_remaining - v_deduct;
  end loop;

  -- Update user_credits balance using EFFECTIVE
  update user_credits
     set balance = balance - v_effective,
         total_used = total_used + v_effective,
         updated_at = now()
   where user_id = p_user_id;

  select balance into v_new_balance from user_credits where user_id = p_user_id;

  -- Record transaction; amount = raw price (visible to user), effective_amount = what we actually deducted
  insert into credit_transactions (
    user_id, amount, type, feature, description, reference_id,
    balance_after, effective_amount, discount_percent
  ) values (
    p_user_id, -p_amount, 'usage', p_feature, p_description, p_reference_id,
    coalesce(v_new_balance, 0), -v_effective, v_discount
  );

  return true;
end;
$$;

-- Phase 4c: consume_credits_for — applies team discount on the team path,
-- otherwise delegates to consume_credits (which now does the user-side discount).
create or replace function public.consume_credits_for(
  p_user_id uuid,
  p_team_id uuid,
  p_amount integer,
  p_feature text,
  p_description text,
  p_reference_id text,
  p_workspace_id text default null,
  p_canvas_id text default null
) returns boolean
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_balance integer;
  v_discount integer := 0;
  v_effective integer;
  v_team_plan_id uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'consume_credits_for: amount must be positive';
  end if;

  -- Solo path: defer to consume_credits which now applies user-plan discount
  if p_team_id is null then
    return public.consume_credits(
      p_user_id, p_amount, p_feature, p_description, p_reference_id
    );
  end if;

  -- TEAM PATH ----------------------------------------------------------------
  -- Try teams.subscription_plan_id; fall back to the active Team plan row.
  begin
    execute 'select subscription_plan_id from public.teams where id = $1'
       into v_team_plan_id
      using p_team_id;
  exception when undefined_column then
    v_team_plan_id := null;
  end;

  if v_team_plan_id is null then
    select id into v_team_plan_id
      from subscription_plans
     where target = 'team' and is_active = true
     order by sort_order
     limit 1;
  end if;

  select coalesce(credit_discount_percent, 0) into v_discount
    from subscription_plans where id = v_team_plan_id;
  v_discount := coalesce(v_discount, 0);

  v_effective := greatest(1, floor(p_amount * (100 - v_discount) / 100.0)::int);

  select credit_balance into v_balance
    from public.teams
   where id = p_team_id
   for update;

  if not found then
    raise exception 'consume_credits_for: team % not found', p_team_id;
  end if;

  if v_balance < v_effective then
    return false;
  end if;

  update public.teams
     set credit_balance = credit_balance - v_effective,
         updated_at     = now()
   where id = p_team_id;

  insert into public.team_credit_transactions (
    team_id, triggered_by, workspace_id, canvas_id,
    amount, reason, description, effective_amount, discount_percent
  ) values (
    p_team_id, p_user_id, p_workspace_id, p_canvas_id,
    -p_amount, 'node_run', coalesce(p_description, p_feature),
    -v_effective, v_discount
  );

  return true;
end;
$$;
