<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { AlertTriangle, CaseSensitive, Check, ChevronDown, ChevronUp, Copy, Download, FileDown, GitCompareArrows, ListFilter, Radio, Regex, Save, Search, Square, WholeWord, WrapText, X } from 'lucide-vue-next'
import CodeEditor from './CodeEditor.vue'
import JsonTree from './JsonTree.vue'
import ResponseMeta from './ResponseMeta.vue'
import { activeError, activeLoading, activeRequest, activeResponse, activeStream, addSampleNow, cancel, isHistoryId, state, toast } from '../store.js'
import { kv, newSample } from '../lib/model.js'
import { linkParts } from '../lib/links.js'
import { copyText, formatSize, statusColor } from '../lib/ui.js'
import { saveResponseFile } from '../lib/http.js'
import { summarize } from '../lib/assertions.js'
import { filterLines, queryJsonPath } from '../lib/jsonpath.js'
import { indentString } from '../lib/settings.js'

const res = activeResponse
const emit = defineEmits(['compare'])
const tab = ref('body')
const view = ref('pretty') // pretty | tree | raw
const wrap = ref(false)

/** JSON body, or the parsed lines of an NDJSON / JSON Lines body (shown as an array in Tree). */
const doc = computed(() => (res.value?.json !== undefined ? res.value.json : res.value?.lines))
const lang = computed(() => {
  const ct = res.value?.contentType || ''
  if (doc.value !== undefined) return 'json'
  return /xml/.test(ct) ? 'xml' : /html/.test(ct) ? 'html' : 'text'
})
const pretty = computed(() => {
  if (!res.value) return ''
  if (res.value.json !== undefined) return JSON.stringify(res.value.json, null, indentString())
  if (res.value.lines) return res.value.lines.map((l) => JSON.stringify(l, null, indentString())).join('\n') // one pretty block per line
  return res.value.body
})

// ---- filter: JSONPath on JSON (and NDJSON lines), or matching lines of any text -----------
const filterOpen = ref(false)
const filterQuery = ref('')
const filterMode = ref('jsonpath') // jsonpath | text
const filterInput = ref(null)
function openFilter() {
  if (!filterOpen.value) filterMode.value = doc.value !== undefined ? 'jsonpath' : 'text'
  filterOpen.value = true
  tab.value = 'body'
  nextTick(() => filterInput.value?.focus())
}
function closeFilter() {
  filterOpen.value = false
}
const filtered = computed(() => {
  const q = filterQuery.value.trim()
  if (!filterOpen.value || !q || !res.value || res.value.binary) return null
  try {
    if (filterMode.value === 'jsonpath') {
      if (doc.value === undefined) return { error: 'The response is not JSON: use the Text filter.' }
      const { nodes, definite } = queryJsonPath(doc.value, q)
      // one exact path shows its value; anything else shows the list of matches
      const value = definite ? nodes[0]?.value : nodes.map((n) => n.value)
      const empty = !nodes.length
      return { value, empty, label: `${nodes.length} match${nodes.length === 1 ? '' : 'es'}`, text: empty ? '' : JSON.stringify(value, null, indentString()), raw: empty ? '' : JSON.stringify(value), lang: 'json', paths: nodes.map((n) => n.path) }
    }
    const { lines, total } = filterLines(view.value === 'raw' ? res.value.body : pretty.value, q)
    return { empty: !lines.length, label: `${lines.length} of ${total} lines`, text: lines.join('\n'), raw: lines.join('\n'), lang: 'text' }
  } catch (e) {
    return { error: e.message }
  }
})
const active = computed(() => (filtered.value && !filtered.value.error ? filtered.value : null))
/** What the body pane shows: the filter result, or the whole body. */
const shownText = computed(() => (active.value ? (view.value === 'raw' ? active.value.raw : active.value.text) : view.value === 'raw' ? res.value.body : pretty.value))
const shownLang = computed(() => (view.value === 'raw' ? 'text' : active.value ? active.value.lang : lang.value))
const treeValue = computed(() => (active.value && filterMode.value === 'jsonpath' ? active.value.value : doc.value))

