<!-- Compare two responses: changed JSON paths, a side-by-side body diff and a header diff. -->
<script setup>
import { computed, ref, watch } from 'vue'
import { ArrowLeftRight } from 'lucide-vue-next'
import Modal from './Modal.vue'
import UiSelect from './UiSelect.vue'
import { activeRequest, activeResponse, openTabs, state } from '../store.js'
import { diffLines, diffStats, inlineChange, jsonChanges, sideBySide, sortKeysDeep } from '../lib/diff.js'
import { formatSize, statusColor } from '../lib/ui.js'

const emit = defineEmits(['close'])
const req = activeRequest

// ---- what can be compared --------------------------------------------------------------
const clock = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour12: false })
const parseJson = (t) => {
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}
const fromResponse = (r) => ({ status: r.status, statusText: r.statusText, time: r.time, size: r.size, headers: r.headers || [], body: r.body || '', doc: r.json !== undefined ? r.json : r.lines, lines: !!r.lines && r.json === undefined })

const sources = computed(() => {
  const out = []
  const id = req.value?.id
  if (activeResponse.value && !activeResponse.value.binary) out.push({ id: 'current', label: `This response · ${activeResponse.value.status} · ${clock(activeResponse.value.at || Date.now())}`, ...fromResponse(activeResponse.value) })
  ;(state.responseLog[id] || []).forEach((r, i) => out.push({ id: `past:${i}`, label: `Earlier response · ${r.status} · ${clock(r.at)}`, ...fromResponse(r) }))
  for (const s of req.value?.samples || []) {
    const doc = parseJson(s.body || '')
    out.push({ id: `sample:${s.id}`, label: `Sample: ${s.name}`, status: Number(s.status), statusText: '', time: null, size: new Blob([s.body || '']).size, headers: (s.headers || []).filter((h) => h.enabled !== false && h.key), body: s.body || '', doc, lines: false })
  }
  for (const t of openTabs.value) {
    const rid = t.tab.requestId
    const r = state.responses[rid]
    if (rid === id || !r || r.binary) continue
    out.push({ id: `tab:${rid}`, label: `Tab: ${t.req?.name || 'request'} · ${r.status}`, ...fromResponse(r) })
  }
  return out
})
const options = computed(() => sources.value.map((s) => ({ value: s.id, label: s.label })))

// default: the previous response (else the first sample, else another tab) → this response
const leftId = ref(sources.value.find((s) => s.id !== 'current')?.id || null)
const rightId = ref(sources.value.some((s) => s.id === 'current') ? 'current' : sources.value[0]?.id || null)
const left = computed(() => sources.value.find((s) => s.id === leftId.value) || null)
const right = computed(() => sources.value.find((s) => s.id === rightId.value) || null)
const swap = () => ([leftId.value, rightId.value] = [rightId.value, leftId.value])

// ---- options ---------------------------------------------------------------------------------
const sortKeys = ref(true)
const showAll = ref(false)
const ignoreVolatile = ref(true)
const VOLATILE = /^(date|age|expires|last-modified|etag|x-request-id|x-correlation-id|x-trace-id|traceparent|cf-ray|x-amzn-requestid|x-amzn-trace-id|x-amz-cf-id|server-timing|report-to|nel|x-runtime|x-response-time)$/i

const bothJson = computed(() => left.value?.doc !== undefined && right.value?.doc !== undefined)
const view = ref('changes')
watch(bothJson, (j) => !j && view.value === 'changes' && (view.value = 'body'), { immediate: true })
const views = computed(() => [...(bothJson.value ? [{ id: 'changes', label: 'Changes' }] : []), { id: 'body', label: 'Body' }, { id: 'headers', label: 'Headers' }])

