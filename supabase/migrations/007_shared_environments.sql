-- Shared environments (like Postman's initial / current values).
-- Run after 006_team_workspace.sql. Safe to run more than once.
--
-- - Every signed-in user can see and edit every environment except Globals.
--   The values stored here are the shared *initial values*.
-- - Each user's *current values* (e.g. tokens from Post-Response extraction) stay in
--   their own browser and are never written to this table.
-- - Globals stay private to each user.
-- - Only the creator can delete an environment.

drop policy if exists "environments_owner" on public.environments;
drop policy if exists "environments_select" on public.environments;
drop policy if exists "environments_insert" on public.environments;
drop policy if exists "environments_update" on public.environments;
drop policy if exists "environments_delete" on public.environments;

create policy "environments_select" on public.environments for select to authenticated
  using (not is_global or owner_id = auth.uid());

create policy "environments_insert" on public.environments for insert to authenticated
  with check (owner_id = auth.uid());

create policy "environments_update" on public.environments for update to authenticated
  using (not is_global or owner_id = auth.uid())
  with check (not is_global or owner_id = auth.uid());

create policy "environments_delete" on public.environments for delete to authenticated
  using (owner_id = auth.uid());

-- Editing must never change who owns an environment or turn it into someone's Globals.
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

-- Until now environments were private, so secret variables may hold real tokens or
-- passwords. Blank them before they become visible to everyone. (Beacon also moves
-- each user's secret values into their browser's current values on next launch.)
update public.environments e
   set variables = (
     select coalesce(jsonb_agg(
              case when (v->>'isSecret')::boolean is true then jsonb_set(v, '{value}', '""') else v end
              order by ord), '[]'::jsonb)
       from jsonb_array_elements(e.variables) with ordinality as t(v, ord)
   )
 where not e.is_global
   and exists (select 1 from jsonb_array_elements(e.variables) v
                where (v->>'isSecret')::boolean is true and coalesce(v->>'value', '') <> '');