// ---- search inside the body (highlights in the editor; Enter / Shift+Enter to move) -------------
const searchOpen = ref(false)
const searchText = ref('')
const searchOpts = reactive({ caseSensitive: false, wholeWord: false, regexp: false })
const matches = ref({ count: 0, index: -1, error: null, capped: false })
const editor = ref(null)
const searchInput = ref(null)
function openSearch() {
  if (!res.value || res.value.binary) return
  searchOpen.value = true
  tab.value = 'body'
  if (view.value === 'tree') view.value = 'pretty' // the tree has no text to search
  nextTick(() => {
    searchInput.value?.focus()
    searchInput.value?.select()
  })
}
function closeSearch() {
  searchOpen.value = false
}
const runSearch = () => editor.value?.search(searchOpen.value && searchText.value ? { text: searchText.value, ...searchOpts } : null)
watch([searchText, searchOpen, () => ({ ...searchOpts }), editor], runSearch)
const step = (dir) => editor.value?.step(dir)
const searchLabel = computed(() => {
  const m = matches.value
  if (!searchText.value) return ''
  if (m.error) return m.error
  return m.count ? `${m.index + 1} of ${m.count}${m.capped ? '+' : ''}` : 'No results'
})
/** Ctrl/⌘+F anywhere in the response pane opens the search bar instead of the browser's. */
function onKeydown(e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && res.value && !res.value.binary) {
    e.preventDefault()
    openSearch()
  }
}

// ---- live view while the body streams in ---------------------------------------------
const live = activeStream
const LIVE_TAIL = 200_000 // characters kept on screen; the full body is shown when it completes
const liveText = computed(() => {
  const t = live.value?.text || ''
  return t.length > LIVE_TAIL ? `… (${formatSize(t.length - LIVE_TAIL)} earlier not shown while streaming)\n` + t.slice(-LIVE_TAIL) : t
})
const liveLines = computed(() => {
  const t = live.value?.text || ''
  let n = 0
  for (let i = t.indexOf('\n'); i !== -1; i = t.indexOf('\n', i + 1)) n++
  return n
})
const now = ref(Date.now())
let clock = null
watch(
  () => !!live.value,
  (on) => {
    clearInterval(clock)
    if (on) clock = setInterval(() => (now.value = Date.now()), 100)
  },
  { immediate: true },
)
onBeforeUnmount(() => clearInterval(clock))
const elapsed = computed(() => (live.value ? Math.max(0, (now.value - live.value.startedAt) / 1000).toFixed(1) : '0.0'))
// follow the end of the stream unless the user scrolled up
const livePre = ref(null)
watch(liveText, async () => {
  const el = livePre.value
  const atBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40
  await nextTick()
  if (atBottom && livePre.value) livePre.value.scrollTop = livePre.value.scrollHeight
})

const wrapVar = (name) => '{' + '{' + name + '}' + '}'
const testSummary = computed(() => (res.value?.tests?.length ? summarize(res.value.tests) : null))
const tabs = computed(() => ['body', 'headers', ...(testSummary.value ? ['tests'] : [])])
watch(testSummary, (s) => !s && tab.value === 'tests' && (tab.value = 'body'))

async function saveAgain() {
  const r = res.value
  const how = await saveResponseFile(r.downloadUrl, r.fileName)
  if (how !== 'cancelled') toast(how === 'saved' ? `Saved ${r.fileName}` : `Downloading ${r.fileName}…`, 'success', 2000)
}

async function copyBody() {
  await copyText(view.value === 'tree' ? JSON.stringify(treeValue.value, null, indentString()) : shownText.value)
  toast('Response copied', 'success', 1500)
}

function saveAsSample() {
  const r = res.value
  const s = newSample(`${r.status} ${r.statusText || 'Response'}`.trim(), {
    status: r.status,
    headers: r.headers.filter((h) => /^(content-type|cache-control|location|x-)/i.test(h.key)).map((h) => kv(h.key, h.value)),
    body: pretty.value,
  })
  addSampleNow(activeRequest.value.id, s)
  toast('Saved as sample. See the "Samples / Mock" tab.', 'success')
}
</script>