// ---- diffs ------------------------------------------------------------------------------------
const bodyText = (s) => {
  if (!s) return ''
  if (s.doc === undefined) return s.body
  const v = sortKeys.value ? sortKeysDeep(s.doc) : s.doc
  return s.lines ? v.map((l) => JSON.stringify(l, null, 2)).join('\n') : JSON.stringify(v, null, 2)
}
const headerText = (s) =>
  (s?.headers || [])
    .filter((h) => !(ignoreVolatile.value && VOLATILE.test(h.key)))
    .map((h) => `${h.key.toLowerCase()}: ${h.value}`)
    .sort()
    .join('\n')

const bodyDiff = computed(() => (left.value && right.value ? diffLines(bodyText(left.value), bodyText(right.value)) : null))
const headerDiff = computed(() => (left.value && right.value ? diffLines(headerText(left.value), headerText(right.value)) : null))
const current = computed(() => (view.value === 'headers' ? headerDiff.value : bodyDiff.value))
const rows = computed(() => (current.value ? sideBySide(current.value.ops, { context: showAll.value ? null : 3 }) : []))
const stats = computed(() => (current.value ? diffStats(current.value.ops) : { added: 0, removed: 0 }))

const changes = computed(() => {
  if (!bothJson.value) return []
  return jsonChanges(left.value.doc, right.value.doc)
})
const show = (v) => {
  const s = JSON.stringify(v)
  return s === undefined ? 'undefined' : s.length > 140 ? s.slice(0, 140) + '…' : s
}

// paired removed / added lines: highlight the part that differs
const parts = (row, side) => {
  const cell = row[side]
  const other = row[side === 'left' ? 'right' : 'left']
  if (!cell || cell.type === 'equal' || !other || other.type === 'equal') return null
  return inlineChange(row.left.text, row.right.text, side)
}
const cellClass = (c) => (!c ? 'bg-zinc-900/40' : c.type === 'del' ? 'bg-red-500/10 text-red-200' : c.type === 'add' ? 'bg-emerald-500/10 text-emerald-200' : 'text-zinc-400')
const identical = computed(() => current.value && !stats.value.added && !stats.value.removed)
</script>

