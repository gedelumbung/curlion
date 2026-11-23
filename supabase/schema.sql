-- Curlion schema for a NEW Supabase project: run this single file in the SQL Editor.
--
-- It is the end state of supabase/migrations/001-009.
-- Databases created from the migrations do NOT need this file; keep applying new
-- migrations to them instead. When adding a migration, update this file as well.
-- Safe to run more than once.
--
-- Access model:
-- - Sign-in only: the anon role has no access to any table or function.
-- - Team workspaces: every signed-in user can see them, edit what is inside, create new
--   ones and rename them. Only the creator can delete one (deleting it deletes its
--   collections and environments).
-- - Personal workspace ("My Workspace"): one per user, visible to that user only.
-- - Collections and environments follow their workspace; only the creator can delete them.
-- - Globals (environments.is_global) are private to each user and apply in every workspace.
-- - Published docs: readable by any signed-in user; only the collection owner publishes.
-- - Activity log: append-only, per workspace; account events have no workspace.
-- - The mock edge function reads with the service role key.

-- ===========================================================================
-- Tables
-- ===========================================================================

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_personal boolean not null default false,
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists workspaces_one_personal on public.workspaces(owner_id) where is_personal;

-- Default shared workspace. No owner, so nobody can delete it.
insert into public.workspaces (id, name, is_personal, owner_id)
values ('00000000-0000-0000-0000-000000000001', 'Team', false, null)
on conflict (id) do nothing;

-- The whole folder/request tree lives in tree_data (JSONB).
-- is_public / public_slug are still written by the app but not used by any policy;
-- public docs come from published_docs.
create table if not exists public.collections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade not null,
  workspace_id uuid not null default '00000000-0000-0000-0000-000000000001'
    references public.workspaces(id) on delete cascade,
  name text not null,
  description text,
  is_public boolean default false,
  public_slug text unique,
  tree_data jsonb not null default '{"items": []}'::jsonb,
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);
create index if not exists collections_owner_idx on public.collections(owner_id);
create index if not exists collections_workspace_idx on public.collections(workspace_id);

-- Shared environments hold the *initial values*; each user's *current values* stay in
-- their browser. Globals have no workspace.
create table if not exists public.environments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade not null,
  workspace_id uuid default '00000000-0000-0000-0000-000000000001'
    references public.workspaces(id) on delete cascade,
  name text not null,
  is_global boolean not null default false,
  variables jsonb not null default '[]'::jsonb,
  updated_at timestamptz default now()
);
create index if not exists environments_owner_idx on public.environments(owner_id);
create index if not exists environments_workspace_idx on public.environments(workspace_id);

-- Sanitized, read-only docs snapshot per collection (never raw tree_data).
create table if not exists public.published_docs (
  collection_id uuid primary key references public.collections(id) on delete cascade,
  owner_id uuid references auth.users(id) on delete cascade not null,
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$'),
  name text not null,
  description text,
  data jsonb not null default '{"items": []}'::jsonb,
  published_at timestamptz not null default now()
);

-- History survives collection deletion (collection_name keeps the label).
create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  collection_id uuid references public.collections(id) on delete set null,
  collection_name text,
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text,
  action text not null,
  target_name text not null,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create index if not exists activity_logs_collection_idx on public.activity_logs(collection_id, created_at desc);
create index if not exists activity_logs_created_idx on public.activity_logs(created_at desc);
create index if not exists activity_logs_actor_idx on public.activity_logs(actor_id, created_at desc);
create index if not exists activity_logs_workspace_idx on public.activity_logs(workspace_id, created_at desc);

-- ===========================================================================
-- Helpers (security definer avoids RLS recursion)
-- ===========================================================================

create or replace function public.is_collection_owner(cid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from collections where id = cid and owner_id = auth.uid());
$$;

create or replace function public.can_access_workspace(wid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from workspaces where id = wid and (not is_personal or owner_id = auth.uid()));
$$;

-- ===========================================================================
-- Triggers: editing must never change ownership
-- ===========================================================================

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

create or replace function public.keep_collection_owner()
returns trigger language plpgsql set search_path = public as $$
begin
  new.owner_id := old.owner_id;
  new.created_at := old.created_at;
  return new;
end;
$$;
drop trigger if exists collections_keep_owner on public.collections;
create trigger collections_keep_owner before update on public.collections
  for each row execute function public.keep_collection_owner();

create or replace function public.keep_environment_owner()
returns trigger language plpgsql set search_path = public as $$
begin
  new.owner_id := old.owner_id;
  new.is_global := old.is_global;
  return new;
end;
$$;
drop trigger if exists environments_keep_owner on public.environments;
create trigger environments_keep_owner before update on public.environments
  for each row execute function public.keep_environment_owner();

-- Log entries about a collection get its workspace automatically.
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

-- ===========================================================================
-- Row Level Security
-- ===========================================================================

alter table public.workspaces enable row level security;
alter table public.collections enable row level security;
alter table public.environments enable row level security;
alter table public.published_docs enable row level security;
alter table public.activity_logs enable row level security;

-- Workspaces
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

-- Collections
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

drop policy if exists "collections_delete" on public.collections;
create policy "collections_delete" on public.collections for delete to authenticated
  using (owner_id = auth.uid());

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

drop policy if exists "environments_delete" on public.environments;
create policy "environments_delete" on public.environments for delete to authenticated
  using (owner_id = auth.uid());

-- Published docs
drop policy if exists "docs_read_signed_in" on public.published_docs;
create policy "docs_read_signed_in" on public.published_docs for select to authenticated
  using (true);

drop policy if exists "docs_owner_write" on public.published_docs;
create policy "docs_owner_write" on public.published_docs for all
  using (public.is_collection_owner(collection_id))
  with check (owner_id = auth.uid() and public.is_collection_owner(collection_id));

-- Activity log: append-only (no update/delete policies)
drop policy if exists "logs_select" on public.activity_logs;
create policy "logs_select" on public.activity_logs for select to authenticated
  using (workspace_id is null or public.can_access_workspace(workspace_id));

drop policy if exists "logs_insert" on public.activity_logs;
create policy "logs_insert" on public.activity_logs for insert to authenticated
  with check (actor_id = auth.uid() and (workspace_id is null or public.can_access_workspace(workspace_id)));

-- ===========================================================================
-- Privileges. Newer Supabase projects do not grant these automatically
-- ("permission denied for table ..."); RLS above still decides which rows.
-- ===========================================================================

grant usage on schema public to authenticated, service_role;

grant select, insert, update, delete on public.workspaces to authenticated;
grant select, insert, update, delete on public.collections to authenticated;
grant select, insert, update, delete on public.environments to authenticated;
grant select, insert, update, delete on public.published_docs to authenticated;
grant select, insert on public.activity_logs to authenticated;

-- Service role (mock endpoint): bypasses RLS but still needs table privileges.
grant select, insert, update, delete on all tables in schema public to service_role;

-- Helpers are called inside RLS policies, so the querying role must be able to execute them.
grant execute on function public.is_collection_owner(uuid) to authenticated;
grant execute on function public.can_access_workspace(uuid) to authenticated;

-- No anonymous access to anything, now or for objects created later.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon;
revoke usage on schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from anon;
