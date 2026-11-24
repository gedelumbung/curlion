<!-- Response status line extras: network, time and size, each with a details popover. -->
<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { ArrowDown, ArrowUp, GlobeLock, Timer } from 'lucide-vue-next'
import { formatSize } from '../lib/ui.js'
import { networkTime } from '../lib/metrics.js'

const props = defineProps({ res: { type: Object, required: true } })
const m = computed(() => props.res.metrics || null)

// ---- popovers: open on hover (with a short delay) or click; one at a time -------------------
const open = ref(null) // 'network' | 'time' | 'size'
const pinned = ref(false)
let timer = null
function enter(which) {
  clearTimeout(timer)
  if (pinned.value && open.value !== which) return
  timer = setTimeout(() => (open.value = which), open.value ? 0 : 250)
}
function leave() {
  clearTimeout(timer)
  if (!pinned.value) timer = setTimeout(() => (open.value = null), 200)
}
function toggle(which) {
  clearTimeout(timer)
  if (open.value === which && pinned.value) {
    open.value = null
    pinned.value = false
  } else {
    open.value = which
    pinned.value = true
  }
}
function onDocDown(e) {
  if (pinned.value && !e.target.closest?.('[data-response-meta]')) {
    open.value = null
    pinned.value = false
  }
}
document.addEventListener('pointerdown', onDocDown, true)
onBeforeUnmount(() => {
  clearTimeout(timer)
  document.removeEventListener('pointerdown', onDocDown, true)
})

// ---- time --------------------------------------------------------------------------------------
const PHASES = [
  { key: 'prepare', label: 'Prepare', outside: true, color: 'bg-zinc-600' },
  { key: 'socket', label: 'Socket Initialization', color: 'bg-amber-400' },
  { key: 'dns', label: 'DNS Lookup', color: 'bg-teal-400' },
  { key: 'tcp', label: 'TCP Handshake', color: 'bg-orange-400' },
  { key: 'tls', label: 'SSL Handshake', color: 'bg-violet-400' },
  { key: 'ttfb', label: 'Waiting (TTFB)', color: 'bg-red-400' },
  { key: 'download', label: 'Download', color: 'bg-emerald-400' },
  { key: 'process', label: 'Process', outside: true, color: 'bg-zinc-600' },
]
const fmtMs = (v) => (typeof v === 'number' ? `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)} ms` : v === 'reused' ? 'Reused' : '—')
const total = computed(() => (m.value ? networkTime(m.value.timing) : props.res.time))
/** Waterfall: each phase starts where the previous one ended. */
const bars = computed(() => {
  if (!m.value) return []
  const t = m.value.timing
  const span = PHASES.reduce((n, p) => n + (typeof t[p.key] === 'number' ? t[p.key] : 0), 0) || 1
  let at = 0
  return PHASES.map((p) => {
    const v = t[p.key]
    const w = typeof v === 'number' ? v : 0
    const bar = { ...p, value: v, left: (at / span) * 100, width: Math.max((w / span) * 100, typeof v === 'number' ? 0.6 : 0) }
    at += w
    return bar
  })
})

// ---- size ----------------------------------------------------------------------------------------
const size = computed(() => m.value?.size || null)
const approx = (v, estimated) => (v === null || v === undefined ? '—' : `${estimated ? '≈ ' : ''}${formatSize(v)}`)
const responseTotal = computed(() => (size.value ? (size.value.responseHeaders || 0) + (size.value.responseBody || 0) : props.res.size))
const requestTotal = computed(() => (size.value ? (size.value.requestHeaders || 0) + (size.value.requestBody || 0) : null))
const encoding = computed(() => props.res.headers?.find((h) => h.key.toLowerCase() === 'content-encoding')?.value || '')

// ---- network ------------------------------------------------------------------------------------
const net = computed(() => m.value?.network || null)
const validTo = computed(() => {
  const v = net.value?.validTo
  if (!v) return null
  const d = new Date(v)
  const days = Math.round((d - Date.now()) / 86_400_000)
  return { text: v, soon: days < 30, days }
})
const rowsNet = computed(() => {
  const n = net.value || {}
  return [
    [
      ['HTTP Version', n.httpVersion],
      ['Local Address', n.localAddress],
      ['Remote Address', n.remoteAddress],
      ...(n.redirects ? [['Redirects', String(n.redirects)]] : []),
    ],
    n.tlsProtocol || n.cipher
      ? [
          ['TLS Protocol', n.tlsProtocol],
          ['Cipher Name', n.cipher],
        ]
      : [],
    n.certCN || n.issuerCN
      ? [
          ['Certificate CN', n.certCN],
          ['Issuer CN', n.issuerCN],
        ]
      : [],
  ].filter((g) => g.length)
})
</script>