<template>
  <Modal title="Compare responses" width="max-w-7xl" @close="emit('close')">
    <div class="flex h-[76vh] min-h-0 flex-col text-sm">
      <p v-if="sources.length < 2" class="m-6 rounded border border-zinc-800 bg-zinc-900/60 p-4 text-zinc-400">
        There is nothing to compare this response with yet. Send the request again (earlier responses are kept for this session), save a response as a Sample, or open
        another request that has a response.
      </p>
      <template v-else>
        <!-- pick the two sides -->
        <div class="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <UiSelect v-model="leftId" :options="options" class="w-80 max-w-full" button-class="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm" />
          <button class="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Swap sides" @click="swap"><ArrowLeftRight :size="15" /></button>
          <UiSelect v-model="rightId" :options="options" class="w-80 max-w-full" button-class="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm" />
          <div v-if="left && right" class="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs">
            <span :class="left.status === right.status ? 'text-zinc-500' : 'text-amber-400'">
              status <span :class="statusColor(left.status)">{{ left.status }}</span> → <span :class="statusColor(right.status)">{{ right.status }}</span>
            </span>
            <span v-if="left.time !== null && right.time !== null" class="text-zinc-500">{{ left.time }} → {{ right.time }} ms</span>
            <span class="text-zinc-500">{{ formatSize(left.size) }} → {{ formatSize(right.size) }}</span>
          </div>
        </div>

        <!-- view + options -->
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-xs">
          <nav class="flex gap-1">
            <button v-for="v in views" :key="v.id" class="rounded px-2 py-1" :class="view === v.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'" @click="view = v.id">
              {{ v.label }}<span v-if="v.id === 'changes'" class="ml-1" :class="changes.length ? 'text-amber-400' : 'text-emerald-400'">{{ changes.length }}</span>
            </button>
          </nav>
          <span v-if="view !== 'changes'" class="font-mono"><span class="text-emerald-400">+{{ stats.added }}</span> <span class="text-red-400">−{{ stats.removed }}</span></span>
          <span class="ml-auto flex flex-wrap items-center gap-4 text-zinc-400">
            <label v-if="view === 'body' && bothJson" class="inline-flex items-center gap-1.5"><input v-model="sortKeys" type="checkbox" class="accent-orange-500" /> Ignore key order</label>
            <label v-if="view === 'headers'" class="inline-flex items-center gap-1.5" title="date, etag, request / trace ids, server timing…"><input v-model="ignoreVolatile" type="checkbox" class="accent-orange-500" /> Ignore headers that change every time</label>
            <label v-if="view !== 'changes'" class="inline-flex items-center gap-1.5"><input v-model="showAll" type="checkbox" class="accent-orange-500" /> Show unchanged lines</label>
          </span>
        </div>

        <!-- JSON changes -->
        <div v-if="view === 'changes'" class="min-h-0 flex-1 overflow-auto px-4 pb-4">
          <p v-if="!changes.length" class="py-10 text-center text-emerald-400">Same JSON on both sides.</p>
          <table v-else class="w-full font-mono text-[12px]">
            <tbody>
              <tr v-for="c in changes" :key="c.path + c.type" class="border-t border-zinc-800 align-top">
                <td class="w-20 py-1.5 pr-3 font-sans text-xs" :class="{ added: 'text-emerald-400', removed: 'text-red-400', changed: 'text-amber-400' }[c.type]">{{ c.type }}</td>
                <td class="py-1.5 pr-4 break-all text-zinc-200">{{ c.path }}</td>
                <td class="py-1.5 break-all">
                  <span v-if="c.type !== 'added'" class="text-red-300">{{ show(c.from) }}</span>
                  <span v-if="c.type === 'changed'" class="px-1.5 text-zinc-600">→</span>
                  <span v-if="c.type !== 'removed'" class="text-emerald-300">{{ show(c.to) }}</span>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="changes.length >= 1000" class="pt-2 text-xs text-zinc-500">Showing the first 1000 differences.</p>
        </div>

        <!-- side-by-side line diff -->
        <div v-else class="min-h-0 flex-1 overflow-auto pb-4 font-mono text-[12px]">
          <p v-if="current?.truncated" class="mx-4 mb-2 rounded bg-amber-500/10 px-3 py-1.5 font-sans text-xs text-amber-400">The two sides are too different to line up; everything is shown as changed.</p>
          <p v-if="identical" class="py-10 text-center font-sans text-emerald-400">{{ view === 'headers' ? 'Same headers' : 'Same body' }} on both sides.</p>
          <div v-else class="grid grid-cols-2">
            <template v-for="(r, i) in rows" :key="i">
              <button v-if="r.gap" class="col-span-2 border-y border-zinc-800 bg-zinc-900/60 py-1 font-sans text-xs text-zinc-500 hover:text-zinc-200" @click="showAll = true">
                ⋯ {{ r.gap }} unchanged line{{ r.gap === 1 ? '' : 's' }}
              </button>
              <template v-else>
                <div v-for="side in ['left', 'right']" :key="side" class="flex min-w-0" :class="[cellClass(r[side]), side === 'left' ? 'border-r border-zinc-800' : '']">
                  <span class="w-12 shrink-0 pr-2 text-right text-zinc-600 select-none">{{ r[side]?.n }}</span>
                  <span class="w-4 shrink-0 text-zinc-500 select-none">{{ r[side]?.type === 'del' ? '−' : r[side]?.type === 'add' ? '+' : '' }}</span>
                  <span v-if="parts(r, side)" class="min-w-0 flex-1 pr-2 break-all whitespace-pre-wrap"
                    >{{ parts(r, side).pre }}<mark class="rounded-sm text-inherit" :class="side === 'left' ? 'bg-red-500/35' : 'bg-emerald-500/35'">{{ parts(r, side).mid }}</mark>{{ parts(r, side).post }}</span
                  >
                  <span v-else class="min-w-0 flex-1 pr-2 break-all whitespace-pre-wrap">{{ r[side]?.text }}</span>
                </div>
              </template>
            </template>
          </div>
        </div>
      </template>
    </div>
  </Modal>
</template>
