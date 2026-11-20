# PostLite

API client berbasis web (alternatif ringan Postman) dengan **local-first storage** (IndexedDB), sinkronisasi opsional ke **Supabase**, serta **Netlify Edge Functions** untuk CORS proxy dan mock endpoint. Target biaya: $0 (free tier).

Stack: Vue 3 + Vite, Tailwind CSS v4, CodeMirror 6, Dexie.js, `@supabase/supabase-js`, Lucide icons.

## Menjalankan secara lokal

```bash
npm install
npm run dev        # http://localhost:5173 (mode lokal, tanpa login)
npm test           # unit test: cURL parser, URL/params, variabel, Postman import/export, snippet
npm run build
```

Tanpa `.env`, aplikasi berjalan **local only**: semua data tersimpan di IndexedDB browser.

Untuk mencoba **Proxy mode** dan **mock endpoint** secara lokal, pakai Netlify CLI:

```bash
npm i -g netlify-cli
netlify dev        # menjalankan Vite + edge functions di /api/proxy dan /mock/*
```

## Setup cloud (opsional)

1. Buat project di [Supabase](https://supabase.com), lalu jalankan berurutan di SQL Editor:
   [`001_init.sql`](supabase/migrations/001_init.sql) (tabel + RLS) dan [`002_phase4_docs_collab.sql`](supabase/migrations/002_phase4_docs_collab.sql) (docs publik, RPC kolaborasi).
2. Salin `.env.example` ke `.env`, lalu isi `VITE_SUPABASE_URL` dan `VITE_SUPABASE_ANON_KEY`.
3. (Opsional) Aktifkan provider OAuth GitHub/Google di Supabase → Authentication → Providers, dan tambahkan URL situs ke Redirect URLs.
4. Deploy ke Netlify (build `npm run build`, publish `dist`; sudah diatur di [`netlify.toml`](netlify.toml)). Set env vars di Netlify:
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (untuk build frontend)
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY` (untuk edge function mock)
   - `SUPABASE_SERVICE_ROLE_KEY` (opsional). Dengan key ini mock membaca data live dari collection mana pun yang sudah tersinkron. Tanpa key ini, mock membaca snapshot docs yang sudah dipublish.

## Fitur (MVP, PRD §4)

| Fitur | Status |
| --- | --- |
| CRUD request/folder/collection, duplikat, rename, drag & drop | ✅ |
| Method GET/POST/PUT/PATCH/DELETE/OPTIONS/HEAD | ✅ |
| Params ↔ URL bar (sinkron dua arah), Headers (autocomplete), Auth (Bearer/Basic/API Key header/query) | ✅ |
| Body: none, form-data (text/file), x-www-form-urlencoded, raw (JSON/Text/XML/HTML) | ✅ |
| Response: status berwarna, ms, ukuran, headers, Pretty/Tree/Raw, Copy | ✅ |
| Send and Download + deteksi otomatis respons biner (`Content-Disposition`, pdf/zip/gambar) | ✅ |
| Direct Browser Mode & Netlify Proxy Mode (localhost diblokir di proxy, dengan pesan jelas) | ✅ |
| Live search sidebar (nama/folder/URL), History request | ✅ |
| Import Postman Collection v2.1 (folder, auth, body, saved responses → samples, variables → environment) | ✅ |
| Export collection ke Postman v2.1 JSON | ✅ |
| Environments + Globals, switcher, `{{var}}` hijau/merah + nilai saat hover, autocomplete `{{` | ✅ |
| Dynamic vars: `$uuid`, `$guid`, `$timestamp`, `$isoTimestamp`, `$randomInt`, `$randomEmail` | ✅ |
| Post-Response Extract (JSON path → variabel environment), chaining token | ✅ |
| Paste cURL di URL bar / Import → Raw cURL | ✅ |
| Code snippet: cURL, fetch, Axios, PHP cURL, Guzzle, Go net/http, Python requests | ✅ |
| Sample / Example response + URL mock publik `/mock/<collection_id>/<sample_id>` | ✅ |
| Supabase Auth (email/password, GitHub, Google) + sync local↔cloud (debounce 3 detik, `Ctrl/⌘+S`) | ✅ |
| Variabel secret (`is_secret`): disamarkan di UI, tidak ikut di snippet bila opsi mask aktif | ✅ |

## Fitur Fase 4 (PRD §5)

Semua diakses dari menu collection di sidebar (klik kanan atau `⋯`): **Share & members**, **Publish docs**, **Activity log**.

| Fitur | Status |
| --- | --- |
| **Publish Docs**: halaman publik read-only `/docs/<slug>` (nav per folder, params, headers, body, auth, sample response, snippet cURL/JS/PHP/Go/Python + Copy) | ✅ |
| Update konten publikasi, ganti slug, Unpublish | ✅ |
| Preview docs lokal `/docs/preview/<collection_id>` (tanpa login) | ✅ |
| Deskripsi per request (tab **Docs**) dan per collection | ✅ |
| Undang anggota via email sebagai **Viewer** / **Editor**, ganti role, hapus anggota, keluar dari collection | ✅ |
| Viewer: read-only (tidak tersinkron, menu edit disembunyikan), badge "shared" di sidebar | ✅ |
| **Activity Log**: `CREATE/UPDATE/DELETE_REQUEST`, `CREATE/RENAME/DELETE_FOLDER`, `IMPORT_COLLECTION`, `ADD_MOCK_SAMPLE`, publish/unpublish, tambah/hapus anggota, dengan ringkasan diff (mis. `method: GET → POST`, `url: … → …`) | ✅ |

### Cara kerja dan keputusan desain

- **Docs adalah snapshot yang disanitasi** di tabel `published_docs`, bukan data live collection. Token, password, dan API key literal (di auth, header sensitif, atau query `api_key`/`token`) diganti placeholder. `{{variabel}}` tetap tampil sebagai nama. Nilai environment tidak pernah dipublish. Karena itu policy `is_public` dari PRD untuk `collections` diganti: tabel `collections` tidak bisa dibaca anonim sama sekali.
- **Activity log dihitung dari diff** antara tree terakhir yang dicatat dan tree yang sudah tersinkron. Perubahan beruntun dari satu orang digabung, sekitar satu entri per menit per collection. Log juga di-flush saat `Ctrl/⌘+S`, saat tab disembunyikan, dan saat logout. Hanya perubahan yang benar-benar sampai ke cloud yang tercatat.
- **Undang via email** memakai RPC `invite_collection_member` (security definer), karena `auth.users` tidak bisa dibaca dari client. Orang yang diundang harus sudah punya akun.
- Editor menyimpan perubahan dengan `UPDATE`, bukan upsert, karena RLS insert hanya mengizinkan pemilik.

## Struktur

```
src/
  store.js              state, persistensi IndexedDB, sync Supabase, send + extract
  db/index.js           skema Dexie
  lib/
    model.js            factory data (collection/folder/request/sample/env)
    variables.js        interpolasi {{var}}, dynamic vars, JSON path
    url.js              sinkron URL ↔ params
    resolve.js          request + env → request final (auth, body)
    http.js             engine fetch (direct/proxy), deteksi biner
    curl.js             parser cURL
    postman.js          import/export Postman v2.1
    snippets.js         generator code snippet
    cm.js               ekstensi CodeMirror (highlight & autocomplete variabel)
    activity.js         diff tree → entri activity log
    publish.js          snapshot docs + sanitasi secret, slug
  components/           UI (Sidebar, RequestEditor, ResponseViewer, modal-modal)
netlify/edge-functions/
  proxy.js              CORS proxy (POST /api/proxy, target di header X-PostLite-*)
  mock.js               mock endpoint publik
supabase/migrations/    skema SQL + RLS (001 dasar, 002 docs/kolaborasi)
tests/                  unit test (node:test)
```

## Catatan

- **localhost:** aplikasi HTTPS tidak bisa menjangkau `http://localhost` lewat proxy cloud. Gunakan Direct mode dan aktifkan CORS di server lokal.
- **Direct mode:** browser memblokir beberapa header (`Cookie`, `User-Agent`, `Host`). Gunakan Proxy mode untuk API publik yang membutuhkannya.
- **File form-data** hanya disimpan di memori (tidak ikut tersimpan/tersinkron). Pilih ulang file setelah reload.
- **Proxy** hanya menerima request dari origin situs itu sendiri dan menolak alamat privat/localhost, agar tidak menjadi open proxy.
- **Skema:** tabel `environments` mendapat tambahan kolom `is_global` (di luar PRD) agar Globals ikut tersinkron.
