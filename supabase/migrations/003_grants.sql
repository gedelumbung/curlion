-- Table/function privileges for the API roles. Run after 002_phase4_docs_collab.sql.
--
-- Newer Supabase projects no longer grant anon/authenticated access to tables
-- created in SQL automatically, which shows up as
-- "permission denied for table collections". RLS policies (001/002) still decide
-- which rows each user can touch; these grants only allow the role to reach the table.
-- Safe to run more than once.

grant usage on schema public to authenticated, service_role;

-- Signed-in users: their own data, shared collections, publishing, activity log.
grant select, insert, update, delete on public.collections to authenticated;
grant select, insert, update, delete on public.environments to authenticated;
grant select, insert, update, delete on public.collection_members to authenticated;
grant select, insert, update, delete on public.published_docs to authenticated;
grant select, insert on public.activity_logs to authenticated;

-- Anonymous visitors get nothing: the app, docs and mocks all require sign-in or
-- the server-side service key (see 004_require_login.sql).

-- Service role (mock endpoint key): bypasses RLS but still needs table privileges.
grant select, insert, update, delete on all tables in schema public to service_role;

-- Helper functions are called inside RLS policies, so the querying role must be able to execute them.
grant execute on function public.is_collection_owner(uuid) to authenticated;
grant execute on function public.has_collection_role(uuid, text[]) to authenticated;
