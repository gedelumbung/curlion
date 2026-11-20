# Beacon

A web-based API client (a lightweight Postman alternative) with **local-first storage** (IndexedDB), optional sync to **Supabase**, and **Netlify Edge Functions** for a CORS proxy and mock endpoints. Target cost: $0 (free tiers).

Stack: Vue 3 + Vite, Tailwind CSS v4, CodeMirror 6, Dexie.js, `@supabase/supabase-js`, Lucide icons.

## Running locally

```bash
npm install
npm run dev        # http://localhost:5173 (local mode, no login)
npm test           # unit tests: cURL parser, URL/params, variables, Postman import/export, snippets
npm run build
```

Without a `.env` file the app runs **local only**: all data is stored in the browser's IndexedDB.
With Supabase configured, Beacon is **sign-in only**: the app, the docs pages and the mock data are not available to anonymous visitors.

To try **Proxy mode** and the **mock endpoint** locally, use the Netlify CLI:

```bash
npm i -g netlify-cli
netlify dev        # runs Vite + edge functions at /api/proxy and /mock/*
```

## Cloud setup (optional)

1. Create a project on [Supabase](https://supabase.com), then run these in order in the SQL Editor:
   - [`001_init.sql`](supabase/migrations/001_init.sql): tables + RLS
   - [`002_phase4_docs_collab.sql`](supabase/migrations/002_phase4_docs_collab.sql): published docs, collaboration RPCs
   - [`003_grants.sql`](supabase/migrations/003_grants.sql): table privileges for signed-in users (newer Supabase projects do not grant these automatically, which shows up as "permission denied for table collections")
   - [`004_require_login.sql`](supabase/migrations/004_require_login.sql): removes all anonymous access; docs are readable by signed-in users only
   - [`005_admin_created_accounts.sql`](supabase/migrations/005_admin_created_accounts.sql): invite error message for admin-created accounts
2. Copy `.env.example` to `.env` and fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3. In Supabase → Authentication → URL Configuration, set the Site URL to your site and add `https://<your-site>/**` (and `http://localhost:5173/**` for development) to Redirect URLs, so sign-in returns to the page it started from (e.g. a docs link).
4. Lock down sign-in (accounts are created by an administrator; there is no sign-up or OAuth):
   - Supabase → Authentication → Sign In / Providers: turn off **Allow new users to sign up**, keep **Email** enabled, and leave every OAuth provider disabled.
   - Create each user in Supabase → Authentication → Users → **Add user → Create new user**, with **Auto Confirm User** checked.
5. Deploy to Netlify (build `npm run build`, publish `dist`; already configured in [`netlify.toml`](netlify.toml)). Set these env vars in Netlify:
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`: frontend build (not secret: they end up in the browser bundle)
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`: mock edge function (mark the service role key as secret)

## Features (MVP, PRD §4)

| Feature | Status |
| --- | --- |
| CRUD for requests/folders/collections, duplicate, rename, drag & drop | ✅ |
| Methods GET/POST/PUT/PATCH/DELETE/OPTIONS/HEAD | ✅ |
| Params ↔ URL bar (two-way sync), Headers (autocomplete), Auth (Bearer/Basic/API Key in header or query) | ✅ |
| Body: none, form-data (text/file), x-www-form-urlencoded, raw (JSON/Text/XML/HTML) | ✅ |
| Response: colored status, time (ms), size, headers, Pretty/Tree/Raw, Copy | ✅ |
| Send and Download + automatic binary response detection (`Content-Disposition`, pdf/zip/images) | ✅ |
| Direct Browser Mode & Netlify Proxy Mode (localhost is blocked by the proxy, with a clear message) | ✅ |
| Live sidebar search (name/folder/URL), request history | ✅ |
| Import Postman Collection v2.1 (folders, auth, body, saved responses → samples, variables → environment) | ✅ |
| Export a collection to Postman v2.1 JSON | ✅ |
| Environments + Globals, switcher, `{{var}}` green/red highlighting + value on hover, `{{` autocomplete | ✅ |
| Dynamic vars: `$uuid`, `$guid`, `$timestamp`, `$isoTimestamp`, `$randomInt`, `$randomEmail` | ✅ |
| Post-Response Extract (JSON path → environment variable), token chaining | ✅ |
| Paste cURL into the URL bar / Import → Raw cURL | ✅ |
| Code snippets: cURL, fetch, Axios, PHP cURL, Guzzle, Go net/http, Python requests | ✅ |
| Sample / example responses + mock URL `/mock/<collection_id>/<sample_id>` | ✅ |
| Supabase Auth (email/password only, accounts created by an admin) + local↔cloud sync (3-second debounce, `Ctrl/⌘+S`) | ✅ |
| Secret variables (`is_secret`): masked in the UI, left out of snippets when the mask option is on | ✅ |

## Phase 4 features (PRD §5)

All available from the collection menu in the sidebar (right-click or `⋯`): **Share & members**, **Publish docs**, **Activity log**.

| Feature | Status |
| --- | --- |
| **Publish Docs**: read-only page `/docs/<slug>` for signed-in users (per-folder nav, params, headers, body, auth, sample responses, cURL/JS/PHP/Go/Python snippets + Copy) | ✅ |
| Update published content, change slug, Unpublish | ✅ |
| Local docs preview `/docs/preview/<collection_id>` (no login) | ✅ |
| Per-request (**Docs** tab) and per-collection descriptions | ✅ |
| Invite members by email as **Viewer** / **Editor**, change role, remove member, leave a collection | ✅ |
| Viewer: read-only (not synced, edit menus hidden), "shared" badge in the sidebar | ✅ |
| **Activity Log**: `CREATE/UPDATE/DELETE_REQUEST`, `CREATE/RENAME/DELETE_FOLDER`, `IMPORT_COLLECTION`, `ADD_MOCK_SAMPLE`, publish/unpublish, add/remove member, with a diff summary (e.g. `method: GET → POST`, `url: … → …`) | ✅ |

## Interface

- **Multiple tabs** (like Postman): a single click in the sidebar opens a *preview* tab (italic) that the next click replaces; editing, sending or double-clicking keeps it open. Close with × or middle-click, drag to reorder, right-click for Close others / to the right / all. Each tab keeps its own response and can send concurrently. Open tabs are remembered.
- **Light / dark theme**: toggle switch in the header. The choice is remembered; until you pick one, it follows the system setting.
- **Resizable panes**: drag the sidebar edge or the divider between request and response. Double-click a divider to reset it. Sizes are remembered per browser.
- **"Getting Started" sample**: seeded on first run.

### How it works and design decisions

- **Docs are a sanitized snapshot** stored in the `published_docs` table, not live collection data. Literal tokens, passwords and API keys (in auth, sensitive headers, or `api_key`/`token` query params) are replaced with placeholders. `{{variables}}` are shown by name. Environment values are never published. Docs can be read by any signed-in user who has the link; the anon role has no access to any table (the PRD's `is_public` policy is not used).
- **Sign-in only:** with Supabase configured the app shows a login screen first. Signing out uploads pending changes and then removes that account's data from the browser; if a different account signs in, local data from the previous one is cleared first. The mock endpoint reads with the service role key on the server, since anonymous database access is closed.
- **The activity log is computed from a diff** between the last logged tree and the tree that was just synced. Consecutive changes by one person are merged, roughly one entry per minute per collection. The log is also flushed on `Ctrl/⌘+S`, when the tab is hidden, and on logout. Only changes that actually reached the cloud are recorded.
- **Invite by email** uses the `invite_collection_member` RPC (security definer), because `auth.users` cannot be read from the client. The invited person must already have an account.
- Editors save changes with `UPDATE` rather than upsert, because the insert RLS policy only allows the owner.

## Structure

```
src/
  store.js              state, IndexedDB persistence, Supabase sync, send + extract
  db/index.js           Dexie schema (+ one-time migration from the old "echo"/"postlite" databases)
  lib/
    model.js            data factories (collection/folder/request/sample/env)
    variables.js        {{var}} interpolation, dynamic vars, JSON path
    url.js              URL ↔ params sync
    resolve.js          request + env → final request (auth, body)
    http.js             fetch engine (direct/proxy), binary detection
    curl.js             cURL parser
    postman.js          Postman v2.1 import/export
    snippets.js         code snippet generator
    cm.js               CodeMirror extensions (variable highlighting & autocomplete)
    activity.js         tree diff → activity log entries
    publish.js          docs snapshot + secret sanitizing, slug
    theme.js            light/dark theme
  components/           UI (Sidebar, RequestEditor, ResponseViewer, modals)
netlify/edge-functions/
  proxy.js              CORS proxy (POST /api/proxy, target in X-Beacon-* headers)
  mock.js               mock endpoint (reads with the service role key)
supabase/migrations/    SQL schema + RLS (001 base, 002 docs/collaboration, 003 grants, 004 sign-in only, 005 invite message)
tests/                  unit tests (node:test)
```

## Notes

- **localhost:** an HTTPS app cannot reach `http://localhost` through the cloud proxy. Use Direct mode and enable CORS on your local server.
- **Direct mode:** browsers block some headers (`Cookie`, `User-Agent`, `Host`). Use Proxy mode for public APIs that need them.
- **Form-data files** are kept in memory only (not saved or synced). Pick the file again after a reload.
- **The proxy** only accepts requests from the site's own origin and rejects private/localhost addresses, so it cannot be used as an open proxy.
- **Schema:** the `environments` table has an extra `is_global` column (not in the PRD) so Globals are synced too.
