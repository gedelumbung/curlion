<!-- GraphQL request tabs: Query, Variables and a Schema explorer (introspection). -->
<script setup>
import { computed, markRaw, ref } from 'vue'
import { BookOpen, Loader2, RefreshCw, Search, Wand2 } from 'lucide-vue-next'
import CodeEditor from './CodeEditor.vue'
import { prepareRequest, state, toast } from '../store.js'
import { sendRequest } from '../lib/http.js'
import { INTROSPECTION_QUERY, baseType, operationFor, summarizeSchema, typeName, variablesFor } from '../lib/graphql.js'
import { indentString } from '../lib/settings.js'

const props = defineProps({
  request: { type: Object, required: true },
  view: { type: String, required: true }, // query | variables | schema
})
const emit = defineEmits(['view'])
const g = computed(() => props.request.graphql)

// ---- schema (kept for the session, per request) ----------------------------------
const schemas = (globalThis.__curlionGqlSchemas ||= new Map())
const schema = ref(schemas.get(props.request.id) || null)
const loading = ref(false)
const error = ref('')
const filter = ref('')
const openType = ref(null) // type name shown in the detail pane

async function fetchSchema() {
  loading.value = true
  error.value = ''
  try {
    const probe = { ...props.request, graphql: { query: INTROSPECTION_QUERY, variables: '' } }
    const { resolved } = await prepareRequest(probe)
    const res = await sendRequest(resolved, { mode: state.mode, agentPort: state.agent.port })
    if (res.json === undefined) throw new Error(`The server answered ${res.status} ${res.statusText} without JSON.`)
    const s = markRaw(summarizeSchema(res.json))
    schemas.set(props.request.id, s)
    schema.value = s
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

const matches = (f) => !filter.value || f.name.toLowerCase().includes(filter.value.toLowerCase())
function useField(kind, field) {
  g.value.query = operationFor(kind, field, schema.value.types)
  g.value.variables = variablesFor(field)
  emit('view', 'query')
  toast(`Inserted ${kind} ${field.name}`, 'success', 1500)
}
const detail = computed(() => (openType.value ? schema.value?.types.get(openType.value) : null))

function beautifyVariables() {
  try {
    g.value.variables = JSON.stringify(JSON.parse(g.value.variables || '{}'), null, indentString())
  } catch (e) {
    toast('Invalid JSON: ' + e.message, 'error')
  }
}
</script>

<template>
  <!-- Query -->
  <div v-if="view === 'query'" class="flex h-full flex-col">
    <div class="flex items-center gap-3 px-4 pb-2 text-xs text-zinc-500">
      <span>Query, mutation or subscription. Use <code v-pre class="text-zinc-300">{{variables}}</code> or GraphQL <code class="text-zinc-300">$variables</code>.</span>
      <button class="ml-auto inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-100" @click="emit('view', 'schema')"><BookOpen :size="13" /> Schema</button>
    </div>
    <div class="mx-4 min-h-48 flex-1 rounded border border-zinc-800">
      <CodeEditor v-model="g.query" language="text" />
    </div>
  </div>

  <!-- Variables -->
  <div v-else-if="view === 'variables'" class="flex h-full flex-col">
    <div class="flex items-center px-4 pb-2 text-xs text-zinc-500">
      <span>JSON object with the values of the operation's <code class="text-zinc-300">$variables</code>.</span>
      <button class="ml-auto inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-100" @click="beautifyVariables"><Wand2 :size="13" /> Beautify</button>
    </div>
    <div class="mx-4 min-h-48 flex-1 rounded border border-zinc-800">
      <CodeEditor v-model="g.variables" language="json" />
    </div>
  </div>

  <!-- Schema explorer -->
  <div v-else class="flex h-full min-h-0 flex-col px-4 text-sm">
    <div class="mb-2 flex items-center gap-2">
      <button class="inline-flex items-center gap-1.5 rounded bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50" :disabled="loading || !request.url" @click="fetchSchema">
        <Loader2 v-if="loading" :size="13" class="animate-spin" /><RefreshCw v-else :size="13" /> {{ schema ? 'Refresh schema' : 'Fetch schema' }}
      </button>
      <div v-if="schema" class="flex h-7 flex-1 items-center gap-1.5 rounded-md bg-zinc-900 px-2">
        <Search :size="13" class="text-zinc-500" />
        <input v-model="filter" placeholder="Filter fields" class="w-full bg-transparent text-xs outline-none placeholder:text-zinc-600" />
      </div>
    </div>
    <p v-if="error" class="mb-2 rounded border border-red-900 bg-red-950/40 p-2 text-xs text-red-300">{{ error }}</p>
    <p v-if="!schema && !error" class="py-6 text-center text-xs text-zinc-500">Fetches the schema with an introspection query (same URL, headers, auth and send mode as this request).</p>

    <div v-if="schema" class="grid min-h-0 flex-1 gap-4 overflow-hidden md:grid-cols-[1fr_1fr]">
      <div class="min-h-0 overflow-y-auto pr-1">
        <template v-for="root in schema.roots" :key="root.kind">
          <h4 class="mt-1 mb-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">{{ root.kind }}</h4>
          <div v-for="f in root.fields.filter(matches)" :key="root.kind + f.name" class="group rounded px-2 py-1 hover:bg-zinc-900">
            <div class="flex items-baseline gap-1 font-mono text-xs">
              <span class="text-sky-400">{{ f.name }}</span>
              <span v-if="f.args?.length" class="truncate text-zinc-500">({{ f.args.map((a) => `${a.name}: ${typeName(a.type)}`).join(', ') }})</span>
              <span class="text-zinc-500">:</span>
              <button class="text-violet-400 hover:underline" @click="openType = baseType(f.type)">{{ typeName(f.type) }}</button>
              <button class="ml-auto shrink-0 rounded px-1.5 text-[11px] text-orange-400 opacity-0 group-hover:opacity-100 hover:bg-zinc-800" @click="useField(root.kind, f)">Use</button>
            </div>
            <p v-if="f.description" class="mt-0.5 line-clamp-2 text-xs text-zinc-500">{{ f.description }}</p>
          </div>
        </template>
      </div>
      <div class="min-h-0 overflow-y-auto rounded border border-zinc-800 p-3">
        <p v-if="!detail" class="text-xs text-zinc-500">Click a type to see its fields.</p>
        <template v-else>
          <p class="font-mono text-sm text-violet-400">{{ detail.name }} <span class="text-xs text-zinc-500 lowercase">{{ detail.kind }}</span></p>
          <p v-if="detail.description" class="mt-1 text-xs text-zinc-500">{{ detail.description }}</p>
          <ul class="mt-2 space-y-1 font-mono text-xs">
            <li v-for="f in detail.fields || detail.inputFields || []" :key="f.name">
              <span class="text-sky-400">{{ f.name }}</span><span class="text-zinc-500">: </span>
              <button class="text-violet-400 hover:underline" @click="openType = baseType(f.type)">{{ typeName(f.type) }}</button>
            </li>
            <li v-for="v in detail.enumValues || []" :key="v.name" class="text-emerald-400">{{ v.name }}</li>
          </ul>
        </template>
      </div>
    </div>
  </div>
</template>
