-- Enforce that workspace_canvases.workspace_id belongs to the same user
-- as the canvas row itself. Prevents a user from creating canvases that
-- reference another user's workspace (low severity — RLS already scopes
-- visibility, but this prevents phantom cross-user references that could
-- pollute workspace-level analytics).

create or replace function public.check_canvas_workspace_ownership()
returns trigger
language plpgsql
as $$
begin
  -- Only check if workspace_id is set (it's a required column, but
  -- this guard future-proofs against schema changes).
  if new.workspace_id is not null then
    if not exists (
      select 1 from public.workspaces
      where id = new.workspace_id
        and user_id = new.user_id
    ) then
      raise exception 'workspace_id "%" does not belong to user', new.workspace_id
        using errcode = '42501'; -- insufficient_privilege
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists canvas_workspace_ownership_trg on public.workspace_canvases;
create trigger canvas_workspace_ownership_trg
  before insert or update on public.workspace_canvases
  for each row execute function public.check_canvas_workspace_ownership();
