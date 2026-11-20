-- Phase 4: published docs, collaboration RPCs, activity log access.
-- Run after 001_init.sql.

-- ---------------------------------------------------------------------------
-- Published docs: a sanitized, read-only snapshot per collection.
-- Kept separate from collections.tree_data so that publishing never exposes
-- raw request data (e.g. literal tokens) to anonymous readers.
-- ---------------------------------------------------------------------------
create table if not exists public.published_docs (
  collection_id uuid primary key references public.collections(id) on delete cascade,
  owner_id uuid references auth.users(id) on delete cascade not null,
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$'),
  name text not null,
  description text,
  data jsonb not null default '{"items": []}'::jsonb,
  published_at timestamptz not null default now()
);

alter table public.published_docs enable row level security;

drop policy if exists "docs_public_read" on public.published_docs;
create policy "docs_public_read" on public.published_docs for select using (true);

drop policy if exists "docs_owner_write" on public.published_docs;
create policy "docs_owner_write" on public.published_docs for all
  using (public.is_collection_owner(collection_id))
  with check (owner_id = auth.uid() and public.is_collection_owner(collection_id));

-- Collections are no longer readable anonymously through is_public:
-- public docs come from published_docs, and the mock endpoint reads either
-- published_docs (anon key) or collections (service role key).
drop policy if exists "collections_select" on public.collections;
create policy "collections_select" on public.collections for select
  using (owner_id = auth.uid() or public.has_collection_role(id, array['viewer', 'editor']));

-- Members may leave a collection on their own.
drop policy if exists "members_leave" on public.collection_members;
create policy "members_leave" on public.collection_members for delete
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- RPC: invite (or change role of) a member by email. Owner only.
-- auth.users is not readable from the client, hence security definer.
-- ---------------------------------------------------------------------------
create or replace function public.invite_collection_member(p_collection_id uuid, p_email text, p_role text)
returns void
language plpgsql security definer set search_path = public, auth as $$
declare
  v_user uuid;
begin
  if not public.is_collection_owner(p_collection_id) then
    raise exception 'Only the collection owner can invite members';
  end if;
  if p_role not in ('viewer', 'editor') then
    raise exception 'Role must be viewer or editor';
  end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then
    raise exception 'No Echo account uses %. Ask them to sign up first.', p_email;
  end if;
  if v_user = auth.uid() then
    raise exception 'You already own this collection';
  end if;
  insert into collection_members (collection_id, user_id, role)
  values (p_collection_id, v_user, p_role)
  on conflict (collection_id, user_id) do update set role = excluded.role;
end;
$$;

-- RPC: list owner + members with their emails. Visible to the owner and members.
create or replace function public.list_collection_members(p_collection_id uuid)
returns table (user_id uuid, email text, role text)
language plpgsql security definer set search_path = public, auth as $$
begin
  if not (public.is_collection_owner(p_collection_id)
          or public.has_collection_role(p_collection_id, array['viewer', 'editor'])) then
    raise exception 'Not a member of this collection';
  end if;
  return query
    select c.owner_id, u.email::text, 'owner'::text
      from collections c join auth.users u on u.id = c.owner_id
     where c.id = p_collection_id
    union all
    select m.user_id, u.email::text, m.role
      from collection_members m join auth.users u on u.id = m.user_id
     where m.collection_id = p_collection_id;
end;
$$;

revoke all on function public.invite_collection_member(uuid, text, text) from public, anon;
revoke all on function public.list_collection_members(uuid) from public, anon;
grant execute on function public.invite_collection_member(uuid, text, text) to authenticated;
grant execute on function public.list_collection_members(uuid) to authenticated;