<template>
  <section class="flex min-h-0 flex-col border-t border-zinc-800" @keydown="onKeydown">
    <!-- Status line -->
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-sm">
      <span class="font-medium text-zinc-300">Response</span>
      <template v-if="activeLoading && live">
        <span class="inline-flex items-center gap-1.5 text-xs text-sky-400"><Radio :size="13" class="animate-pulse" /> Receiving…</span>
        <span class="ml-auto font-mono text-xs" :class="statusColor(live.status)">{{ live.status }} {{ live.statusText }}</span>
        <span class="font-mono text-xs text-zinc-400">{{ elapsed }} s</span>
        <span class="font-mono text-xs text-zinc-400">{{ formatSize(live.bytes) }}</span>
        <span v-if="liveLines > 1" class="font-mono text-xs text-zinc-400">{{ liveLines }} lines</span>
        <button class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Stop and keep what has arrived" @click="cancel()"><Square :size="12" /> Stop</button>
      </template>
      <template v-else-if="res">
        <nav class="flex gap-1 text-xs">
          <button v-for="t in tabs" :key="t" class="rounded px-2 py-1 capitalize" :class="tab === t ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'" @click="tab = t">
            {{ t }}<span v-if="t === 'headers'" class="ml-1 text-zinc-500">{{ res.headers.length }}</span>
            <span v-if="t === 'tests'" class="ml-1" :class="testSummary.failed ? 'text-red-400' : 'text-emerald-400'">{{ testSummary.passed }}/{{ testSummary.total }}</span>
          </button>
        </nav>
        <span class="ml-auto font-mono text-xs" :class="statusColor(res.status, res.grpc)" :title="res.grpc && res.message ? res.message : undefined">{{ res.status }} {{ res.statusText }}</span>
        <span v-if="res.lines" class="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-400" title="Newline-delimited JSON: one JSON value per line">NDJSON · {{ res.lines.length }} lines</span>
        <span v-if="res.aborted" class="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-400" title="Stopped before the response finished: the body is what had arrived">stopped · partial</span>
        <ResponseMeta v-if="!res.grpc" :res="res" />
        <template v-else>
          <span class="font-mono text-xs text-zinc-400">{{ res.time }} ms</span>
          <span class="font-mono text-xs text-zinc-400">{{ formatSize(res.size) }}</span>
        </template>
        <button v-if="!res.binary" class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Compare with an earlier response, a sample or another tab" @click="emit('compare')">
          <GitCompareArrows :size="13" /> Compare
        </button>
        <button v-if="!isHistoryId(activeRequest?.id) && !res.grpc" class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Save as Sample / Mock" @click="saveAsSample">
          <Save :size="13" /> Save as Sample
        </button>
      </template>
    </div>

    <!-- Extract results -->
    <div v-if="res?.extracted?.length" class="flex flex-wrap gap-2 px-4 pb-2 text-xs">
      <span v-for="x in res.extracted" :key="x.variable" class="inline-flex items-center gap-1 rounded px-2 py-0.5" :class="x.ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'">
        <Check v-if="x.ok" :size="12" /><AlertTriangle v-else :size="12" />
        {{ wrapVar(x.variable) }} {{ x.ok ? `set in ${x.env}` : x.message }}
      </span>
    </div>

    <div class="min-h-0 flex-1 overflow-auto">
      <div v-if="activeLoading && live" class="flex h-full min-h-0 flex-col">
        <p v-if="/event-stream/i.test(live.contentType)" class="px-4 pb-1 text-xs text-zinc-500">This is an event stream. Set the request type to <b>SSE</b> to see parsed events.</p>
        <pre ref="livePre" class="min-h-0 flex-1 overflow-auto px-4 pb-4 font-mono text-[12px] whitespace-pre-wrap break-all text-zinc-300">{{ liveText }}<span class="animate-pulse text-sky-400">▍</span></pre>
      </div>
      <div v-else-if="activeLoading" class="flex h-full items-center justify-center text-sm text-zinc-500">Sending request…</div>
      <div v-else-if="activeError" class="m-4 rounded border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
        <p class="font-medium">Could not get a response</p>
        <p class="mt-1 text-red-300/80">{{ activeError }}</p>
      </div>
      <div v-else-if="!res" class="flex h-full items-center justify-center p-6 text-center text-sm text-zinc-600">
        Click Send to get a response. Tip: paste a cURL command into the URL bar.
      </div>

      <template v-else-if="tab === 'body'">
        <div v-if="res.binary" class="flex flex-col items-center gap-3 p-6 text-sm text-zinc-400">
          <FileDown :size="32" class="text-orange-400" />
          <p>Response saved as <span class="font-mono text-zinc-200">{{ res.fileName }}</span></p>
          <p class="text-xs text-zinc-600">{{ res.contentType }} · {{ formatSize(res.size) }}</p>
          <button
            v-if="res.downloadUrl"
            class="inline-flex items-center gap-1.5 rounded-md bg-orange-500 px-3 py-1.5 text-xs font-semibold text-on-accent hover:bg-orange-600"
            @click="saveAgain"
          >
            <Download :size="13" /> Save file…
          </button>
          <p v-if="res.saved === 'cancelled'" class="text-xs text-zinc-600">Save was cancelled.</p>
          <img v-if="res.previewUrl" :src="res.previewUrl" class="max-h-64 rounded border border-zinc-800" alt="Response preview" />
        </div>
        <div v-else class="flex h-full flex-col">
          <div class="flex items-center gap-1 px-4 pb-1 text-xs">
            <button v-for="v in ['pretty', 'tree', 'raw']" :key="v" class="rounded px-2 py-0.5 capitalize" :class="view === v ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'" :disabled="v === 'tree' && doc === undefined" @click="view = v">
              {{ v }}
            </button>
            <button class="ml-auto rounded p-1 hover:bg-zinc-800" :class="filterOpen ? 'text-orange-400' : 'text-zinc-500 hover:text-zinc-100'" title="Filter (JSONPath or text)" @click="filterOpen ? closeFilter() : openFilter()"><ListFilter :size="14" /></button>
            <button class="rounded p-1 hover:bg-zinc-800" :class="searchOpen ? 'text-orange-400' : 'text-zinc-500 hover:text-zinc-100'" title="Search (Ctrl/⌘+F)" @click="searchOpen ? closeSearch() : openSearch()"><Search :size="14" /></button>
            <button class="rounded p-1 hover:bg-zinc-800" :class="wrap ? 'text-orange-400' : 'text-zinc-500'" title="Wrap lines" @click="wrap = !wrap"><WrapText :size="14" /></button>
            <button class="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100" :title="active ? 'Copy the filtered result' : 'Copy'" @click="copyBody"><Copy :size="14" /></button>
          </div>

          <!-- Filter -->
          <div v-if="filterOpen" class="flex flex-wrap items-center gap-2 px-4 pb-2 text-xs">
            <span class="flex rounded border border-zinc-700 p-0.5">
              <button v-for="m in [{ id: 'jsonpath', label: 'JSONPath' }, { id: 'text', label: 'Text' }]" :key="m.id" class="rounded px-2 py-0.5" :class="filterMode === m.id ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'" :disabled="m.id === 'jsonpath' && doc === undefined" :title="m.id === 'jsonpath' ? (doc === undefined ? 'The response is not JSON' : 'Select parts of the JSON') : 'Keep only lines that contain the text, or match /regex/'" @click="filterMode = m.id">{{ m.label }}</button>
            </span>
            <input
              ref="filterInput"
              v-model="filterQuery"
              class="min-w-40 flex-1 rounded border bg-zinc-900 px-2 py-1 font-mono text-[12px] outline-none"
              :class="filtered?.error ? 'border-red-800 focus:border-red-600' : 'border-zinc-700 focus:border-zinc-500'"
              :placeholder="filterMode === 'jsonpath' ? '$.data[*].id   ·   $..items[?(@.price > 10)]   ·   data.user.email' : 'text, or /regex/i'"
              spellcheck="false"
              @keydown.esc="closeFilter"
            />
            <span v-if="filtered?.error" class="max-w-72 truncate text-red-400" :title="filtered.error">{{ filtered.error }}</span>
            <span v-else-if="filtered" class="text-zinc-400">{{ filtered.label }}</span>
            <button class="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100" title="Close filter (Esc)" @click="closeFilter"><X :size="13" /></button>
          </div>

          <!-- Search -->
          <div v-if="searchOpen" class="flex flex-wrap items-center gap-1 px-4 pb-2 text-xs">
            <div class="flex min-w-40 flex-1 items-center rounded border bg-zinc-900 pr-1 focus-within:border-zinc-500" :class="matches.error ? 'border-red-800' : 'border-zinc-700'">
              <Search :size="13" class="ml-2 shrink-0 text-zinc-500" />
              <input
                ref="searchInput"
                v-model="searchText"
                class="min-w-0 flex-1 bg-transparent px-2 py-1 font-mono text-[12px] outline-none"
                placeholder="Search the body"
                spellcheck="false"
                @keydown.enter.exact.prevent="step(1)"
                @keydown.shift.enter.prevent="step(-1)"
                @keydown.esc="closeSearch"
              />
              <button v-for="o in [{ key: 'caseSensitive', icon: CaseSensitive, title: 'Match case' }, { key: 'wholeWord', icon: WholeWord, title: 'Whole word' }, { key: 'regexp', icon: Regex, title: 'Regular expression' }]" :key="o.key" class="rounded p-0.5" :class="searchOpts[o.key] ? 'bg-orange-500/20 text-orange-400' : 'text-zinc-500 hover:text-zinc-200'" :title="o.title" @click="searchOpts[o.key] = !searchOpts[o.key]">
                <component :is="o.icon" :size="15" />
              </button>
            </div>
            <span class="min-w-16 px-1 text-center" :class="matches.error || (searchText && !matches.count) ? 'text-red-400' : 'text-zinc-400'">{{ view === 'tree' ? 'Pretty or Raw only' : searchLabel }}</span>
            <button class="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40" title="Previous (Shift+Enter)" :disabled="!matches.count" @click="step(-1)"><ChevronUp :size="14" /></button>
            <button class="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40" title="Next (Enter)" :disabled="!matches.count" @click="step(1)"><ChevronDown :size="14" /></button>
            <button class="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100" title="Close search (Esc)" @click="closeSearch"><X :size="13" /></button>
          </div>

          <p v-if="active?.empty" class="px-4 py-8 text-center text-sm text-zinc-500">Nothing matches the filter.</p>
          <div v-else-if="view === 'tree' && doc !== undefined" class="flex-1 overflow-auto px-4 pb-4">
            <JsonTree :value="treeValue" />
          </div>
          <div v-else class="min-h-0 flex-1">
            <CodeEditor ref="editor" :model-value="shownText" :language="shownLang" readonly :variables="false" links find-key :wrap="wrap || view === 'raw'" @find="openSearch" @matches="matches = $event" />
          </div>
        </div>
      </template>

      <ul v-else-if="tab === 'tests' && res.tests?.length" class="divide-y divide-zinc-800 text-sm">
        <li v-for="t in res.tests" :key="t.id" class="flex items-start gap-2 px-4 py-2">
          <Check v-if="t.ok" :size="15" class="mt-0.5 shrink-0 text-emerald-400" /><X v-else :size="15" class="mt-0.5 shrink-0 text-red-400" />
          <span class="min-w-0 flex-1">
            <span :class="t.ok ? 'text-zinc-200' : 'text-red-300'">{{ t.name }}</span>
            <span class="ml-2 font-mono text-xs break-all text-zinc-500">{{ t.message }}</span>
          </span>
        </li>
      </ul>

      <table v-else class="w-full text-sm">
        <tbody>
          <tr v-for="(h, i) in res.headers" :key="i" class="border-t border-zinc-800">
            <td class="w-1/3 px-4 py-1.5 align-top font-mono text-[13px] text-zinc-400">{{ h.key }}</td>
            <td class="px-4 py-1.5 font-mono text-[13px] break-all text-zinc-200"><template v-for="(p, j) in linkParts(h.value)" :key="j"><a v-if="p.url" :href="p.url" target="_blank" rel="noopener noreferrer" class="underline decoration-current/45 underline-offset-2 hover:decoration-current" :title="`Open ${p.url} in a new tab`">{{ p.text }}</a><template v-else>{{ p.text }}</template></template></td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
