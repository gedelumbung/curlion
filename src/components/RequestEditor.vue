<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ChevronDown, Code2, Download, Loader2, Play, Plug, Plus, Save, Send, Trash2, Unplug, Wand2 } from 'lucide-vue-next'
import VarInput from './VarInput.vue'
import UiSelect from './UiSelect.vue'
import { indentString } from '../lib/settings.js'
import KeyValueEditor from './KeyValueEditor.vue'
import CodeEditor from './CodeEditor.vue'
import SamplesPanel from './SamplesPanel.vue'
import AuthEditor from './AuthEditor.vue'
import TestsPanel from './TestsPanel.vue'
import GraphqlPanel from './GraphqlPanel.vue'
import RealtimePanel from './RealtimePanel.vue'
import GrpcPanel from './GrpcPanel.vue'
import { parseProto } from '../lib/grpc.js'
import { activeLoading, activeRequest, activeResponse, ancestorsFor, cancel, connectRealtime, disconnectRealtime, isDirty, isHistoryId, keepTab, persistDrafts, saveNow, send, state, toast } from '../store.js'
import { METHODS, PROTOCOLS, ensureProtocol, protocolOf, uid } from '../lib/model.js'
import { inheritedHeaders } from '../lib/resolve.js'
import { paramsFromUrl, urlFromParams } from '../lib/url.js'
import { looksLikeCurl, parseCurl } from '../lib/curl.js'
import { getByPath } from '../lib/variables.js'
import { methodColor, requestBadge, STANDARD_HEADERS } from '../lib/ui.js'

const emit = defineEmits(['show-code', 'container-settings']) // container-settings: ({ col, node, tab })
const req = activeRequest
const tab = ref('params')
const sendMenu = ref(false)

// Edits go into the tab's draft (unsaved until Save / Ctrl+S); the draft is kept locally.
watch(
  req,
  (n, o) => {
    if (n && n === o) {
      keepTab(n.id) // editing a preview tab keeps it open
      persistDrafts()
    }
  },
  { deep: true },
)
const dirty = computed(() => !!req.value && isDirty(req.value.id))
const fromHistory = computed(() => !!req.value && isHistoryId(req.value.id)) // opened from History, not in a collection yet

// ---- protocol ----------------------------------------------------------------
const protocol = computed(() => protocolOf(req.value))
const protocolOptions = PROTOCOLS.map((p) => ({ value: p.id, label: p.label, class: p.id === 'http' ? '' : requestBadge({ protocol: p.id }).class }))
watch(() => req.value?.id, () => req.value && ensureProtocol(req.value), { immediate: true })
function setProtocol(p) {
  if (p === protocol.value) return
  req.value.protocol = p
  ensureProtocol(req.value)
  tab.value = tabs.value[0].id
}
const URL_PLACEHOLDER = {
  http: 'Enter URL or paste a cURL command',
  graphql: 'https://api.example.com/graphql',
  ws: 'wss://example.com/socket',
  socketio: 'http://localhost:3000',
  grpc: 'localhost:50051  (grpcs:// for TLS)',
  sse: 'https://api.example.com/events',
}
const conn = computed(() => state.conns[req.value?.id] || null)

// gRPC method picker (from the .proto text)
const grpcOptions = ref([])
watch(
  () => (protocol.value === 'grpc' ? req.value.grpc?.proto : null),
  async (text) => {
    grpcOptions.value = []
    if (!text?.trim()) return
    try {
      const parsed = await parseProto(text)
      grpcOptions.value = parsed.services.flatMap((s) =>
        s.methods.map((m) => ({
          value: `${s.fullName}/${m.name}`,
          label: `${s.name}/${m.name}`,
          hint: m.requestStream && m.responseStream ? 'bidi' : m.requestStream ? 'client stream' : m.responseStream ? 'server stream' : 'unary',
        })),
      )
    } catch {}
  },
  { immediate: true },
)
const grpcMethod = computed({
  get: () => (req.value.grpc?.service ? `${req.value.grpc.service}/${req.value.grpc.method}` : ''),
  set: (v) => {
    const i = v.lastIndexOf('/')
    req.value.grpc.service = v.slice(0, i)
    req.value.grpc.method = v.slice(i + 1)
  },
})

const methodOptions = METHODS.map((m) => ({ value: m, label: m, class: `font-mono font-semibold ${methodColor[m]}` }))

