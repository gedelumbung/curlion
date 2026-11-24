<!-- Collection Runner: send the saved requests of a collection or folder in order and report the tests. -->
<script setup>
import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import { Check, ChevronRight, Download, Loader2, Play, Square, X } from 'lucide-vue-next'
import Modal from './Modal.vue'
import { activeEnv, isDirty, runCollection, runnableRequests, state } from '../store.js'
import { summarize } from '../lib/assertions.js'
import { downloadJson, formatSize, requestBadge, statusColor } from '../lib/ui.js'

const props = defineProps({
  collection: { type: Object, required: true },
  folder: { type: Object, default: null },
})
const emit = defineEmits(['close'])

const list = runnableRequests(props.collection, props.folder?.id)
const picked = reactive(Object.fromEntries(list.map((r) => [r.id, !r.skip])))
const runnable = computed(() => list.filter((r) => !r.skip && picked[r.id]))
const unsaved = computed(() => list.filter((r) => picked[r.id] && isDirty(r.id)).length)
const opts = reactive({ iterations: 1, delay: 0, stopOnFail: false })

const running = ref(false)
const results = ref([])
const summary = ref(null)
const open = ref({}) // expanded result rows
let controller = null

async function run() {
  running.value = true
  results.value = []
  summary.value = null
  open.value = {}
  controller = new AbortController()
  try {
    const out = await runCollection({
      col: props.collection,
      ids: runnable.value.map((r) => r.id),
      iterations: Math.min(100, Math.max(1, Number(opts.iterations) || 1)),
      delay: Math.max(0, Number(opts.delay) || 0),
      stopOnFail: opts.stopOnFail,
      signal: controller.signal,
      onResult: (r) => {
        results.value.push(r)
        if (r.error || r.tests.some((t) => !t.ok)) open.value[results.value.length - 1] = true
      },
    })
    summary.value = out.summary
  } finally {
    running.value = false
    controller = null
  }
}
const stop = () => controller?.abort()
onBeforeUnmount(stop)

const live = computed(() => {
  const tests = summarize(results.value.flatMap((r) => r.tests))
  return { ...tests, errors: results.value.filter((r) => r.error).length }
})
const wrapVar = (name) => '{' + '{' + name + '}' + '}'
const failedRow = (r) => !!r.error || r.tests.some((t) => !t.ok)

function exportReport() {
  const name = props.folder ? `${props.collection.name} - ${props.folder.name}` : props.collection.name
  downloadJson(
    {
      collection: props.collection.name,
      folder: props.folder?.name || null,
      environment: activeEnv.value?.name || null,
      mode: state.mode,
      ranAt: new Date().toISOString(),
      options: { ...opts },
      summary: summary.value,
      results: results.value.map(({ body, ...r }) => r),
    },
    `${name.replace(/[^\w-]+/g, '_')}.run.json`,
  )
}
const title = computed(() => `Run ${props.folder ? `"${props.folder.name}"` : `"${props.collection.name}"`}`)
</script>

