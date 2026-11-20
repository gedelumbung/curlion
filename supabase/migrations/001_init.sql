-- Beacon schema (PRD §6): relational + JSONB hybrid.
-- Run in Supabase SQL Editor, or with `supabase db push`.

-- 1. Collections: the whole folder/request tree lives in tree_data (JSONB).
create table if not exists public.collections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  description text,
  is_public boolean default false,
  public_slug text unique,
  tree_data jsonb not null default '{"items": []}'::jsonb,
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);
create index if not exists collections_owner_idx on public.collections(owner_id);

-- 2. Environments. is_global marks the per-user "Globals" environment
--    (addition to the PRD schema so Globals can sync too).
create table if not exists public.environments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  is_global boolean not null default false,
  variables jsonb not null default '[]'::jsonb,
  updated_at timestamptz default now()
);
create index if not exists environments_owner_idx on public.environments(owner_id);

-- 3. Collection collaborators (phase 2 / nice-to-have)
create table if not exists public.collection_members (
  collection_id uuid references public.collections(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text check (role in ('viewer', 'editor')) not null,
  primary key (collection_id, user_id)
);

-- 4. Activity log (phase 2 / nice-to-have)
create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid references public.collections(id) on delete cascade not null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text,
  action text not null,
  target_name text not null,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create index if not exists activity_logs_collection_idx on public.activity_logs(collection_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Helpers (security definer avoids RLS recursion between collections/members)
-- ---------------------------------------------------------------------------
create or replace function public.is_collection_owner(cid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from collections where id = cid and owner_id = auth.uid());
$$;

create or replace function public.has_collection_role(cid uuid, roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from collection_members
    where collection_id = cid and user_id = auth.uid() and role = any(roles)
  );
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.collections enable row level security;
alter table public.environments enable row level security;
alter table public.collection_members enable row level security;
alter table public.activity_logs enable row level security;

-- Collections
drop policy if exists "collections_select" on public.collections;
create policy "collections_select" on public.collections for select
  using (
    is_public
    or owner_id = auth.uid()
    or public.has_collection_role(id, array['viewer', 'editor'])
  );

drop policy if exists "collections_insert" on public.collections;
create policy "collections_insert" on public.collections for insert
  with check (owner_id = auth.uid());

drop policy if exists "collections_update" on public.collections;
create policy "collections_update" on public.collections for update
  using (owner_id = auth.uid() or public.has_collection_role(id, array['editor']))
  with check (owner_id = auth.uid() or public.has_collection_role(id, array['editor']));

drop policy if exists "collections_delete" on public.collections;
create policy "collections_delete" on public.collections for delete
  using (owner_id = auth.uid());

-- Environments: owner only
drop policy if exists "environments_owner" on public.environments;
create policy "environments_owner" on public.environments for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Members: owner manages, members can see their own membership
drop policy if exists "members_select" on public.collection_members;
create policy "members_select" on public.collection_members for select
  using (user_id = auth.uid() or public.is_collection_owner(collection_id));

drop policy if exists "members_write" on public.collection_members;
create policy "members_write" on public.collection_members for all
  using (public.is_collection_owner(collection_id))
  with check (public.is_collection_owner(collection_id));

-- Activity logs: readable by all members, insertable by owner/editor as themselves
drop policy if exists "logs_select" on public.activity_logs;
create policy "logs_select" on public.activity_logs for select
  using (
    public.is_collection_owner(collection_id)
    or public.has_collection_role(collection_id, array['viewer', 'editor'])
  );

drop policy if exists "logs_insert" on public.activity_logs;
create policy "logs_insert" on public.activity_logs for insert
  with check (
    actor_id = auth.uid()
    and (public.is_collection_owner(collection_id) or public.has_collection_role(collection_id, array['editor']))
  );
