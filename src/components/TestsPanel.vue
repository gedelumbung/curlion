<!-- Request "Tests" tab: response checks without scripts, run after every send and by the Collection Runner. -->
<script setup>
import { computed } from 'vue'
import { Check, Plus, Trash2, X } from 'lucide-vue-next'
import UiSelect from './UiSelect.vue'
import VarInput from './VarInput.vue'
import { TEST_OPS, TEST_SOURCES, newTest, opTakesValue, sourceHasProperty } from '../lib/assertions.js'

const props = defineProps({
  request: { type: Object, required: true },
  results: { type: Array, default: null }, // tests of the last response, by id
})
const tests = computed(() => props.request.tests || [])
const sources = TEST_SOURCES.map((s) => ({ value: s.value, label: s.label }))
const ops = TEST_OPS.map((o) => ({ value: o.value, label: o.label }))
const placeholder = (t) => TEST_SOURCES.find((s) => s.value === t.source)?.property || ''
const resultFor = (t) => props.results?.find((r) => r.id === t.id)

const PRESETS = [
  { label: 'Status is 200', test: { source: 'status', op: 'eq', expected: '200' } },
  { label: 'Status is 2xx', test: { source: 'status', op: 'matches', expected: '^2\\d\\d$' } },
  { label: 'Faster than 500 ms', test: { source: 'time', op: 'lt', expected: '500' } },
  { label: 'JSON field exists', test: { source: 'json', property: 'data', op: 'exists', expected: '' } },
  { label: 'Content-Type is JSON', test: { source: 'header', property: 'Content-Type', op: 'contains', expected: 'application/json' } },
]

function add(patch) {
  ;(props.request.tests ||= []).push(newTest(patch))
}
function remove(t) {
  props.request.tests.splice(props.request.tests.indexOf(t), 1)
}
// sensible defaults when the source changes
function setSource(t, source) {
  t.source = source
  if (source === 'status') Object.assign(t, { op: 'eq', expected: '200', property: '' })
  else if (source === 'time') Object.assign(t, { op: 'lt', expected: '500', property: '' })
  else if (source === 'header' && !t.property) Object.assign(t, { property: 'Content-Type', op: 'contains', expected: 'json' })
  else if (source === 'json' && t.op === 'eq' && /^\d+$/.test(t.expected)) Object.assign(t, { op: 'exists', expected: '' })
}
</script>

<template>
  <div class="px-4 text-sm">
    <p class="mb-3 text-xs text-zinc-500">
      Checked after every response, and by the Collection Runner. Expected values can use <code v-pre class="text-emerald-400">{{variables}}</code>; regexes can be written as
      <code class="text-zinc-300">/^ok$/i</code>.
    </p>

    <div v-for="t in tests" :key="t.id" class="group mb-2 flex flex-wrap items-center gap-2">
      <input v-model="t.enabled" type="checkbox" class="accent-orange-500" title="Enabled" />
      <UiSelect :model-value="t.source" :options="sources" class="w-44" button-class="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[13px]" @update:model-value="setSource(t, $event)" />
      <input
        v-if="sourceHasProperty(t.source)"
        v-model="t.property"
        :placeholder="placeholder(t)"
        class="w-56 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-[13px] outline-none focus:border-zinc-500"
      />
      <UiSelect v-model="t.op" :options="ops" class="w-40" button-class="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[13px]" />
      <VarInput v-if="opTakesValue(t.op)" v-model="t.expected" :placeholder="t.op === 'type' ? 'string, number, boolean, object, array, null' : 'expected value'" class="field min-w-40 flex-1 py-1 font-mono text-[13px]" />
      <span v-else class="flex-1"></span>
      <button class="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-400" title="Remove" @click="remove(t)"><Trash2 :size="14" /></button>
      <span v-if="resultFor(t)" class="inline-flex w-full items-center gap-1 pl-6 font-mono text-xs" :class="resultFor(t).ok ? 'text-emerald-400' : 'text-red-400'">
        <Check v-if="resultFor(t).ok" :size="12" /><X v-else :size="12" /> last response: {{ resultFor(t).message }}
      </span>
    </div>

    <div class="mt-1 flex flex-wrap items-center gap-1">
      <button class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" @click="add()"><Plus :size="14" /> Add test</button>
      <span class="mx-1 text-xs text-zinc-600">or</span>
      <button v-for="p in PRESETS" :key="p.label" class="rounded border border-zinc-800 px-2 py-0.5 text-xs text-zinc-400 hover:border-zinc-600 hover:text-zinc-100" @click="add(p.test)">{{ p.label }}</button>
    </div>
  </div>
</template>
