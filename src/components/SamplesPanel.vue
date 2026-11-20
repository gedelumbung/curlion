<script setup>
import { computed, ref, watch } from 'vue'
import { Copy, Plus, Trash2 } from 'lucide-vue-next'
import KeyValueEditor from './KeyValueEditor.vue'
import CodeEditor from './CodeEditor.vue'
import { newSample } from '../lib/model.js'
import { cloudEnabled, mockUrl, state, toast } from '../store.js'
import { copyText, statusColor } from '../lib/ui.js'

const props = defineProps({ request: { type: Object, required: true } })
const selectedId = ref(props.request.samples[0]?.id || null)
const sample = computed(() => props.request.samples.find((s) => s.id === selectedId.value) || null)
watch(
  () => props.request.id,
  () => (selectedId.value = props.request.samples[0]?.id || null),
)
watch(
  () => props.request.samples.length,
  () => {
    if (!sample.value) selectedId.value = props.request.samples.at(-1)?.id || null
  },
)

const col = computed(() => state.collections.find((c) => c.id === state.active?.collectionId))
const synced = computed(() => !!col.value?.syncedAt)

function add() {
  const s = newSample(`Example ${props.request.samples.length + 1}`)
  props.request.samples.push(s)
  selectedId.value = s.id
}
function remove(s) {
  if (!confirm(`Delete sample "${s.name}"?`)) return
  props.request.samples.splice(props.request.samples.indexOf(s), 1)
}
async function copyMock(s) {
  await copyText(mockUrl(col.value.id, s.id))
  toast('Mock URL copied', 'success')
}
const lang = computed(() => {
  const ct = sample.value?.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value || ''
  return /json/.test(ct) ? 'json' : /xml/.test(ct) ? 'xml' : /html/.test(ct) ? 'html' : 'text'
})
</script>

<template>
  <div class="flex h-full min-h-64 gap-3 px-4 text-sm">
    <aside class="w-48 shrink-0 space-y-1">
      <button
        v-for="s in request.samples"
        :key="s.id"
        class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left"
        :class="s.id === selectedId ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/50'"
        @click="selectedId = s.id"
      >
        <span class="font-mono text-xs" :class="statusColor(s.status)">{{ s.status }}</span>
        <span class="truncate">{{ s.name }}</span>
      </button>
      <button class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" @click="add">
        <Plus :size="14" /> New sample
      </button>
      <p class="px-2 pt-2 text-xs text-zinc-600">Tip: use "Save as Sample" in the response panel to capture a real response.</p>
    </aside>

    <div v-if="sample" class="flex min-w-0 flex-1 flex-col gap-3">
      <div class="flex flex-wrap items-center gap-2">
        <input v-model="sample.name" class="min-w-40 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 outline-none focus:border-zinc-500" />
        <label class="text-xs text-zinc-500">Status</label>
        <input v-model.number="sample.status" type="number" min="100" max="599" class="w-20 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono outline-none" :class="statusColor(sample.status)" />
        <button class="rounded p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400" title="Delete sample" @click="remove(sample)"><Trash2 :size="15" /></button>
      </div>

      <div class="rounded border border-zinc-800 bg-zinc-900/60 p-2 text-xs">
        <div class="flex items-center gap-2">
          <span class="text-zinc-500">Mock URL</span>
          <code class="min-w-0 flex-1 truncate text-zinc-300">{{ col ? mockUrl(col.id, sample.id) : '' }}</code>
          <button class="inline-flex items-center gap-1 rounded px-2 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" @click="copyMock(sample)">
            <Copy :size="12" /> Copy
          </button>
        </div>
        <p v-if="!cloudEnabled" class="mt-1 text-amber-400">Mock endpoints need Supabase configured (cloud sync). See README.</p>
        <p v-else-if="!state.user" class="mt-1 text-amber-400">Sign in so this collection syncs to the cloud; the mock URL works after sync.</p>
        <p v-else-if="!synced" class="mt-1 text-amber-400">Not synced yet. Changes sync ~3s after you stop typing (or press Ctrl+S).</p>
      </div>

      <div>
        <p class="pb-1 text-xs text-zinc-500">Headers</p>
        <KeyValueEditor :rows="sample.headers" :show-description="false" />
      </div>
      <div class="min-h-48 flex-1 rounded border border-zinc-800">
        <CodeEditor v-model="sample.body" :language="lang" :variables="false" />
      </div>
    </div>
    <div v-else class="flex flex-1 items-center justify-center text-zinc-500">No samples yet.</div>
  </div>
</template>
