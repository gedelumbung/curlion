<script setup>
import { computed, ref } from 'vue'
import { FileCode2, FileJson, Link, Loader2, Terminal } from 'lucide-vue-next'
import Modal from './Modal.vue'
import UiSelect from './UiSelect.vue'
import { importPostman } from '../lib/postman.js'
import { sendRequest } from '../lib/http.js'
import { parseCurl } from '../lib/curl.js'
import { addCollection, addEnvironment, addRequest, createCollection, openCollectionOverview, openRequest, setActiveEnv, state, toast, wsCollections } from '../store.js'

const emit = defineEmits(['close'])
const tab = ref('postman')
const error = ref('')
const warnings = ref([])
const curlText = ref('')
const pasted = ref('')
const dragging = ref(false)
const targetCollectionId = ref(state.active?.collectionId || wsCollections.value[0]?.id || '__new__')
const collectionOptions = computed(() => [
  ...wsCollections.value.map((c) => ({ value: c.id, label: c.name })),
  { value: '__new__', label: '+ New collection', class: 'text-orange-400' },
])

/** Postman collection or OpenAPI / Swagger spec, JSON or YAML: the format is detected. */
async function importText(text) {
  error.value = ''
  warnings.value = []
  try {
    // loaded on demand: the YAML parser is only needed here
    const { importOpenApi, isOpenApi, parseSpecText } = await import('../lib/openapi.js')
    const data = parseSpecText(text)
    const openapi = isOpenApi(data)
    const { collection, environment, warnings: w } = openapi ? importOpenApi(data) : importPostman(data)
    collection.importedFrom = openapi ? 'openapi' : 'postman'
    addCollection(collection)
    if (environment) {
      addEnvironment(environment)
      if (openapi) setActiveEnv(environment.id) // its {{baseUrl}} is needed by every request
    }
    if (openapi) openCollectionOverview(collection.id, { preview: false })
    else {
      const first = findFirstRequest(collection.items)
      if (first) openRequest(collection.id, first.id)
    }
    toast(
      `Imported "${collection.name}"${environment ? (openapi ? ` (environment "${environment.name}" selected)` : ' (+ variables as environment)') : ''}`,
      'success',
    )
    if (w.length) warnings.value = w
    else emit('close')
  } catch (e) {
    error.value = e.message
  }
}

function findFirstRequest(items) {
  for (const n of items) {
    if (n.type === 'request') return n
    const r = findFirstRequest(n.items)
    if (r) return r
  }
}

async function onFile(file) {
  if (!file) return
  if (!/\.(json|ya?ml)$/i.test(file.name) && !/json|yaml/.test(file.type)) {
    error.value = 'Please choose a Postman Collection (.json) or an OpenAPI / Swagger file (.json, .yaml, .yml).'
    return
  }
  importText(await file.text())
}