// ---- Inherited auth / headers (collection -> folders -> request) -------------------
const ancestors = computed(() => (req.value ? ancestorsFor(req.value.id) : []))
const parentHeaders = computed(() => {
  const own = new Set(req.value.headers.filter((h) => h.enabled !== false && h.key).map((h) => h.key.toLowerCase()))
  return inheritedHeaders(ancestors.value).map((h) => ({ ...h, overridden: own.has(h.key.toLowerCase()) }))
})
function editContainer(node, tab = 'auth') {
  const col = ancestors.value[0]
  if (col) emit('container-settings', { col, node: node && node.id !== col.id ? node : null, tab })
}
const RAW_TYPES = ['json', 'text', 'xml', 'html'].map((v) => ({ value: v, label: v === 'text' ? 'Text' : v.toUpperCase(), class: 'text-sky-400' }))

// ---- URL <-> Params two-way sync -----------------------------------------
function onUrlInput(val) {
  req.value.url = val
  if (protocol.value !== 'grpc') req.value.params = paramsFromUrl(val, req.value.params)
}
function onParamsChange() {
  req.value.url = urlFromParams(req.value.url, req.value.params)
}

function onUrlPaste(payload) {
  if (protocol.value !== 'http' || !looksLikeCurl(payload.text)) return
  payload.handled = true
  try {
    applyCurl(payload.text)
    toast('Imported from cURL', 'success')
  } catch (e) {
    toast(e.message, 'error')
  }
}
function applyCurl(text) {
  const parsed = parseCurl(text)
  const r = req.value
  r.method = parsed.method
  r.url = parsed.url
  r.params = parsed.params
  r.headers = parsed.headers
  r.auth = parsed.auth
  r.body = parsed.body
  if (r.name === 'New Request') r.name = parsed.name
  tab.value = parsed.body.mode !== 'none' ? 'body' : parsed.headers.length ? 'headers' : 'params'
}

// "Send and Download" menu: closes on a click elsewhere or Escape (not on mouse leave,
// which closed it while the pointer crossed the gap under the button)
const sendMenuBtn = ref(null)
const sendMenuEl = ref(null)
// Menu item under the pointer, by position (works even when an overlay sits on top)
function itemAt(e) {
  return [...(sendMenuEl.value?.querySelectorAll('[role=menuitem]') || [])].find((el) => {
    const r = el.getBoundingClientRect()
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
  })
}
// An overlay on top of the menu also takes the hover (and its cursor): mirror both here.
function onDocMove(e) {
  const item = itemAt(e)
  const covered = item && !item.contains(e.target)
  for (const el of sendMenuEl.value?.querySelectorAll('[role=menuitem]') || []) el.classList.toggle('menu-hover', covered && el === item)
  document.documentElement.style.cursor = covered ? 'pointer' : ''
}
function onDocPointer(e) {
  if (sendMenuEl.value?.contains(e.target) || sendMenuBtn.value?.contains(e.target)) return
  // The pointer is over a menu item but another element received the event (an overlay
  // injected by a browser extension, for example): still treat it as a click on the item.
  const item = itemAt(e)
  if (item) {
    console.warn('[Curlion] click on "Send and Download" was intercepted by', e.target)
    e.preventDefault()
    e.stopPropagation()
    doSend(true)
    return
  }
  sendMenu.value = false
}
function onDocKey(e) {
  if (e.key === 'Escape') sendMenu.value = false
}
watch(sendMenu, (open) => {
  const fn = open ? document.addEventListener : document.removeEventListener
  fn.call(document, 'pointerdown', onDocPointer, true)
  fn.call(document, 'keydown', onDocKey, true)
  fn.call(document, 'pointermove', onDocMove, true)
  if (!open) document.documentElement.style.cursor = ''
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer, true)
  document.removeEventListener('keydown', onDocKey, true)
  document.removeEventListener('pointermove', onDocMove, true)
  document.documentElement.style.cursor = ''
})

function doSend(download = false) {
  sendMenu.value = false
  if (download) toast('Sending… the response will be saved as a file', 'info', 2000)
  send({ download })
}

