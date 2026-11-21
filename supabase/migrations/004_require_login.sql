-- Sign-in only: no anonymous access to any Curlion data. Run after 003_grants.sql.
--
-- - Published docs (/docs/<slug>) can be read by any signed-in user, not by anonymous visitors.
-- - The anon role loses every privilege on Curlion's tables and functions.
-- - The mock endpoint (/mock/*) reads with the service role key on the server.
-- Safe to run more than once.

drop policy if exists "docs_public_read" on public.published_docs;
drop policy if exists "docs_read_signed_in" on public.published_docs;
create policy "docs_read_signed_in" on public.published_docs for select to authenticated using (true);

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon;
revoke usage on schema public from anon;

-- keep tables/functions created later in this schema closed to anon as well
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from anon;