<template>
  <Modal :title="title" width="max-w-4xl" @close="emit('close')">
    <div class="grid min-h-[60vh] text-sm md:grid-cols-[280px_1fr]">
      <!-- Setup -->
      <aside class="space-y-4 border-b border-zinc-800 p-4 md:border-r md:border-b-0">
        <div>
          <p class="mb-1 text-xs text-zinc-500">Requests <span class="text-zinc-600">(saved versions, in sidebar order)</span></p>
          <ul class="max-h-64 space-y-0.5 overflow-auto">
            <li v-for="r in list" :key="r.id">
              <label class="flex items-center gap-2 rounded px-1 py-0.5" :class="r.skip ? 'opacity-50' : 'cursor-pointer hover:bg-zinc-800/60'" :title="r.skip || r.path">
                <input v-model="picked[r.id]" type="checkbox" class="accent-orange-500" :disabled="!!r.skip || running" />
                <span class="w-10 shrink-0 font-mono text-[10px] font-bold" :class="requestBadge(r).class">{{ requestBadge(r, { short: true }).label }}</span>
                <span class="truncate">{{ r.name }}</span>
              </label>
            </li>
          </ul>
          <p v-if="!list.length" class="text-xs text-zinc-500">No requests here yet.</p>
          <p v-if="unsaved" class="mt-2 text-xs text-amber-400">{{ unsaved }} request{{ unsaved === 1 ? ' has' : 's have' }} unsaved changes; the saved version{{ unsaved === 1 ? ' is' : 's are' }} run.</p>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <label class="text-xs text-zinc-500">Iterations<input v-model.number="opts.iterations" type="number" min="1" max="100" :disabled="running" class="field mt-1 w-full text-sm text-zinc-200 outline-none" /></label>
          <label class="text-xs text-zinc-500">Delay (ms)<input v-model.number="opts.delay" type="number" min="0" step="100" :disabled="running" class="field mt-1 w-full text-sm text-zinc-200 outline-none" /></label>
        </div>
        <label class="flex items-center gap-2 text-zinc-300"><input v-model="opts.stopOnFail" type="checkbox" class="accent-orange-500" :disabled="running" /> Stop at the first failure</label>
        <p class="text-xs text-zinc-500">
          Environment: <span class="text-zinc-300">{{ activeEnv?.name || 'none (Globals only)' }}</span> · Mode: <span class="text-zinc-300 capitalize">{{ state.mode }}</span>. Post-Response values are set as the run goes, so later requests can use them.
        </p>
        <button v-if="!running" class="inline-flex w-full items-center justify-center gap-2 rounded bg-orange-500 py-2 font-semibold text-on-accent hover:bg-orange-600 disabled:opacity-40" :disabled="!runnable.length" @click="run">
          <Play :size="15" /> Run {{ runnable.length }} request{{ runnable.length === 1 ? '' : 's' }}
        </button>
        <button v-else class="inline-flex w-full items-center justify-center gap-2 rounded bg-zinc-700 py-2 font-semibold text-zinc-100 hover:bg-zinc-600" @click="stop"><Square :size="14" /> Stop</button>
      </aside>

      <!-- Results -->
      <section class="flex min-h-0 flex-col">
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-zinc-800 px-4 py-2 text-xs">
          <span v-if="running" class="inline-flex items-center gap-1.5 text-zinc-400"><Loader2 :size="13" class="animate-spin" /> Running…</span>
          <span class="text-zinc-400">{{ results.length }} sent</span>
          <span class="text-emerald-400">{{ live.passed }} passed</span>
          <span :class="live.failed ? 'text-red-400' : 'text-zinc-500'">{{ live.failed }} failed</span>
          <span v-if="live.errors" class="text-red-400">{{ live.errors }} error{{ live.errors === 1 ? '' : 's' }}</span>
          <span v-if="summary" class="text-zinc-500">{{ (summary.duration / 1000).toFixed(1) }} s{{ summary.aborted ? ' · stopped' : '' }}</span>
          <button v-if="summary && results.length" class="ml-auto inline-flex items-center gap-1 rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" @click="exportReport"><Download :size="13" /> Export report</button>
        </div>
        <p v-if="!results.length && !running" class="p-8 text-center text-zinc-500">Pick the requests and press Run. Add checks to a request in its Tests tab.</p>
        <ol class="min-h-0 flex-1 overflow-auto">
          <li v-for="(r, i) in results" :key="i" class="border-b border-zinc-800/70">
            <button class="flex w-full items-center gap-2 px-4 py-1.5 text-left hover:bg-zinc-900" @click="open[i] = !open[i]">
              <ChevronRight :size="13" class="shrink-0 text-zinc-500 transition-transform" :class="{ 'rotate-90': open[i] }" />
              <Check v-if="!failedRow(r)" :size="14" class="shrink-0 text-emerald-400" /><X v-else :size="14" class="shrink-0 text-red-400" />
              <span v-if="opts.iterations > 1" class="w-8 shrink-0 text-xs text-zinc-600">#{{ r.iteration }}</span>
              <span class="w-10 shrink-0 font-mono text-[10px] font-bold" :class="requestBadge(r).class">{{ requestBadge(r, { short: true }).label }}</span>
              <span class="min-w-0 flex-1 truncate">{{ r.name }}</span>
              <span v-if="r.tests.length" class="text-xs" :class="r.tests.every((t) => t.ok) ? 'text-emerald-400' : 'text-red-400'">{{ r.tests.filter((t) => t.ok).length }}/{{ r.tests.length }}</span>
              <span v-if="r.status !== null" class="w-16 text-right font-mono text-xs" :class="statusColor(r.status)">{{ r.status }}</span>
              <span v-if="r.time !== null" class="w-16 text-right font-mono text-xs text-zinc-500">{{ r.time }} ms</span>
            </button>
            <div v-if="open[i]" class="space-y-1 px-11 pb-3 text-xs">
              <p v-if="r.url" class="font-mono break-all text-zinc-500">{{ r.url }}<span v-if="r.size !== null"> · {{ formatSize(r.size) }}</span></p>
              <p v-if="r.error" class="text-red-400">{{ r.error }}</p>
              <p v-for="t in r.tests" :key="t.id" class="flex items-start gap-1.5" :class="t.ok ? 'text-zinc-400' : 'text-red-300'">
                <Check v-if="t.ok" :size="12" class="mt-0.5 shrink-0 text-emerald-400" /><X v-else :size="12" class="mt-0.5 shrink-0" />
                <span>{{ t.name }} <span class="font-mono text-zinc-500">{{ t.message }}</span></span>
              </p>
              <p v-for="x in r.extracted" :key="x.variable" :class="x.ok ? 'text-zinc-500' : 'text-amber-400'">{{ x.ok ? `Set ${wrapVar(x.variable)} in ${x.env}` : `${wrapVar(x.variable)}: ${x.message}` }}</p>
              <p v-if="!r.error && !r.tests.length" class="text-zinc-600">No tests on this request.</p>
              <pre v-if="r.body && failedRow(r)" class="mt-1 max-h-48 overflow-auto rounded bg-zinc-950 p-2 font-mono text-[11px] whitespace-pre-wrap text-zinc-400">{{ r.body.slice(0, 4000) }}</pre>
            </div>
          </li>
        </ol>
      </section>
    </div>
  </Modal>
</template>
