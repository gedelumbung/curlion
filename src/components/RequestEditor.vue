<script setup>
import { computed, ref, watch } from 'vue'
import { ChevronDown, Code2, Download, Loader2, Plus, Save, Send, Trash2, Wand2 } from 'lucide-vue-next'
import VarInput from './VarInput.vue'
import UiSelect from './UiSelect.vue'
import KeyValueEditor from './KeyValueEditor.vue'
import CodeEditor from './CodeEditor.vue'
import SamplesPanel from './SamplesPanel.vue'
import { activeLoading, activeRequest, activeResponse, cancel, isDirty, keepTab, persistDrafts, saveNow, send, state, toast } from '../store.js'
import { METHODS, uid } from '../lib/model.js'
import { paramsFromUrl, urlFromParams } from '../lib/url.js'
import { looksLikeCurl, parseCurl } from '../lib/curl.js'
import { getByPath } from '../lib/variables.js'
import { methodColor, STANDARD_HEADERS } from '../lib/ui.js'

const emit = defineEmits(['show-code'])
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

const methodOptions = METHODS.map((m) => ({ value: m, label: m, class: `font-mono font-semibold ${methodColor[m]}` }))
const AUTH_TYPES = [
  { value: 'none', label: 'No Auth' },
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'basic', label: 'Basic Auth' },
  { value: 'apikey', label: 'API Key' },
]
const APIKEY_IN = [
  { value: 'header', label: 'Header' },
  { value: 'query', label: 'Query Params' },
]
const RAW_TYPES = ['json', 'text', 'xml', 'html'].map((v) => ({ value: v, label: v === 'text' ? 'Text' : v.toUpperCase(), class: 'text-sky-400' }))

// ---- URL <-> Params two-way sync -----------------------------------------
function onUrlInput(val) {
  req.value.url = val
  req.value.params = paramsFromUrl(val, req.value.params)
}
function onParamsChange() {
  req.value.url = urlFromParams(req.value.url, req.value.params)
}

function onUrlPaste(payload) {
  if (!looksLikeCurl(payload.text)) return
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

function doSend(download = false) {
  sendMenu.value = false
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
    req.value.body.raw = JSON.stringify(JSON.parse(req.value.body.raw), null, 2)
  } catch (e) {
    toast('Invalid JSON: ' + e.message, 'error')
  }
}

// ---- Extract ---------------------------------------------------------------
function addRule() {
  req.value.extract.push({ id: uid(), path: '', variable: '', enabled: true })
}
function preview(rule) {
  const json = activeResponse.value?.json
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
    body: r.body.mode !== 'none' ? '•' : '',
    auth: r.auth.type !== 'none' ? '•' : '',
    extract: r.extract.filter((x) => x.enabled !== false && x.path).length,
    samples: r.samples.length,
    docs: r.description ? '•' : '',
  }
})

const tabs = [
  { id: 'params', label: 'Params' },
  { id: 'auth', label: 'Auth' },
  { id: 'headers', label: 'Headers' },
  { id: 'body', label: 'Body' },
  { id: 'extract', label: 'Post-Response' },
  { id: 'samples', label: 'Samples / Mock' },
  { id: 'docs', label: 'Docs' },
]

defineExpose({ applyCurl })
</script>

<template>
  <section v-if="req" class="flex min-h-0 flex-col">
    <!-- Name -->
    <div class="flex items-center gap-2 px-4 pt-3">
      <input v-model="req.name" class="min-w-0 flex-1 truncate bg-transparent text-sm font-medium text-zinc-200 outline-none hover:text-white focus:text-zinc-100" />
      <button class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Generate code snippet" @click="emit('show-code')">
        <Code2 :size="15" /> Code
      </button>
      <button
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
        <UiSelect v-model="req.method" :options="methodOptions" class="w-28 shrink-0" button-class="rounded-l-md border-r border-zinc-700 bg-zinc-900 px-3 text-sm font-semibold" />
        <VarInput
          :model-value="req.url"
          class="flex-1 self-center px-3 py-2"
          placeholder="Enter URL or paste a cURL command"
          @update:model-value="onUrlInput"
          @enter="doSend()"
          @paste-text="onUrlPaste"
        />
      </div>
      <div class="relative flex">
        <button
          v-if="!activeLoading"
          class="inline-flex items-center gap-2 rounded-l-md bg-orange-500 px-4 text-sm font-semibold text-white hover:bg-orange-600"
          title="Send (Ctrl+Enter)"
          @click="doSend()"
        >
          <Send :size="15" /> Send
        </button>
        <button v-else class="inline-flex items-center gap-2 rounded-l-md bg-zinc-700 px-4 text-sm font-semibold text-zinc-100 hover:bg-zinc-600" @click="cancel()">
          <Loader2 :size="15" class="animate-spin" /> Cancel
        </button>
        <button class="rounded-r-md border-l border-orange-700 bg-orange-500 px-1.5 text-white hover:bg-orange-600" @click="sendMenu = !sendMenu">
          <ChevronDown :size="15" />
        </button>
        <div v-if="sendMenu" class="absolute top-full right-0 z-20 mt-1 w-48 rounded-md border border-zinc-700 bg-zinc-800 py-1 shadow-xl" @mouseleave="sendMenu = false">
          <button class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-zinc-700" @click="doSend(true)">
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
      <!-- Params -->
      <div v-if="tab === 'params'">
        <p class="px-4 pb-1 text-xs text-zinc-500">Query Params</p>
        <KeyValueEditor :rows="req.params" @change="onParamsChange" />
      </div>

      <!-- Auth -->
      <div v-else-if="tab === 'auth'" class="grid gap-4 px-4 py-2 md:grid-cols-[200px_1fr]">
        <div>
          <label class="mb-1 block text-xs text-zinc-500">Type</label>
          <UiSelect v-model="req.auth.type" :options="AUTH_TYPES" class="w-full" button-class="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm" />
        </div>
        <div class="space-y-3 text-sm">
          <p v-if="req.auth.type === 'none'" class="pt-5 text-zinc-500">This request does not use any authorization.</p>
          <template v-if="req.auth.type === 'bearer'">
            <label class="block text-xs text-zinc-500">Token</label>
            <VarInput v-model="req.auth.bearer.token" placeholder="Token or a {{variable}}" class="field" />
          </template>
          <template v-if="req.auth.type === 'basic'">
            <label class="block text-xs text-zinc-500">Username</label>
            <VarInput v-model="req.auth.basic.username" class="field" />
            <label class="block text-xs text-zinc-500">Password</label>
            <VarInput v-model="req.auth.basic.password" class="field" masked />
          </template>
          <template v-if="req.auth.type === 'apikey'">
            <label class="block text-xs text-zinc-500">Key</label>
            <VarInput v-model="req.auth.apikey.key" placeholder="X-API-Key" class="field" />
            <label class="block text-xs text-zinc-500">Value</label>
            <VarInput v-model="req.auth.apikey.value" class="field" />
            <label class="block text-xs text-zinc-500">Add to</label>
            <UiSelect v-model="req.auth.apikey.in" :options="APIKEY_IN" class="w-36" />
          </template>
        </div>
      </div>

      <!-- Headers -->
      <div v-else-if="tab === 'headers'">
        <KeyValueEditor :rows="req.headers" :key-suggestions="STANDARD_HEADERS" />
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
