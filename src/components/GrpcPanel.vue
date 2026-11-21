<!-- gRPC request tabs: Message, Proto (service definition) and Settings. -->
<script setup>
import { computed, ref, watch } from 'vue'
import { FileUp, Sparkles, Wand2 } from 'lucide-vue-next'
import CodeEditor from './CodeEditor.vue'
import { state, toast } from '../store.js'
import { exampleMessage, findMethod, parseProto } from '../lib/grpc.js'
import { indentString } from '../lib/settings.js'

const props = defineProps({
  request: { type: Object, required: true },
  view: { type: String, required: true }, // message | proto | settings
})
const g = computed(() => props.request.grpc)

const parsed = ref(null)
const parseError = ref('')
watch(
  () => g.value.proto,
  async (text) => {
    parseError.value = ''
    if (!text?.trim()) return (parsed.value = null)
    try {
      parsed.value = await parseProto(text)
    } catch (e) {
      parsed.value = null
      parseError.value = e.message
    }
  },
  { immediate: true },
)
const method = computed(() => (parsed.value ? findMethod(parsed.value, g.value.service, g.value.method) : null))

function example() {
  if (!method.value) return toast('Pick a method first', 'error')
  const ex = exampleMessage(parsed.value.root, method.value.requestType)
  g.value.message = JSON.stringify(method.value.requestStream ? [ex] : ex, null, indentString())
}
function beautify() {
  try {
    g.value.message = JSON.stringify(JSON.parse(g.value.message || '{}'), null, indentString())
  } catch (e) {
    toast('Invalid JSON: ' + e.message, 'error')
  }
}

const fileInput = ref(null)
async function upload(e) {
  const files = [...(e.target.files || [])]
  if (!files.length) return
  const texts = await Promise.all(files.map((f) => f.text()))
  // several files: concatenate (imports between them then resolve within the same text)
  g.value.proto = texts.map((t, i) => (files.length > 1 ? `// ${files[i].name}\n${t}` : t)).join('\n\n')
  g.value.protoName = files.map((f) => f.name).join(', ')
  e.target.value = ''
}
</script>

<template>
  <!-- Message -->
  <div v-if="view === 'message'" class="flex h-full flex-col">
    <div class="flex flex-wrap items-center gap-3 px-4 pb-2 text-xs text-zinc-500">
      <span v-if="method">
        <span class="font-mono text-zinc-300">{{ method.requestType }}</span> →
        <span class="font-mono text-zinc-300">{{ method.responseType }}</span>
        <span v-if="method.requestStream" class="ml-1 text-amber-400">client stream: send a JSON array</span>
        <span v-if="method.responseStream" class="ml-1 text-sky-400">server stream: replies are collected</span>
      </span>
      <span v-else>Request message as JSON. Pick a method next to the address.</span>
      <button class="ml-auto inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-100" @click="example"><Sparkles :size="13" /> Example message</button>
      <button class="inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-100" @click="beautify"><Wand2 :size="13" /> Beautify</button>
    </div>
    <div class="mx-4 min-h-48 flex-1 rounded border border-zinc-800">
      <CodeEditor v-model="g.message" language="json" />
    </div>
  </div>

  <!-- Proto -->
  <div v-else-if="view === 'proto'" class="flex h-full flex-col">
    <div class="flex flex-wrap items-center gap-3 px-4 pb-2 text-xs">
      <span class="text-zinc-500">Service definition (.proto). Google's well-known types are built in; paste other imports into the same text.</span>
      <input ref="fileInput" type="file" accept=".proto" multiple class="hidden" @change="upload" />
      <button class="ml-auto inline-flex items-center gap-1 rounded bg-zinc-800 px-2.5 py-1 text-zinc-200 hover:bg-zinc-700" @click="fileInput.click()"><FileUp :size="13" /> Upload .proto</button>
    </div>
    <p v-if="parseError" class="mx-4 mb-2 rounded border border-red-900 bg-red-950/40 p-2 font-mono text-xs text-red-300">{{ parseError }}</p>
    <p v-else-if="parsed" class="mx-4 mb-2 text-xs text-emerald-400">
      {{ parsed.services.length }} service(s), {{ parsed.services.reduce((n, s) => n + s.methods.length, 0) }} method(s)<span v-if="g.protoName" class="text-zinc-500"> · {{ g.protoName }}</span>
    </p>
    <div class="mx-4 min-h-48 flex-1 rounded border border-zinc-800">
      <CodeEditor v-model="g.proto" language="text" :variables="false" />
    </div>
  </div>

  <!-- Settings -->
  <div v-else class="max-w-xl space-y-4 px-4 text-sm">
    <label class="flex items-center gap-2">
      <input v-model="g.tls" type="checkbox" class="accent-orange-500" />
      <span>Use TLS <span class="text-zinc-500">(or write the address as grpcs://host:port)</span></span>
    </label>
    <p class="text-xs text-zinc-500">
      gRPC calls run through the Curlion Agent on your computer (HTTP/2), so Agent mode must be selected.
      Metadata comes from the Metadata tab and Auth. Self-signed certificates are accepted unless the agent runs with --strict-tls.
      <span v-if="state.mode !== 'agent'" class="text-amber-400">Agent mode is not selected.</span>
    </p>
  </div>
</template>
