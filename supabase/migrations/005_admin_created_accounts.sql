-- Accounts are created by an administrator (no self sign-up), so update the
-- invite error message accordingly. Same function as in 002, message only.
-- Safe to run more than once. Run after 004_require_login.sql.

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
    raise exception 'No Beacon account uses %. An administrator has to create the account first.', p_email;
  end if;
  if v_user = auth.uid() then
    raise exception 'You already own this collection';
  end if;
  insert into collection_members (collection_id, user_id, role)
  values (p_collection_id, v_user, p_role)
  on conflict (collection_id, user_id) do update set role = excluded.role;
end;
$$;

-- create or replace keeps existing grants; restate them in case 004 ran first on a fresh project
revoke all on function public.invite_collection_member(uuid, text, text) from public, anon;
grant execute on function public.invite_collection_member(uuid, text, text) to authenticated;
