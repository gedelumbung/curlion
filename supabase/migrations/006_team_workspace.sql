-- Team workspace: every signed-in user can see and edit every collection.
-- Run after 005_admin_created_accounts.sql. Safe to run more than once.
--
-- Still restricted to the collection's creator (owner):
--   - deleting the collection          (collections_delete, unchanged)
--   - publishing / unpublishing docs   (docs_owner_write, unchanged)
-- Environments stay private to each user (environments_owner, unchanged).

-- Collections: read and update by any signed-in user
drop policy if exists "collections_select" on public.collections;
create policy "collections_select" on public.collections for select to authenticated
  using (true);

drop policy if exists "collections_update" on public.collections;
create policy "collections_update" on public.collections for update to authenticated
  using (true)
  with check (true);

-- Editing must never change who owns a collection (RLS cannot restrict columns).
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

-- Activity log: readable by everyone signed in; anyone may log their own edits
drop policy if exists "logs_select" on public.activity_logs;
create policy "logs_select" on public.activity_logs for select to authenticated
  using (true);

drop policy if exists "logs_insert" on public.activity_logs;
create policy "logs_insert" on public.activity_logs for insert to authenticated
  with check (actor_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Activity dashboard: keep the history when a collection is deleted, and allow
-- account events (sign in / sign out) that are not tied to a collection.
-- ---------------------------------------------------------------------------
alter table public.activity_logs add column if not exists collection_name text;
alter table public.activity_logs alter column collection_id drop not null;
alter table public.activity_logs drop constraint if exists activity_logs_collection_id_fkey;
alter table public.activity_logs add constraint activity_logs_collection_id_fkey
  foreign key (collection_id) references public.collections(id) on delete set null;

-- fill in names for entries written before this column existed
update public.activity_logs l set collection_name = c.name
  from public.collections c
 where l.collection_id = c.id and l.collection_name is null;

create index if not exists activity_logs_created_idx on public.activity_logs(created_at desc);
create index if not exists activity_logs_actor_idx on public.activity_logs(actor_id, created_at desc);

-- The log is append-only: no update/delete policies exist, so nobody can rewrite history.
