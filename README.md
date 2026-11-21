<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/brand/curlion-logo-dark.svg">
  <img src="public/brand/curlion-logo-light.svg" alt="Curlion" width="300">
</picture>

# Curlion

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
With Supabase configured, Curlion is **sign-in only**: the app, the docs pages and the mock data are not available to anonymous visitors.

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
   - [`006_team_workspace.sql`](supabase/migrations/006_team_workspace.sql): every signed-in user sees and edits every collection; activity history survives collection deletion and includes sign-in/out
   - [`007_shared_environments.sql`](supabase/migrations/007_shared_environments.sql): environments (except Globals) shared with everyone; blanks existing secret values on the server
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
| **GraphQL** requests: Query and Variables editors, schema explorer from introspection (click "Use" to generate an operation), sent via Direct / Proxy / Agent; Postman GraphQL bodies import and export | ✅ |
| **WebSocket**: connect, send text/JSON, saved messages, live message log; subprotocols; through the Agent with custom headers, auth, localhost and self-signed TLS | ✅ |
| **Socket.IO**: connect with path, transport and auth payload, emit events with arguments and ack, every incoming event logged | ✅ |
| **gRPC** (through the Agent): paste or upload a .proto (well-known types built in), pick a method, example message, metadata, TLS; unary, server streaming (replies collected) and client streaming (JSON array); grpcurl snippet | ✅ |
| Direct Browser Mode & Netlify Proxy Mode (localhost is blocked by the proxy, with a clear message) | ✅ |
| **Agent Mode** (like Postman's Desktop Agent): requests go through the Curlion Agent on your computer, so they reach localhost / your local network, skip CORS and can set Cookie/Host/User-Agent | ✅ |
| Live sidebar search (name/folder/URL), request history: clicking an entry opens the request exactly as it was sent (method, URL, params, headers, auth, body) in a tab, to resend, edit or **Save to collection** | ✅ |
| Import Postman Collection v2.1 (folders, auth, body, saved responses → samples, variables → environment) | ✅ |
| Export a collection to Postman v2.1 JSON | ✅ |
| Environments + Globals, switcher, `{{var}}` green/red highlighting + value on hover, `{{` autocomplete | ✅ |
| **Inline variable editing** (like Postman): click a `{{var}}` in any field to edit its current / initial value, add an undefined one to the active environment or Globals, or see what a dynamic variable generates | ✅ |
| **Shared environments** (like Postman): initial values are shared with the team; each user's current values (e.g. extracted tokens) stay in their browser and are never synced. Globals stay private | ✅ |
| Dynamic vars: `$uuid`, `$guid`, `$timestamp`, `$isoTimestamp`, `$randomInt`, `$randomEmail` | ✅ |
| Post-Response Extract (JSON path → your current value of an environment variable), token chaining | ✅ |
| Paste cURL into the URL bar / Import → Raw cURL | ✅ |
| Code snippets: cURL, fetch, Axios, PHP cURL, Guzzle, Go net/http, Python requests | ✅ |
| Sample / example responses + mock URL `/mock/<collection_id>/<sample_id>` | ✅ |
| Supabase Auth (email/password only, accounts created by an admin) + local↔cloud sync of saved changes (3-second debounce, `Ctrl/⌘+S`) | ✅ |
| Secret variables (`is_secret`): masked in the UI, left out of snippets when the mask option is on | ✅ |

## Phase 4 features (PRD §5)

Per collection from the sidebar menu (right-click or `⋯`): **Publish docs** and **Activity log**. The workspace-wide **Activity** dashboard is in the header.

| Feature | Status |
| --- | --- |
| **Publish Docs**: read-only page `/docs/<slug>` for signed-in users (per-folder nav, params, headers, body, auth, sample responses, cURL/JS/PHP/Go/Python snippets + Copy) | ✅ |
| Update published content, change slug, Unpublish | ✅ |
| Local docs preview `/docs/preview/<collection_id>` (no login) | ✅ |
| Per-request (**Docs** tab) and per-collection descriptions | ✅ |
| **Team workspace**: every signed-in user sees and edits every collection; only its creator can delete it or publish its docs (a people icon in the sidebar marks collections created by others) | ✅ |
| **Activity dashboard** (header → Activity): workspace-wide feed grouped by day, filters by period / user / collection / activity / text, per-user summary, CSV export | ✅ |
| **Activity Log**: `CREATE/UPDATE/DELETE_REQUEST`, `CREATE/RENAME/DELETE_FOLDER`, `IMPORT_COLLECTION`, `ADD_MOCK_SAMPLE`, publish/unpublish, create/rename/delete collection, sign-in/sign-out, with a diff summary (e.g. `method: GET → POST`, `url: … → …`) | ✅ |

## Interface

- **Explicit save** (like Postman): edits to a request stay in its tab as unsaved changes (a red dot on the tab, kept across reloads in this browser) until you press **Save** or `Ctrl/⌘+S`; only saved changes sync to the team and appear in the activity log. Adding, renaming, moving and deleting items, and *Save as Sample*, are saved right away. Closing a tab with unsaved changes asks Save / Don't save / Cancel; when closing several, an **Ignore all** button appears after three prompts.
- **Collection overview**: clicking a collection's name in the sidebar opens its overview tab (rename, counts, description, requests by folder, recent activity, quick actions); the chevron only expands/collapses.
- **Multiple tabs** (like Postman): a single click in the sidebar opens a *preview* tab (italic) that the next click replaces; editing, sending or double-clicking keeps it open. Close with × or middle-click, drag to reorder, right-click for Close others / to the right / all. Each tab keeps its own response and can send concurrently. Open tabs are remembered.
- **8 themes**: Ayu, Monokai, Dracula and Tokyo Night, each in a dark and a light variant (Ayu Light, Monokai Light, Alucard, Tokyo Day). Pick one in Settings; the header sun/moon button flips between the dark and light variant of the current palette. Code editors use the matching syntax colours.
- **Settings** (header → sliders icon), saved per browser: interface size, code font family (JetBrains Mono, Fira Code, IBM Plex Mono, Source Code Pro, Roboto Mono, Ubuntu Mono or system; loaded from Google Fonts when picked), font size, font padding (space per line), indentation type (spaces/tabs) and size, and auto-closing of quotes and brackets. Indentation also applies to Beautify and pretty-printed responses.
- **Resizable panes**: drag the sidebar edge or the divider between request and response. Double-click a divider to reset it. Sizes are remembered per browser.

### How it works and design decisions

- **Docs are a sanitized snapshot** stored in the `published_docs` table, not live collection data. Literal tokens, passwords and API keys (in auth, sensitive headers, or `api_key`/`token` query params) are replaced with placeholders. `{{variables}}` are shown by name. Environment values are never published. Docs can be read by any signed-in user who has the link; the anon role has no access to any table (the PRD's `is_public` policy is not used).
- **Sign-in only:** with Supabase configured the app shows a login screen first. Signing out uploads pending changes and then removes that account's data from the browser; if a different account signs in, local data from the previous one is cleared first. The mock endpoint reads with the service role key on the server, since anonymous database access is closed.
- **The activity log is computed from a diff** between the last logged tree and the tree that was just synced. Consecutive changes by one person are merged, roughly one entry per minute per collection. The log is also flushed on `Ctrl/⌘+S`, when the tab is hidden, and on logout. Only changes that actually reached the cloud are recorded.
- **Team workspace:** RLS lets every signed-in user read and update every collection; a trigger keeps `owner_id` unchanged on update, so editing never transfers ownership. Deleting and publishing stay with the creator. Non-creators save with `UPDATE` rather than upsert, because the insert policy only allows creating your own collections. Sync is last-write-wins per collection: if two people edit the same collection at the same time, the later sync wins.
- **Activity history is append-only** (no update/delete policies) and keeps the collection name, so entries survive when a collection is deleted.

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
  proxy.js              CORS proxy (POST /api/proxy, target in X-Curlion-* headers)
  mock.js               mock endpoint (reads with the service role key)
supabase/migrations/    SQL schema + RLS (001 base, 002 docs/collaboration, 003 grants, 004 sign-in only, 005 invite message, 006 team workspace, 007 shared environments)
tests/                  unit tests (node:test)
```

## Curlion Agent (localhost access)

Browsers cannot send requests from a website to your `localhost` without CORS, and the cloud proxy cannot reach your computer at all. The agent is a small zero-dependency Node.js script ([`public/curlion-agent.mjs`](public/curlion-agent.mjs)) that sends requests for Curlion from your machine, like Postman's Desktop Agent.

```bash
# Node.js 18+; the site serves the script at /curlion-agent.mjs
curl -fsSLO https://<your-site>/curlion-agent.mjs
node curlion-agent.mjs --origin https://<your-site>
# local development: npm run agent   (allows http://localhost:5173)
```

Then pick **Agent** in the header (the dot is green when the agent is running; click it again for setup). Chrome may ask to let the site access your local network: choose Allow.

- Listens on `127.0.0.1:5577` only (`--port` to change; set the same port in Curlion's Agent setup).
- Accepts requests only from the `--origin` site(s), checked on every request and CORS preflight; other `Host` headers are rejected (DNS rebinding).
- Follows redirects, decodes gzip/deflate/br, keeps multipart boundaries, accepts self-signed HTTPS certificates (`--strict-tls` to verify them).
- Logs each request in the terminal.
- Also carries **gRPC** calls (HTTP/2, `POST /grpc`) and **WebSocket** connections with custom headers (`/ws/*`, relayed to the browser as Server-Sent Events). Agent 1.1 or newer is needed for these.

## Notes

- **localhost:** the cloud proxy cannot reach `http://localhost`. Use Agent mode, or Direct mode with CORS enabled on your local server.
- **Direct mode:** browsers block some headers (`Cookie`, `User-Agent`, `Host`). Use Agent mode (or Proxy mode for public APIs) when you need them.
- **Form-data files** are kept in memory only (not saved or synced). Pick the file again after a reload.
- **The proxy** only accepts requests from the site's own origin and rejects private/localhost addresses, so it cannot be used as an open proxy.
- **Security headers** (in [`netlify.toml`](netlify.toml)): CSP with `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP and HSTS. `connect-src` stays open (Direct mode calls any API, including `http://localhost`), `script-src` allows `'unsafe-eval'` for protobufjs (gRPC) while inline scripts stay blocked, and `style-src` allows inline styles (Vue, CodeMirror). Hashed `/assets/*` are cached for a year; unknown paths return a real 404 page.
- **Schema:** the `environments` table has an extra `is_global` column (not in the PRD) so Globals are synced too.