// ---- Body ----------------------------------------------------------------
const bodyModes = [
  { id: 'none', label: 'none' },
  { id: 'form-data', label: 'form-data' },
  { id: 'urlencoded', label: 'x-www-form-urlencoded' },
  { id: 'raw', label: 'raw' },
]
function beautify() {
  try {
    req.value.body.raw = JSON.stringify(JSON.parse(req.value.body.raw), null, indentString())
  } catch (e) {
    toast('Invalid JSON: ' + e.message, 'error')
  }
}

// ---- Extract ---------------------------------------------------------------
function addRule() {
  req.value.extract.push({ id: uid(), path: '', variable: '', enabled: true })
}
function preview(rule) {
  const r = activeResponse.value
  const json = r?.json !== undefined ? r.json : r?.lines // NDJSON: lines as an array
  if (json === undefined || !rule.path) return null
  const v = getByPath(json, rule.path)
  if (v === undefined) return { ok: false, text: 'not found in last response' }
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return { ok: true, text: s.length > 60 ? s.slice(0, 60) + '…' : s }
}

const counts = computed(() => {
  const r = req.value
  if (!r) return {}
  const n = (list) => list.filter((x) => x.enabled !== false && x.key).length
  return {
    params: n(r.params),
    headers: n(r.headers),
    metadata: n(r.headers),
    query: r.graphql?.query?.trim() ? '•' : '',
    variables: r.graphql?.variables?.trim() ? '•' : '',
    proto: r.grpc?.proto?.trim() ? '•' : '',
    body: r.body.mode !== 'none' ? '•' : '',
    auth: r.auth.type !== 'none' && r.auth.type !== 'inherit' ? '•' : '',
    extract: r.extract.filter((x) => x.enabled !== false && x.path).length,
    tests: (r.tests || []).filter((x) => x.enabled !== false).length,
    samples: r.samples.length,
    docs: r.description ? '•' : '',
  }
})

const T = {
  params: { id: 'params', label: 'Params' },
  auth: { id: 'auth', label: 'Auth' },
  headers: { id: 'headers', label: 'Headers' },
  body: { id: 'body', label: 'Body' },
  extract: { id: 'extract', label: 'Post-Response' },
  tests: { id: 'tests', label: 'Tests' },
  samples: { id: 'samples', label: 'Samples / Mock' },
  docs: { id: 'docs', label: 'Docs' },
  query: { id: 'query', label: 'Query' },
  variables: { id: 'variables', label: 'Variables' },
  schema: { id: 'schema', label: 'Schema' },
  message: { id: 'message', label: 'Message' },
  settings: { id: 'settings', label: 'Settings' },
  metadata: { id: 'metadata', label: 'Metadata' },
  proto: { id: 'proto', label: 'Proto' },
}
const TABS = {
  http: ['params', 'auth', 'headers', 'body', 'tests', 'extract', 'samples', 'docs'],
  graphql: ['query', 'variables', 'schema', 'headers', 'auth', 'tests', 'extract', 'docs'],
  ws: ['message', 'params', 'headers', 'auth', 'settings', 'docs'],
  socketio: ['message', 'headers', 'settings', 'docs'],
  grpc: ['message', 'metadata', 'auth', 'proto', 'settings', 'docs'],
  sse: ['params', 'auth', 'headers', 'body', 'settings', 'docs'],
}
const tabs = computed(() => (TABS[protocol.value] || TABS.http).map((id) => T[id]))
// switching to a request of another protocol: show its first tab
watch(protocol, () => {
  if (!tabs.value.some((t) => t.id === tab.value)) tab.value = tabs.value[0].id
}, { immediate: true })

defineExpose({ applyCurl })
</script>