<template>
  <span class="relative flex items-center gap-3" data-response-meta>
    <!-- Network -->
    <button
      class="rounded p-0.5 hover:bg-zinc-800"
      :class="open === 'network' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'"
      title="Network"
      @mouseenter="enter('network')"
      @mouseleave="leave"
      @click="toggle('network')"
    >
      <GlobeLock :size="14" />
    </button>
    <!-- Time -->
    <button class="rounded px-1 font-mono text-xs hover:bg-zinc-800" :class="open === 'time' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'" @mouseenter="enter('time')" @mouseleave="leave" @click="toggle('time')">
      {{ res.time }} ms
    </button>
    <!-- Size -->
    <button class="rounded px-1 font-mono text-xs hover:bg-zinc-800" :class="open === 'size' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'" @mouseenter="enter('size')" @mouseleave="leave" @click="toggle('size')">
      {{ formatSize(res.size) }}
    </button>

    <div
      v-if="open"
      class="absolute top-full right-0 z-50 mt-2 w-[26rem] max-w-[calc(100vw-2rem)] rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-[13px] shadow-2xl shadow-black/50"
      @mouseenter="enter(open)"
      @mouseleave="leave"
    >
      <!-- Network -->
      <template v-if="open === 'network'">
        <p class="mb-3 flex items-center gap-2 font-semibold text-zinc-100"><GlobeLock :size="15" class="text-zinc-400" /> Network</p>
        <div v-for="(group, gi) in rowsNet" :key="gi" class="space-y-1.5" :class="gi ? 'mt-3 border-t border-zinc-800 pt-3' : ''">
          <div v-for="[label, value] in group" :key="label" class="grid grid-cols-[9rem_1fr] gap-3 pl-6">
            <span class="text-zinc-500">{{ label }}</span>
            <span class="font-mono text-xs break-all" :class="value ? 'text-zinc-200' : 'text-zinc-600'">{{ value || '—' }}</span>
          </div>
        </div>
        <div v-if="validTo" class="mt-1.5 grid grid-cols-[9rem_1fr] gap-3 pl-6">
          <span class="text-zinc-500">Valid Until</span>
          <span class="font-mono text-xs" :class="validTo.soon ? 'text-amber-400' : 'text-zinc-200'" :title="validTo.days >= 0 ? `${validTo.days} days left` : 'expired'">{{ validTo.text }}</span>
        </div>
        <p v-if="net?.authorized === false" class="mt-3 pl-6 text-xs text-amber-400">The certificate was not verified (the agent accepts self-signed certificates unless started with --strict-tls).</p>
        <p v-if="!net?.remoteAddress && m?.note" class="mt-3 border-t border-zinc-800 pt-3 text-xs text-zinc-500">{{ m.note }}</p>
        <p v-else-if="!m" class="mt-3 text-xs text-zinc-500">No network details for this response.</p>
      </template>

      <!-- Time -->
      <template v-else-if="open === 'time'">
        <p class="mb-3 flex items-center gap-2 font-semibold text-zinc-100">
          <Timer :size="15" class="text-zinc-400" /> Response Time <span class="ml-auto font-mono">{{ fmtMs(total) }}</span>
        </p>
        <template v-if="m">
          <div v-for="b in bars" :key="b.key" class="grid grid-cols-[9.5rem_1fr_4.5rem] items-center gap-3 py-0.5" :class="b.outside ? 'text-zinc-600' : 'text-zinc-300'">
            <span>{{ b.label }}</span>
            <span class="relative h-3.5 border-x border-zinc-800">
              <span v-if="typeof b.value === 'number'" class="absolute inset-y-0 rounded-sm" :class="[b.color, b.outside ? 'opacity-40' : '']" :style="{ left: b.left + '%', width: b.width + '%' }"></span>
            </span>
            <span class="text-right font-mono text-xs" :class="b.value === null ? 'text-zinc-600' : ''">{{ fmtMs(b.value) }}</span>
          </div>
          <p v-if="m.note" class="mt-3 border-t border-zinc-800 pt-3 text-xs text-zinc-500">{{ m.note }}</p>
          <p v-else class="mt-3 border-t border-zinc-800 pt-3 text-xs text-zinc-500">Prepare (variables, auth, tokens) and Process (tests, extraction) are not part of the response time.</p>
        </template>
        <p v-else class="text-xs text-zinc-500">No timing details for this response.</p>
      </template>

      <!-- Size -->
      <template v-else>
        <template v-if="size">
          <div class="flex items-center gap-2 font-semibold text-zinc-100">
            <span class="flex h-5 w-5 items-center justify-center rounded bg-sky-500/20 text-sky-400"><ArrowDown :size="13" /></span>
            Response Size <span class="ml-auto font-mono">{{ approx(responseTotal, size.estimated.responseHeaders) }}</span>
          </div>
          <div class="mt-1.5 space-y-1 pl-7 text-zinc-400">
            <p class="flex justify-between"><span>Headers</span><span class="font-mono text-xs">{{ approx(size.responseHeaders, size.estimated.responseHeaders) }}</span></p>
            <p class="flex justify-between"><span>Body</span><span class="font-mono text-xs">{{ approx(size.responseBody) }}</span></p>
            <p v-if="size.responseBody !== size.responseBodyDecoded" class="flex justify-between text-zinc-500">
              <span>Uncompressed{{ encoding ? ` (${encoding})` : '' }}</span><span class="font-mono text-xs">{{ approx(size.responseBodyDecoded) }}</span>
            </p>
          </div>
          <div class="mt-3 flex items-center gap-2 border-t border-zinc-800 pt-3 font-semibold text-zinc-100">
            <span class="flex h-5 w-5 items-center justify-center rounded bg-amber-500/20 text-amber-400"><ArrowUp :size="13" /></span>
            Request Size <span class="ml-auto font-mono">{{ approx(requestTotal, size.estimated.requestHeaders) }}</span>
          </div>
          <div class="mt-1.5 space-y-1 pl-7 text-zinc-400">
            <p class="flex justify-between"><span>Headers</span><span class="font-mono text-xs">{{ approx(size.requestHeaders, size.estimated.requestHeaders) }}</span></p>
            <p class="flex justify-between"><span>Body</span><span class="font-mono text-xs">{{ approx(size.requestBody) }}</span></p>
          </div>
          <p v-if="size.estimated.requestHeaders || size.estimated.responseHeaders" class="mt-3 border-t border-zinc-800 pt-3 text-xs text-zinc-500">
            ≈ estimated from the headers Curlion knows about; the browser adds its own. Agent mode measures the bytes on the wire.
          </p>
        </template>
        <p v-else class="text-xs text-zinc-500">{{ formatSize(res.size) }} received.</p>
      </template>
    </div>
  </span>
</template>
