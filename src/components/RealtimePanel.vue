<!-- WebSocket / Socket.IO request tabs: message composer (+ saved messages) and connection settings. -->
<script setup>
import { computed, ref } from 'vue'
import { Bookmark, Send, Trash2, Wand2 } from 'lucide-vue-next'
import CodeEditor from './CodeEditor.vue'
import UiSelect from './UiSelect.vue'
import VarInput from './VarInput.vue'
import { sendRealtime, state, toast } from '../store.js'
import { uid } from '../lib/model.js'
import { indentString } from '../lib/settings.js'

const props = defineProps({
  request: { type: Object, required: true },
  view: { type: String, required: true }, // message | settings
})
const isWs = computed(() => props.request.protocol === 'ws')
const cfg = computed(() => (isWs.value ? props.request.ws : props.request.socketio))
const open = computed(() => state.conns[props.request.id]?.status === 'open')

const FORMATS = [
  { value: 'text', label: 'Text' },
  { value: 'json', label: 'JSON' },
]
const TRANSPORTS = [
  { value: 'websocket', label: 'WebSocket only' },
  { value: 'polling', label: 'Long-polling, then WebSocket' },
]

const bodyKey = computed(() => (isWs.value ? 'message' : 'args'))
function beautify() {
  try {
    cfg.value[bodyKey.value] = JSON.stringify(JSON.parse(cfg.value[bodyKey.value]), null, indentString())
  } catch (e) {
    toast('Invalid JSON: ' + e.message, 'error')
  }
}

// ---- saved messages ------------------------------------------------------------
const saveName = ref('')
function saveCurrent() {
  const name = saveName.value.trim() || (isWs.value ? cfg.value.message.slice(0, 30) : cfg.value.event) || 'Message'
  cfg.value.saved.push(isWs.value ? { id: uid(), name, body: cfg.value.message } : { id: uid(), name, event: cfg.value.event, body: cfg.value.args })
  saveName.value = ''
}
function load(m) {
  if (isWs.value) cfg.value.message = m.body
  else {
    cfg.value.event = m.event
    cfg.value.args = m.body
  }
}
function sendSaved(m) {
  load(m)
  sendRealtime(props.request.id)
}
</script>

<template>
  <!-- Composer -->
  <div v-if="view === 'message'" class="grid h-full min-h-0 gap-4 px-4 md:grid-cols-[1fr_220px]">
    <div class="flex min-h-0 flex-col">
      <div class="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <template v-if="isWs">
          <UiSelect v-model="cfg.format" :options="FORMATS" class="w-24" button-class="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs" />
        </template>
        <template v-else>
          <span class="text-zinc-500">Event</span>
          <VarInput v-model="cfg.event" placeholder="message" class="field w-48" />
          <label class="ml-1 inline-flex items-center gap-1.5 text-zinc-400" title="Wait for the server's acknowledgement callback">
            <input v-model="cfg.ack" type="checkbox" class="accent-orange-500" /> Ack
          </label>
        </template>
        <button v-if="!isWs || cfg.format === 'json'" class="inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-100" @click="beautify"><Wand2 :size="13" /> Beautify</button>
        <button
          class="ml-auto inline-flex items-center gap-1.5 rounded bg-orange-500 px-3 py-1 font-medium text-on-accent hover:bg-orange-600 disabled:opacity-40"
          :disabled="!open"
          :title="open ? 'Send (Ctrl/⌘+Enter)' : 'Connect first'"
          @click="sendRealtime(request.id)"
        >
          <Send :size="13" /> {{ isWs ? 'Send' : 'Emit' }}
        </button>
      </div>
      <p v-if="!isWs" class="mb-1 text-xs text-zinc-500">Arguments as JSON. An array sends several arguments; anything else is one argument.</p>
      <div class="min-h-32 flex-1 rounded border border-zinc-800">
        <CodeEditor v-model="cfg[bodyKey]" :language="isWs && cfg.format === 'text' ? 'text' : 'json'" />
      </div>
    </div>

    <aside class="flex min-h-0 flex-col">
      <p class="mb-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Saved messages</p>
      <div class="mb-2 flex gap-1">
        <input v-model="saveName" placeholder="Name" class="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs outline-none focus:border-zinc-600" @keydown.enter="saveCurrent" />
        <button class="icon-btn" title="Save the current message" @click="saveCurrent"><Bookmark :size="14" /></button>
      </div>
      <ul class="min-h-0 flex-1 space-y-0.5 overflow-y-auto text-xs">
        <li v-for="m in cfg.saved" :key="m.id" class="group flex items-center gap-1 rounded px-1.5 py-1 hover:bg-zinc-900">
          <button class="min-w-0 flex-1 truncate text-left text-zinc-300" :title="m.body" @click="load(m)">
            <span v-if="!isWs" class="font-mono text-sky-400">{{ m.event }} </span>{{ m.name }}
          </button>
          <button class="rounded p-0.5 text-zinc-500 opacity-0 group-hover:opacity-100 hover:text-orange-400 disabled:opacity-0" :disabled="!open" title="Send now" @click="sendSaved(m)"><Send :size="12" /></button>
          <button class="rounded p-0.5 text-zinc-500 opacity-0 group-hover:opacity-100 hover:text-red-400" title="Delete" @click="cfg.saved.splice(cfg.saved.indexOf(m), 1)"><Trash2 :size="12" /></button>
        </li>
        <li v-if="!cfg.saved.length" class="px-1.5 py-1 text-zinc-600">Nothing saved yet.</li>
      </ul>
    </aside>
  </div>

  <!-- Settings -->
  <div v-else class="max-w-xl space-y-4 px-4 text-sm">
    <template v-if="isWs">
      <label class="block">
        <span class="mb-1 block text-xs text-zinc-500">Subprotocols <span class="text-zinc-600">(comma separated, Sec-WebSocket-Protocol)</span></span>
        <input v-model="cfg.protocols" placeholder="graphql-ws, v1.chat" class="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 outline-none focus:border-zinc-500" />
      </label>
      <p class="text-xs text-zinc-500">
        Direct mode connects from the browser, which cannot send custom headers. Agent mode connects from your computer: headers, auth, localhost and self-signed certificates work.
      </p>
    </template>
    <template v-else>
      <label class="block">
        <span class="mb-1 block text-xs text-zinc-500">Path</span>
        <input v-model="cfg.path" placeholder="/socket.io" class="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono outline-none focus:border-zinc-500" />
      </label>
      <label class="block">
        <span class="mb-1 block text-xs text-zinc-500">Transport</span>
        <UiSelect v-model="cfg.transports" :options="TRANSPORTS" class="w-64" />
      </label>
      <div>
        <span class="mb-1 block text-xs text-zinc-500">Auth payload <span class="text-zinc-600">(JSON sent as socket.handshake.auth)</span></span>
        <div class="h-28 rounded border border-zinc-800"><CodeEditor v-model="cfg.auth" language="json" /></div>
      </div>
      <p class="text-xs text-zinc-500">Socket.IO connects from the browser. Headers are only sent with the long-polling transport; the server must allow this site in its CORS settings.</p>
    </template>
  </div>
</template>
