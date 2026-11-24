<!-- Connection log for WebSocket / Socket.IO / SSE requests (replaces the response pane). -->
<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { ArrowDown, ArrowUp, Copy, Info, Search, Trash2, TriangleAlert } from 'lucide-vue-next'
import { activeRequest, clearConnLog, state } from '../store.js'
import { copyText } from '../lib/ui.js'
import { indentString } from '../lib/settings.js'

const req = activeRequest
const conn = computed(() => state.conns[req.value?.id] || null)
const filter = ref('')
const expanded = ref(new Set())
const list = ref(null)

const text = (d) => (typeof d === 'string' ? d : JSON.stringify(d))
const pretty = (d) => {
  if (typeof d !== 'string') return JSON.stringify(d, null, indentString())
  try {
    return JSON.stringify(JSON.parse(d), null, indentString())
  } catch {
    return d
  }
}
const entries = computed(() => {
  const all = conn.value?.log || []
  const q = filter.value.trim().toLowerCase()
  return q ? all.filter((e) => `${e.event || ''} ${text(e.data)}`.toLowerCase().includes(q)) : all
})
const counts = computed(() => {
  const all = conn.value?.log || []
  return { in: all.filter((e) => e.dir === 'in').length, out: all.filter((e) => e.dir === 'out').length }
})
const time = (ts) => {
  const d = new Date(ts)
  return `${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
}
function toggle(e) {
  const s = new Set(expanded.value)
  s.has(e.id) ? s.delete(e.id) : s.add(e.id)
  expanded.value = s
}

// keep the newest message in view unless the user scrolled up
watch(
  () => conn.value?.log.length,
  async () => {
    const el = list.value
    const atBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40
    await nextTick()
    if (atBottom && list.value) list.value.scrollTop = list.value.scrollHeight
  },
)

const statusLabel = { connecting: 'Connecting…', open: 'Connected', closed: 'Disconnected' }
const statusDot = { connecting: 'bg-amber-400 animate-pulse', open: 'bg-emerald-500', closed: 'bg-zinc-600' }
</script>

<template>
  <section class="flex min-h-0 flex-col border-t border-zinc-800">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-sm">
      <span class="font-medium text-zinc-300">Messages</span>
      <span v-if="conn" class="inline-flex items-center gap-1.5 text-xs text-zinc-400">
        <span class="h-2 w-2 rounded-full" :class="statusDot[conn.status]"></span>{{ statusLabel[conn.status] }}
      </span>
      <span v-if="conn && conn.protocol === 'sse'" class="font-mono text-xs text-zinc-500">↓ {{ counts.in }} event{{ counts.in === 1 ? '' : 's' }}</span>
      <span v-else-if="conn" class="font-mono text-xs text-zinc-500">↑ {{ counts.out }} · ↓ {{ counts.in }}</span>
      <div class="ml-auto flex h-7 items-center gap-1.5 rounded-md bg-zinc-900 px-2">
        <Search :size="13" class="text-zinc-500" />
        <input v-model="filter" placeholder="Filter" class="w-40 bg-transparent text-xs outline-none placeholder:text-zinc-600" />
      </div>
      <button class="icon-btn" title="Clear messages" :disabled="!conn?.log.length" @click="clearConnLog(req.id)"><Trash2 :size="14" /></button>
    </div>

    <div ref="list" class="min-h-0 flex-1 overflow-y-auto pb-2 font-mono text-[12px]">
      <p v-if="!conn" class="px-4 py-10 text-center font-sans text-sm text-zinc-500">{{ req?.protocol === 'sse' ? 'Connect to watch events arrive.' : 'Connect to start sending and receiving messages.' }}</p>
      <div
        v-for="e in entries"
        :key="e.id"
        class="group border-b border-zinc-900 px-4 py-1.5"
        :class="{ 'cursor-pointer hover:bg-zinc-900/60': e.dir === 'in' || e.dir === 'out' }"
        @click="(e.dir === 'in' || e.dir === 'out') && toggle(e)"
      >
        <div class="flex items-start gap-2">
          <ArrowUp v-if="e.dir === 'out'" :size="13" class="mt-0.5 shrink-0 text-emerald-400" />
          <ArrowDown v-else-if="e.dir === 'in'" :size="13" class="mt-0.5 shrink-0 text-sky-400" />
          <TriangleAlert v-else-if="e.dir === 'error'" :size="13" class="mt-0.5 shrink-0 text-red-400" />
          <Info v-else :size="13" class="mt-0.5 shrink-0 text-zinc-500" />
          <span v-if="e.event" class="shrink-0 rounded bg-zinc-800 px-1.5 text-[11px] text-sky-300">{{ e.event }}</span>
          <span v-if="e.eventId" class="shrink-0 text-[11px] text-zinc-500" title="Event id (sent back as Last-Event-ID when reconnecting)">#{{ e.eventId }}</span>
          <span class="min-w-0 flex-1" :class="[e.dir === 'error' ? 'text-red-400' : e.dir === 'info' ? 'font-sans text-xs text-zinc-500' : 'text-zinc-200', expanded.has(e.id) ? '' : 'truncate']">{{ text(e.data) }}</span>
          <button v-if="e.dir === 'in' || e.dir === 'out'" class="shrink-0 rounded p-0.5 text-zinc-500 opacity-0 group-hover:opacity-100 hover:text-zinc-100" title="Copy" @click.stop="copyText(text(e.data))"><Copy :size="12" /></button>
          <span class="shrink-0 text-[11px] text-zinc-600">{{ time(e.ts) }}</span>
        </div>
        <pre v-if="expanded.has(e.id)" class="mt-1.5 ml-5 overflow-x-auto rounded bg-zinc-900 p-2 text-[12px] whitespace-pre-wrap text-zinc-300">{{ pretty(e.data) }}</pre>
      </div>
    </div>
  </section>
</template>
