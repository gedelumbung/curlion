<!-- Public, read-only API documentation page: /docs/<slug> (or /docs/preview/<collectionId>). -->
<script setup>
import { computed, onMounted, ref } from 'vue'
import { Check, Copy, Loader2, Lock } from 'lucide-vue-next'
import { supabase } from '../lib/supabase.js'
import { db } from '../db/index.js'
import { buildDocsSnapshot } from '../lib/publish.js'
import { resolveRequest } from '../lib/resolve.js'
import { generateSnippet } from '../lib/snippets.js'
import { methodColor, statusColor } from '../lib/ui.js'

const props = defineProps({
  id: { type: String, required: true }, // slug, or collection id in preview mode
  preview: { type: Boolean, default: false },
})

const loading = ref(true)
const error = ref('')
const doc = ref(null) // { name, description, items, publishedAt }

onMounted(async () => {
  try {
    if (props.preview) {
      const col = await db.collections.get(props.id)
      if (!col) throw new Error('Collection not found in this browser.')
      doc.value = { ...buildDocsSnapshot(col), publishedAt: null }
    } else {
      if (!supabase) throw new Error('This Echo instance is not connected to a database.')
      const { data, error: e } = await supabase.from('published_docs').select('name, description, data, published_at').eq('slug', props.id).maybeSingle()
      if (e) throw e
      if (!data) throw new Error('These docs do not exist or are no longer public.')
      doc.value = { name: data.name, description: data.description, items: data.data?.items || [], publishedAt: data.published_at }
    }
    document.title = `${doc.value.name} · API Docs`
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
  // honour #anchor after content renders
  if (location.hash) requestAnimationFrame(() => document.getElementById(location.hash.slice(1))?.scrollIntoView())
})

/** Requests grouped by folder path, in tree order. */
const groups = computed(() => {
  const out = []
  const walk = (items, path) => {
    const reqs = items.filter((n) => n.type === 'request')
    if (reqs.length) out.push({ path, title: path.join(' / '), requests: reqs })
    for (const f of items.filter((n) => n.type === 'folder')) walk(f.items, [...path, f.name])
  }
  if (doc.value) walk(doc.value.items, [])
  return out
})

const anchor = (r) => 'ep-' + r.id.slice(0, 8)
const paragraphs = (text) => String(text || '').split(/\n\s*\n/).filter((p) => p.trim())

const LANGS = [
  { id: 'curl', label: 'cURL' },
  { id: 'fetch', label: 'JavaScript' },
  { id: 'php-curl', label: 'PHP' },
  { id: 'go', label: 'Go' },
  { id: 'python', label: 'Python' },
]
const lang = ref('curl')
const empty = new Map()
const snippet = (r) => generateSnippet(lang.value, resolveRequest(r, empty, { keepDynamic: true }))

const authLabel = (a) =>
  ({
    bearer: 'Bearer token in the Authorization header',
    basic: 'HTTP Basic auth (username and password)',
    apikey: `API key "${a?.apikey?.key}" in the ${a?.apikey?.in === 'query' ? 'query string' : 'request headers'}`,
  })[a?.type]

const bodyLabel = { 'form-data': 'multipart/form-data', urlencoded: 'application/x-www-form-urlencoded' }
const prettyBody = (s) => {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

const sampleIdx = ref({})
const copied = ref(null)
async function copy(key, text) {
  await navigator.clipboard.writeText(text)
  copied.value = key
  setTimeout(() => copied.value === key && (copied.value = null), 1500)
}

const enabledRows = (rows) => (rows || []).filter((r) => r.enabled !== false && r.key)
</script>

<template>
  <div class="min-h-screen bg-zinc-950 text-zinc-200">
    <div v-if="loading" class="flex h-screen items-center justify-center text-zinc-500"><Loader2 class="animate-spin" /></div>
    <div v-else-if="error" class="flex h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <Lock :size="28" class="text-zinc-600" />
      <p class="text-zinc-300">{{ error }}</p>
      <a href="/" class="text-sm text-orange-400 hover:underline">Open Echo</a>
    </div>

    <template v-else>
      <div v-if="preview" class="sticky top-0 z-20 bg-amber-500/90 px-4 py-1 text-center text-xs font-medium text-black">
        Local preview. This is how the published docs will look. Nothing here is public until you publish.
      </div>
      <div class="mx-auto flex max-w-7xl">
        <!-- Nav -->
        <nav class="sticky top-0 hidden h-screen w-64 shrink-0 overflow-y-auto border-r border-zinc-800 p-4 text-sm lg:block">
          <a href="#top" class="mb-4 block font-semibold text-zinc-100">{{ doc.name }}</a>
          <div v-for="g in groups" :key="g.title" class="mb-3">
            <p v-if="g.title" class="mb-1 text-xs font-medium tracking-wide text-zinc-500 uppercase">{{ g.title }}</p>
            <a v-for="r in g.requests" :key="r.id" :href="'#' + anchor(r)" class="flex items-center gap-2 rounded px-2 py-1 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100">
              <span class="w-12 shrink-0 font-mono text-[10px] font-bold" :class="methodColor[r.method]">{{ r.method }}</span>
              <span class="truncate">{{ r.name }}</span>
            </a>
          </div>
        </nav>

        <!-- Content -->
        <main id="top" class="min-w-0 flex-1 px-4 py-8 sm:px-8">
          <header class="mb-10 border-b border-zinc-800 pb-8">
            <h1 class="text-3xl font-bold text-zinc-100">{{ doc.name }}</h1>
            <p v-for="(p, i) in paragraphs(doc.description)" :key="i" class="mt-3 max-w-3xl whitespace-pre-line text-zinc-400">{{ p }}</p>
            <p class="mt-4 text-xs text-zinc-600">
              {{ groups.reduce((n, g) => n + g.requests.length, 0) }} endpoints
              <template v-if="doc.publishedAt"> · updated {{ new Date(doc.publishedAt).toLocaleDateString() }}</template>
              · <span v-pre>{{variables}}</span> are placeholders you fill in yourself
            </p>
            <div class="mt-4 flex flex-wrap gap-1 text-xs">
              <span class="mr-1 self-center text-zinc-500">Code samples:</span>
              <button v-for="l in LANGS" :key="l.id" class="rounded px-2.5 py-1" :class="lang === l.id ? 'bg-orange-500 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-100'" @click="lang = l.id">{{ l.label }}</button>
            </div>
          </header>

          <section v-for="g in groups" :key="g.title" class="mb-12">
            <h2 v-if="g.title" class="mb-6 text-xl font-semibold text-zinc-100">{{ g.title }}</h2>

            <article v-for="r in g.requests" :id="anchor(r)" :key="r.id" class="mb-12 grid scroll-mt-6 gap-6 xl:grid-cols-2">
              <div class="min-w-0">
                <h3 class="text-lg font-semibold text-zinc-100">{{ r.name }}</h3>
                <div class="mt-2 flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-[13px]">
                  <span class="font-bold" :class="methodColor[r.method]">{{ r.method }}</span>
                  <span class="min-w-0 break-all text-zinc-300">{{ r.url }}</span>
                </div>
                <p v-for="(p, i) in paragraphs(r.description)" :key="i" class="mt-3 whitespace-pre-line text-sm text-zinc-400">{{ p }}</p>

                <p v-if="authLabel(r.auth)" class="mt-4 text-sm"><span class="text-zinc-500">Auth:</span> {{ authLabel(r.auth) }}</p>

                <template v-for="block in [
                  { title: 'Query parameters', rows: enabledRows(r.params) },
                  { title: 'Headers', rows: enabledRows(r.headers) },
                ]" :key="block.title">
                  <div v-if="block.rows.length" class="mt-5">
                    <h4 class="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase">{{ block.title }}</h4>
                    <table class="w-full text-sm">
                      <tr v-for="row in block.rows" :key="row.id" class="border-t border-zinc-800 align-top">
                        <td class="w-1/3 py-1.5 pr-3 font-mono text-[13px] text-zinc-200">{{ row.key }}</td>
                        <td class="py-1.5 font-mono text-[13px] break-all text-zinc-400">
                          {{ row.value }}
                          <span v-if="row.description" class="block font-sans text-xs text-zinc-500">{{ row.description }}</span>
                        </td>
                      </tr>
                    </table>
                  </div>
                </template>

                <div v-if="r.body && r.body.mode !== 'none'" class="mt-5">
                  <h4 class="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase">
                    Body <span class="normal-case">· {{ r.body.mode === 'raw' ? r.body.rawType.toUpperCase() : bodyLabel[r.body.mode] }}</span>
                  </h4>
                  <pre v-if="r.body.mode === 'raw'" class="overflow-x-auto rounded border border-zinc-800 bg-zinc-900 p-3 font-mono text-[12.5px] text-zinc-300">{{ prettyBody(r.body.raw) }}</pre>
                  <table v-else class="w-full text-sm">
                    <tr v-for="f in enabledRows(r.body.mode === 'form-data' ? r.body.formData : r.body.urlencoded)" :key="f.id" class="border-t border-zinc-800">
                      <td class="w-1/3 py-1.5 pr-3 font-mono text-[13px] text-zinc-200">{{ f.key }}</td>
                      <td class="py-1.5 font-mono text-[13px] text-zinc-400">{{ f.type === 'file' ? '(file)' : f.value }}</td>
                    </tr>
                  </table>
                </div>
              </div>

              <div class="min-w-0 space-y-4">
                <div class="overflow-hidden rounded border border-zinc-800">
                  <div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-400">
                    <span>{{ LANGS.find((l) => l.id === lang).label }}</span>
                    <button class="inline-flex items-center gap-1 hover:text-zinc-100" @click="copy('code-' + r.id, snippet(r))">
                      <Check v-if="copied === 'code-' + r.id" :size="12" class="text-emerald-400" /><Copy v-else :size="12" /> Copy
                    </button>
                  </div>
                  <pre class="max-h-96 overflow-auto bg-zinc-950 p-3 font-mono text-[12px] leading-relaxed text-zinc-300">{{ snippet(r) }}</pre>
                </div>

                <div v-if="r.samples?.length" class="overflow-hidden rounded border border-zinc-800">
                  <div class="flex flex-wrap gap-1 border-b border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs">
                    <span class="self-center px-1 text-zinc-500">Response</span>
                    <button
                      v-for="(s, i) in r.samples"
                      :key="s.id"
                      class="rounded px-2 py-0.5"
                      :class="(sampleIdx[r.id] || 0) === i ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'"
                      @click="sampleIdx[r.id] = i"
                    >
                      <span class="font-mono" :class="statusColor(s.status)">{{ s.status }}</span> {{ s.name }}
                    </button>
                  </div>
                  <pre class="max-h-96 overflow-auto bg-zinc-950 p-3 font-mono text-[12px] text-zinc-300">{{ prettyBody(r.samples[sampleIdx[r.id] || 0].body) }}</pre>
                </div>
              </div>
            </article>
          </section>

          <p v-if="!groups.length" class="text-zinc-500">This collection has no requests yet.</p>
          <footer class="mt-16 border-t border-zinc-800 pt-6 text-xs text-zinc-600">Published with Echo</footer>
        </main>
      </div>
    </template>
  </div>
</template>
