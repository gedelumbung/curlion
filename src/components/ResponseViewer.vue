<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { AlertTriangle, Check, Copy, Download, FileDown, Radio, Save, Square, WrapText, X } from 'lucide-vue-next'
import CodeEditor from './CodeEditor.vue'
import JsonTree from './JsonTree.vue'
import { activeError, activeLoading, activeRequest, activeResponse, activeStream, addSampleNow, cancel, isHistoryId, state, toast } from '../store.js'
import { kv, newSample } from '../lib/model.js'
import { linkParts } from '../lib/links.js'
import { copyText, formatSize, statusColor } from '../lib/ui.js'
import { saveResponseFile } from '../lib/http.js'
import { summarize } from '../lib/assertions.js'
import { indentString } from '../lib/settings.js'

const res = activeResponse
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
  await copyText(view.value === 'raw' ? res.value.body : pretty.value)
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
  <section class="flex min-h-0 flex-col border-t border-zinc-800">
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
        <span class="font-mono text-xs text-zinc-400" :title="res.ttfb !== undefined && res.time - res.ttfb > 50 ? `First byte after ${res.ttfb} ms, then ${res.time - res.ttfb} ms streaming the body` : undefined">{{ res.time }} ms</span>
        <span class="font-mono text-xs text-zinc-400">{{ formatSize(res.size) }}</span>
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
            <button class="ml-auto rounded p-1 hover:bg-zinc-800" :class="wrap ? 'text-orange-400' : 'text-zinc-500'" title="Wrap lines" @click="wrap = !wrap"><WrapText :size="14" /></button>
            <button class="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100" title="Copy" @click="copyBody"><Copy :size="14" /></button>
          </div>
          <div v-if="view === 'tree' && doc !== undefined" class="flex-1 overflow-auto px-4 pb-4">
            <JsonTree :value="doc" />
          </div>
          <div v-else class="min-h-0 flex-1">
            <CodeEditor :model-value="view === 'raw' ? res.body : pretty" :language="view === 'raw' ? 'text' : lang" readonly :variables="false" links :wrap="wrap || view === 'raw'" />
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