<template>
  <section v-if="req" class="flex min-h-0 flex-col">
    <!-- Name -->
    <div class="flex items-center gap-2 px-4 pt-3">
      <input v-model="req.name" class="min-w-0 flex-1 truncate bg-transparent text-sm font-medium text-zinc-200 outline-none hover:text-zinc-100 focus:text-zinc-100" />
      <button class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Generate code snippet" @click="emit('show-code')">
        <Code2 :size="15" /> Code
      </button>
      <button
        v-if="fromHistory"
        class="inline-flex items-center gap-1 rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 hover:bg-zinc-700"
        title="Save this request to a collection (Ctrl/⌘+S)"
        @click="saveNow"
      >
        <Save :size="14" /> Save to collection
      </button>
      <button
        v-else
        class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs"
        :class="dirty ? 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700' : 'cursor-default text-zinc-600'"
        :disabled="!dirty"
        :title="dirty ? 'Save changes (Ctrl/⌘+S)' : 'No unsaved changes'"
        @click="saveNow"
      >
        <Save :size="14" /> {{ dirty ? 'Save' : 'Saved' }}
      </button>
    </div>

    <!-- URL bar -->
    <div class="flex items-stretch gap-2 px-4 py-2">
      <div class="flex min-w-0 flex-1 items-stretch rounded-md border border-zinc-700 bg-zinc-900 focus-within:border-zinc-500">
        <UiSelect
          :model-value="protocol"
          :options="protocolOptions"
          class="w-28 shrink-0"
          button-class="rounded-l-md border-r border-zinc-700 bg-zinc-900 px-3 text-xs font-semibold"
          title="Request type"
          @update:model-value="setProtocol"
        />
        <UiSelect v-if="protocol === 'http' || protocol === 'sse'" v-model="req.method" :options="methodOptions" class="w-28 shrink-0" button-class="border-r border-zinc-700 bg-zinc-900 px-3 text-sm font-semibold" />
        <VarInput
          :model-value="req.url"
          class="flex-1 self-center px-3 py-2"
          :placeholder="URL_PLACEHOLDER[protocol]"
          @update:model-value="onUrlInput"
          @enter="doSend()"
          @paste-text="onUrlPaste"
        />
        <UiSelect
          v-if="protocol === 'grpc'"
          v-model="grpcMethod"
          :options="grpcOptions"
          placeholder="Select method"
          class="w-60 shrink-0"
          menu-width="22rem"
          button-class="border-l border-zinc-700 bg-zinc-900 px-3 font-mono text-xs"
          title="Service method (from the Proto tab)"
        />
      </div>
      <!-- WebSocket / Socket.IO: connect -->
      <button
        v-if="protocol === 'ws' || protocol === 'socketio' || protocol === 'sse'"
        class="inline-flex min-w-32 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold"
        :class="conn?.status === 'open' || conn?.status === 'connecting' ? 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700' : 'bg-orange-500 text-on-accent hover:bg-orange-600'"
        @click="conn?.status === 'open' || conn?.status === 'connecting' ? disconnectRealtime(req.id) : connectRealtime()"
      >
        <template v-if="conn?.status === 'connecting'"><Loader2 :size="15" class="animate-spin" /> Cancel</template>
        <template v-else-if="conn?.status === 'open'"><Unplug :size="15" /> Disconnect</template>
        <template v-else><Plug :size="15" /> Connect</template>
      </button>
      <div v-else class="relative flex">
        <button
          v-if="!activeLoading"
          class="inline-flex items-center gap-2 bg-orange-500 px-4 text-sm font-semibold text-on-accent hover:bg-orange-600"
          :class="protocol === 'http' ? 'rounded-l-md' : 'rounded-md'"
          title="Send (Ctrl+Enter)"
          @click="doSend()"
        >
          <Play v-if="protocol === 'grpc'" :size="15" /><Send v-else :size="15" /> {{ protocol === 'grpc' ? 'Invoke' : 'Send' }}
        </button>
        <button v-else class="inline-flex items-center gap-2 bg-zinc-700 px-4 text-sm font-semibold text-zinc-100 hover:bg-zinc-600" :class="protocol === 'http' ? 'rounded-l-md' : 'rounded-md'" @click="cancel()">
          <Loader2 :size="15" class="animate-spin" /> Cancel
        </button>
        <button
          v-if="protocol === 'http'"
          ref="sendMenuBtn"
          class="rounded-r-md border-l border-orange-700 bg-orange-500 px-1.5 text-on-accent hover:bg-orange-600"
          title="More send options"
          :aria-expanded="sendMenu"
          @click="sendMenu = !sendMenu"
        >
          <ChevronDown :size="15" />
        </button>
        <div v-if="sendMenu" ref="sendMenuEl" role="menu" class="absolute top-full right-0 z-50 mt-1 w-48 rounded-md border border-zinc-700 bg-zinc-800 py-1 shadow-xl">
          <button role="menuitem" class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-zinc-700" @click="doSend(true)">
            <Download :size="14" /> Send and Download
          </button>
        </div>
      </div>
    </div>

    <!-- Tabs -->
    <nav class="flex gap-1 overflow-x-auto border-b border-zinc-800 px-3 text-sm">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="relative px-3 py-2 whitespace-nowrap"
        :class="tab === t.id ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'"
        @click="tab = t.id"
      >
        {{ t.label }}
        <span v-if="counts[t.id]" class="ml-1 text-xs text-emerald-400">{{ counts[t.id] }}</span>
        <span v-if="tab === t.id" class="absolute inset-x-2 -bottom-px h-0.5 rounded bg-orange-500"></span>
      </button>
    </nav>

    <div class="min-h-0 flex-1 overflow-auto py-2">
      <!-- GraphQL -->
      <GraphqlPanel v-if="protocol === 'graphql' && ['query', 'variables', 'schema'].includes(tab)" :request="req" :view="tab" class="h-full" @view="tab = $event" />
      <!-- Server-Sent Events -->
      <div v-else-if="protocol === 'sse' && tab === 'settings'" class="max-w-2xl space-y-4 px-4 py-2 text-sm">
        <label class="flex items-start gap-2 text-zinc-300">
          <input v-model="req.sse.reconnect" type="checkbox" class="mt-1 accent-orange-500" />
          <span>Reconnect when the stream ends, like <code>EventSource</code>
            <span class="block text-xs text-zinc-500">Waits for the server's <code>retry:</code> delay (3 s by default) and sends the last event id as <code>Last-Event-ID</code>. Leave off for streams that end on purpose, such as LLM responses.</span>
          </span>
        </label>
        <div>
          <label class="mb-1 block text-xs text-zinc-500">Last-Event-ID for the first connection <span class="text-zinc-600">(optional: resume a stream)</span></label>
          <VarInput v-model="req.sse.lastEventId" placeholder="e.g. 42" class="field" />
        </div>
        <p class="text-xs text-zinc-500">
          Events arrive in the message log below. Unlike <code>EventSource</code>, Curlion can send custom headers, auth and a request body (pick POST).
          Direct mode needs CORS on the server; Agent mode reaches localhost without it. In Proxy mode the hosting provider may end long-running streams.
        </p>
      </div>
      <!-- WebSocket / Socket.IO -->
      <RealtimePanel v-else-if="(protocol === 'ws' || protocol === 'socketio') && ['message', 'settings'].includes(tab)" :request="req" :view="tab" class="h-full" />
      <!-- gRPC -->
      <GrpcPanel v-else-if="protocol === 'grpc' && ['message', 'proto', 'settings'].includes(tab)" :request="req" :view="tab" class="h-full" />
      <div v-else-if="tab === 'metadata'">
        <KeyValueEditor :rows="req.headers" key-placeholder="metadata key" />
        <p class="px-4 pt-2 text-xs text-zinc-600">gRPC metadata (sent as HTTP/2 headers). Keys are lower-cased.</p>
      </div>

      <!-- Params -->
      <div v-else-if="tab === 'params'">
        <p class="px-4 pb-1 text-xs text-zinc-500">Query Params</p>
        <KeyValueEditor :rows="req.params" @change="onParamsChange" />
      </div>

      <!-- Auth -->
      <div v-else-if="tab === 'auth'" class="px-4 py-2">
        <AuthEditor :holder="req" kind="request" :ancestors="ancestors" @edit-parent="editContainer" />
      </div>

      <!-- Headers -->
      <div v-else-if="tab === 'headers'">
        <KeyValueEditor :rows="req.headers" :key-suggestions="STANDARD_HEADERS" />
        <div v-if="parentHeaders.length" class="mt-3 px-4">
          <p class="mb-1 text-xs text-zinc-500">Inherited from the collection and folders</p>
          <ul class="rounded border border-zinc-800 font-mono text-[13px]">
            <li v-for="h in parentHeaders" :key="h.sourceId + h.key" class="flex items-center gap-3 border-t border-zinc-800 px-3 py-1.5 first:border-t-0" :class="{ 'opacity-50': h.overridden }">
              <span class="w-1/3 truncate text-zinc-400" :class="{ 'line-through': h.overridden }">{{ h.key }}</span>
              <span class="min-w-0 flex-1 truncate text-zinc-300">{{ h.value }}</span>
              <button class="shrink-0 font-sans text-xs text-zinc-500 hover:text-orange-400" :title="h.overridden ? 'Overridden by this request' : 'Edit where it is set'" @click="editContainer(ancestors.find((a) => a.id === h.sourceId), 'headers')">
                {{ h.overridden ? 'overridden' : h.source }}
              </button>
            </li>
          </ul>
        </div>
        <p class="px-4 pt-2 text-xs text-zinc-600">
          Auth and body Content-Type headers are added automatically on send. In Direct mode, browsers block some headers (e.g. Cookie, User-Agent, Host).
        </p>
      </div>

      <!-- Body -->
      <div v-else-if="tab === 'body'" class="flex h-full flex-col">
        <div class="flex flex-wrap items-center gap-4 px-4 pb-2 text-sm">
          <label v-for="m in bodyModes" :key="m.id" class="inline-flex cursor-pointer items-center gap-1.5">
            <input v-model="req.body.mode" type="radio" :value="m.id" class="accent-orange-500" />
            <span :class="req.body.mode === m.id ? 'text-zinc-100' : 'text-zinc-400'">{{ m.label }}</span>
          </label>
          <template v-if="req.body.mode === 'raw'">
            <UiSelect v-model="req.body.rawType" :options="RAW_TYPES" class="w-24" button-class="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs" />
            <button v-if="req.body.rawType === 'json'" class="ml-auto inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-100" @click="beautify">
              <Wand2 :size="13" /> Beautify
            </button>
          </template>
        </div>
        <p v-if="req.body.mode !== 'none' && ['GET', 'HEAD'].includes(req.method)" class="px-4 pb-2 text-xs text-amber-400">
          Browsers cannot send a body with {{ req.method }}. The body will be ignored.
        </p>
        <p v-if="req.body.mode === 'none'" class="px-4 py-6 text-center text-sm text-zinc-500">This request does not have a body.</p>
        <KeyValueEditor v-else-if="req.body.mode === 'form-data'" :rows="req.body.formData" allow-files />
        <KeyValueEditor v-else-if="req.body.mode === 'urlencoded'" :rows="req.body.urlencoded" />
        <div v-else class="mx-4 min-h-48 flex-1 rounded border border-zinc-800">
          <CodeEditor v-model="req.body.raw" :language="req.body.rawType" />
        </div>
      </div>

      <!-- Post-response extract -->
      <div v-else-if="tab === 'extract'" class="px-4 text-sm">
        <p class="mb-3 text-xs text-zinc-500">
          After a JSON response arrives, copy values into the active environment (or Globals when no environment is selected). Example:
          <code class="text-zinc-300">data.access_token</code> → <code class="text-emerald-400">token</code>, then use <code v-pre class="text-emerald-400">{{token}}</code> anywhere.
        </p>
        <div v-for="rule in req.extract" :key="rule.id" class="group mb-2 flex flex-wrap items-center gap-2">
          <input v-model="rule.enabled" type="checkbox" class="accent-orange-500" />
          <input v-model="rule.path" placeholder="JSON path, e.g. data.token or items[0].id" class="min-w-48 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-[13px] outline-none focus:border-zinc-500" />
          <span class="text-zinc-500">→</span>
          <input v-model="rule.variable" placeholder="variable name" class="w-44 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-[13px] text-emerald-400 outline-none focus:border-zinc-500" />
          <button class="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-400" @click="req.extract.splice(req.extract.indexOf(rule), 1)"><Trash2 :size="14" /></button>
          <span v-if="preview(rule)" class="w-full pl-6 font-mono text-xs" :class="preview(rule).ok ? 'text-zinc-500' : 'text-amber-500'">
            last response: {{ preview(rule).text }}
          </span>
        </div>
        <button class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" @click="addRule">
          <Plus :size="14" /> Add rule
        </button>
      </div>

      <!-- Tests -->
      <TestsPanel v-else-if="tab === 'tests'" :request="req" :results="activeResponse?.tests || null" />

      <!-- Samples / mock -->
      <SamplesPanel v-else-if="tab === 'samples'" :request="req" />

      <!-- Docs -->
      <div v-else-if="tab === 'docs'" class="flex h-full flex-col px-4 text-sm">
        <p class="mb-2 text-xs text-zinc-500">Shown under this endpoint on the published docs page. Plain text; blank lines start new paragraphs.</p>
        <textarea v-model="req.description" class="min-h-40 flex-1 rounded border border-zinc-700 bg-zinc-900 p-3 outline-none focus:border-zinc-500" placeholder="What this endpoint does, required permissions, notes about parameters…"></textarea>
      </div>
    </div>
  </section>
</template>
