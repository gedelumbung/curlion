-- Workspaces (like Postman): collections, environments and the activity log are grouped
-- into workspaces. Run after 007_shared_environments.sql. Safe to run more than once.
--
-- - Team workspaces: every signed-in user can see them, edit what is inside, create new
--   ones and rename them. Only the creator can delete one (deleting it deletes its
--   collections and environments).
-- - Personal workspace ("My Workspace"): one per user, visible to that user only.
-- - Everything that existed before goes into the "Team" workspace created here.
-- - Globals stay private to each user and apply in every workspace.

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_personal boolean not null default false,
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists workspaces_one_personal on public.workspaces(owner_id) where is_personal;

-- The workspace that holds everything shared before workspaces existed. No owner, so
-- nobody can delete it.
insert into public.workspaces (id, name, is_personal, owner_id)
values ('00000000-0000-0000-0000-000000000001', 'Team', false, null)
on conflict (id) do nothing;

alter table public.workspaces enable row level security;
grant select, insert, update, delete on public.workspaces to authenticated, service_role;

create or replace function public.can_access_workspace(wid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from workspaces where id = wid and (not is_personal or owner_id = auth.uid()));
$$;
grant execute on function public.can_access_workspace(uuid) to authenticated;

drop policy if exists "workspaces_select" on public.workspaces;
create policy "workspaces_select" on public.workspaces for select to authenticated
  using (not is_personal or owner_id = auth.uid());

drop policy if exists "workspaces_insert" on public.workspaces;
create policy "workspaces_insert" on public.workspaces for insert to authenticated
  with check (owner_id = auth.uid());

drop policy if exists "workspaces_update" on public.workspaces;
create policy "workspaces_update" on public.workspaces for update to authenticated
  using (not is_personal or owner_id = auth.uid())
  with check (not is_personal or owner_id = auth.uid());

drop policy if exists "workspaces_delete" on public.workspaces;
create policy "workspaces_delete" on public.workspaces for delete to authenticated
  using (owner_id = auth.uid() and not is_personal);

-- Renaming must never change who owns a workspace or whether it is personal.
create or replace function public.keep_workspace_owner()
returns trigger language plpgsql set search_path = public as $$
begin
  new.owner_id := old.owner_id;
  new.is_personal := old.is_personal;
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists workspaces_keep_owner on public.workspaces;
create trigger workspaces_keep_owner before update on public.workspaces
  for each row execute function public.keep_workspace_owner();

-- ---------------------------------------------------------------------------
-- Collections and environments belong to a workspace. The default keeps older
-- versions of the app (which do not send workspace_id) writing into "Team".
-- ---------------------------------------------------------------------------
alter table public.collections add column if not exists workspace_id uuid
  default '00000000-0000-0000-0000-000000000001' references public.workspaces(id) on delete cascade;
update public.collections set workspace_id = '00000000-0000-0000-0000-000000000001' where workspace_id is null;
alter table public.collections alter column workspace_id set not null;
create index if not exists collections_workspace_idx on public.collections(workspace_id);

alter table public.environments add column if not exists workspace_id uuid
  default '00000000-0000-0000-0000-000000000001' references public.workspaces(id) on delete cascade;
update public.environments set workspace_id = '00000000-0000-0000-0000-000000000001' where workspace_id is null and not is_global;
create index if not exists environments_workspace_idx on public.environments(workspace_id);

-- Collections: visible and editable in workspaces you can access; delete stays creator-only
drop policy if exists "collections_select" on public.collections;
create policy "collections_select" on public.collections for select to authenticated
  using (public.can_access_workspace(workspace_id));

drop policy if exists "collections_insert" on public.collections;
create policy "collections_insert" on public.collections for insert to authenticated
  with check (owner_id = auth.uid() and public.can_access_workspace(workspace_id));

drop policy if exists "collections_update" on public.collections;
create policy "collections_update" on public.collections for update to authenticated
  using (public.can_access_workspace(workspace_id))
  with check (public.can_access_workspace(workspace_id));

-- Environments: Globals stay private; the rest follow their workspace
drop policy if exists "environments_select" on public.environments;
create policy "environments_select" on public.environments for select to authenticated
  using (case when is_global then owner_id = auth.uid() else public.can_access_workspace(workspace_id) end);

drop policy if exists "environments_insert" on public.environments;
create policy "environments_insert" on public.environments for insert to authenticated
  with check (owner_id = auth.uid() and (is_global or public.can_access_workspace(workspace_id)));

drop policy if exists "environments_update" on public.environments;
create policy "environments_update" on public.environments for update to authenticated
  using (case when is_global then owner_id = auth.uid() else public.can_access_workspace(workspace_id) end)
  with check (case when is_global then owner_id = auth.uid() else public.can_access_workspace(workspace_id) end);

-- ---------------------------------------------------------------------------
-- Activity log per workspace. Entries about a collection get its workspace
-- automatically. Account-level entries (sign in / out, creating or deleting a
-- workspace) have no workspace; the app shows them in team workspaces only.
-- ---------------------------------------------------------------------------
alter table public.activity_logs add column if not exists workspace_id uuid
  references public.workspaces(id) on delete cascade;
update public.activity_logs l set workspace_id = coalesce(c.workspace_id, '00000000-0000-0000-0000-000000000001')
  from public.collections c
 where l.workspace_id is null and l.collection_id = c.id;
-- entries of collections deleted before this migration were all in the shared space
update public.activity_logs set workspace_id = '00000000-0000-0000-0000-000000000001'
 where workspace_id is null and (collection_id is not null or collection_name is not null);
create index if not exists activity_logs_workspace_idx on public.activity_logs(workspace_id, created_at desc);

create or replace function public.set_log_workspace()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.workspace_id is null and new.collection_id is not null then
    select workspace_id into new.workspace_id from collections where id = new.collection_id;
  end if;
  return new;
end;
$$;

drop trigger if exists activity_logs_set_workspace on public.activity_logs;
create trigger activity_logs_set_workspace before insert on public.activity_logs
  for each row execute function public.set_log_workspace();

drop policy if exists "logs_select" on public.activity_logs;
create policy "logs_select" on public.activity_logs for select to authenticated
  using (workspace_id is null or public.can_access_workspace(workspace_id));

drop policy if exists "logs_insert" on public.activity_logs;
create policy "logs_insert" on public.activity_logs for insert to authenticated
  with check (actor_id = auth.uid() and (workspace_id is null or public.can_access_workspace(workspace_id)));