// OpenAPI from a URL, fetched through the current send mode (Proxy / Agent avoid CORS)
const specUrl = ref('')
const fetching = ref(false)
async function importUrl() {
  error.value = ''
  fetching.value = true
  try {
    const url = specUrl.value.trim()
    const res = await sendRequest({ method: 'GET', url: /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`, headers: [{ key: 'Accept', value: 'application/json, application/yaml, text/yaml, */*' }], body: null }, { mode: state.mode, agentPort: state.agent.port })
    if (res.status >= 400) throw new Error(`The server answered ${res.status} ${res.statusText}.`)
    await importText(res.body)
  } catch (e) {
    error.value = e.message
  } finally {
    fetching.value = false
  }
}

function importCurl() {
  error.value = ''
  try {
    const req = parseCurl(curlText.value)
    let col = state.collections.find((c) => c.id === targetCollectionId.value)
    if (!col) col = createCollection('Imported')
    addRequest(col, null, req)
    toast('cURL imported', 'success')
    emit('close')
  } catch (e) {
    error.value = e.message
  }
}
</script>

<template>
  <Modal title="Import" @close="emit('close')">
    <div class="p-4 text-sm">
      <div class="mb-4 flex gap-1">
        <button class="inline-flex items-center gap-1.5 rounded px-3 py-1.5" :class="tab === 'postman' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'" @click="(tab = 'postman'), (error = '')">
          <FileJson :size="15" /> Postman Collection
        </button>
        <button class="inline-flex items-center gap-1.5 rounded px-3 py-1.5" :class="tab === 'openapi' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'" @click="(tab = 'openapi'), (error = '')">
          <FileCode2 :size="15" /> OpenAPI / Swagger
        </button>
        <button class="inline-flex items-center gap-1.5 rounded px-3 py-1.5" :class="tab === 'curl' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'" @click="(tab = 'curl'), (error = '')">
          <Terminal :size="15" /> Raw cURL
        </button>
      </div>

      <template v-if="tab === 'postman'">
        <label
          class="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center"
          :class="dragging ? 'border-orange-500 bg-orange-500/5' : 'border-zinc-700 hover:border-zinc-500'"
          @dragover.prevent="dragging = true"
          @dragleave="dragging = false"
          @drop.prevent="(dragging = false), onFile($event.dataTransfer.files[0])"
        >
          <FileJson :size="28" class="text-zinc-500" />
          <span class="text-zinc-300">Drop a Postman Collection v2.1 <code>.json</code> here, or click to choose</span>
          <span class="text-xs text-zinc-500">Folders, methods, URLs, headers, params, auth, body and saved responses are imported. OpenAPI files dropped here work too.</span>
          <input type="file" accept=".json,application/json,.yaml,.yml" class="hidden" @change="onFile($event.target.files[0])" />
        </label>
        <p class="mt-4 mb-1 text-xs text-zinc-500">…or paste the JSON</p>
        <textarea v-model="pasted" rows="5" class="w-full rounded border border-zinc-700 bg-zinc-900 p-2 font-mono text-xs outline-none focus:border-zinc-500" placeholder='{ "info": { ... }, "item": [ ... ] }'></textarea>
        <button class="mt-2 rounded bg-orange-500 px-4 py-1.5 font-medium text-on-accent hover:bg-orange-600 disabled:opacity-40" :disabled="!pasted.trim()" @click="importText(pasted)">Import JSON</button>
      </template>

      <template v-else-if="tab === 'openapi'">
        <label
          class="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center"
          :class="dragging ? 'border-orange-500 bg-orange-500/5' : 'border-zinc-700 hover:border-zinc-500'"
          @dragover.prevent="dragging = true"
          @dragleave="dragging = false"
          @drop.prevent="(dragging = false), onFile($event.dataTransfer.files[0])"
        >
          <FileCode2 :size="28" class="text-zinc-500" />
          <span class="text-zinc-300">Drop an OpenAPI 3.x or Swagger 2.0 file (<code>.json</code>, <code>.yaml</code>) here, or click to choose</span>
          <span class="text-xs text-zinc-500">Operations become requests in folders by tag, with example params, bodies and responses. The server URL goes into <code v-pre>{{baseUrl}}</code> in a new environment, and the security scheme becomes the collection's auth.</span>
          <input type="file" accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml" class="hidden" @change="onFile($event.target.files[0])" />
        </label>
        <p class="mt-4 mb-1 text-xs text-zinc-500">…or import from a URL <span class="text-zinc-600">(fetched in {{ state.mode }} mode)</span></p>
        <form class="flex gap-2" @submit.prevent="specUrl.trim() && importUrl()">
          <div class="flex min-w-0 flex-1 items-center gap-2 rounded border border-zinc-700 bg-zinc-900 px-2 focus-within:border-zinc-500">
            <Link :size="14" class="shrink-0 text-zinc-500" />
            <input v-model="specUrl" class="min-w-0 flex-1 bg-transparent py-1.5 font-mono text-xs outline-none" placeholder="https://petstore3.swagger.io/api/v3/openapi.json" />
          </div>
          <button class="inline-flex items-center gap-1.5 rounded bg-orange-500 px-4 py-1.5 font-medium text-on-accent hover:bg-orange-600 disabled:opacity-40" :disabled="!specUrl.trim() || fetching">
            <Loader2 v-if="fetching" :size="14" class="animate-spin" /> Import
          </button>
        </form>
        <p class="mt-4 mb-1 text-xs text-zinc-500">…or paste JSON or YAML</p>
        <textarea v-model="pasted" rows="5" class="w-full rounded border border-zinc-700 bg-zinc-900 p-2 font-mono text-xs outline-none focus:border-zinc-500" placeholder="openapi: 3.0.3&#10;info: { title: My API, version: 1.0.0 }&#10;paths: …"></textarea>
        <button class="mt-2 rounded bg-orange-500 px-4 py-1.5 font-medium text-on-accent hover:bg-orange-600 disabled:opacity-40" :disabled="!pasted.trim()" @click="importText(pasted)">Import</button>
      </template>

      <template v-else>
        <textarea v-model="curlText" rows="9" class="w-full rounded border border-zinc-700 bg-zinc-900 p-2 font-mono text-xs outline-none focus:border-zinc-500" placeholder="curl -X POST 'https://api.example.com/login' -H 'Content-Type: application/json' -d '{&quot;email&quot;:&quot;a@b.c&quot;}'"></textarea>
        <div class="mt-2 flex items-center gap-2">
          <span class="text-xs text-zinc-500">Add to</span>
          <UiSelect v-model="targetCollectionId" :options="collectionOptions" class="w-56" button-class="rounded border border-zinc-700 bg-zinc-900 px-2 py-1" />
          <button class="ml-auto rounded bg-orange-500 px-4 py-1.5 font-medium text-on-accent hover:bg-orange-600 disabled:opacity-40" :disabled="!curlText.trim()" @click="importCurl">Import</button>
        </div>
        <p class="mt-3 text-xs text-zinc-500">Tip: you can also paste a cURL command straight into the URL bar of any request.</p>
      </template>

      <div v-if="error" class="mt-4 rounded border border-red-900 bg-red-950/40 p-3 text-red-300">{{ error }}</div>
      <div v-if="warnings.length" class="mt-4 rounded border border-amber-900 bg-amber-950/30 p-3 text-amber-300">
        <p class="font-medium">Imported with notes:</p>
        <ul class="mt-1 list-disc pl-5 text-amber-300/80">
          <li v-for="w in warnings" :key="w">{{ w }}</li>
        </ul>
      </div>
    </div>
  </Modal>
</template>
