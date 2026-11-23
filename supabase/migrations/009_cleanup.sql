-- Remove objects the app no longer uses, so databases built from the migrations match
-- supabase/schema.sql. Run after 008_workspaces.sql. Safe to run more than once.
--
-- - Per-collection members (collection_members) and their RPCs were replaced by workspaces
--   in 006/008; no policy references them any more.
-- - is_collection_owner stays: docs_owner_write still uses it.

drop function if exists public.invite_collection_member(uuid, text, text);
drop function if exists public.list_collection_members(uuid);
drop table if exists public.collection_members;  -- drops its policies too
drop function if exists public.has_collection_role(uuid, text[]);

-- Same rule as before (creator only), limited to signed-in users like every other policy.
drop policy if exists "collections_delete" on public.collections;
create policy "collections_delete" on public.collections for delete to authenticated
  using (owner_id = auth.uid());
