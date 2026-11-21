<!-- Workspace-wide activity log: who did what, when, in which collection. -->
<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { Download, Loader2, RefreshCw, Search } from 'lucide-vue-next'
import Modal from './Modal.vue'
import UiSelect from './UiSelect.vue'
import { fetchAllActivity, state } from '../store.js'
import { ACTIONS, actionColor, describeLog } from '../lib/activity.js'

const emit = defineEmits(['close'])
const PAGE = 200

const PERIODS = [
  { id: '1', label: 'Last 24 hours', days: 1 },
  { id: '7', label: 'Last 7 days', days: 7 },
  { id: '30', label: 'Last 30 days', days: 30 },
  { id: 'all', label: 'All time', days: null },
]
const period = ref('7')
const actorId = ref('')
const collectionId = ref('')
const action = ref('')
const search = ref('')

const logs = ref([])
const loading = ref(false)
const hasMore = ref(false)
const error = ref('')
const knownUsers = ref(new Map()) // actor_id -> email, grows as entries load

function filters(extra = {}) {
  const days = PERIODS.find((p) => p.id === period.value)?.days
  return {
    actorId: actorId.value || null,
    collectionId: collectionId.value || null,
    action: action.value || null,
    search: search.value,
    since: days ? new Date(Date.now() - days * 86400_000).toISOString() : null,
    ...extra,
  }
}

async function load({ more = false } = {}) {
  loading.value = true
  error.value = ''
  try {
    const before = more ? logs.value.at(-1)?.created_at : null
    const rows = await fetchAllActivity(filters(before ? { before } : {}), PAGE)
    logs.value = more ? [...logs.value, ...rows] : rows
    hasMore.value = rows.length === PAGE
    for (const r of rows) if (r.actor_id && r.actor_email) knownUsers.value.set(r.actor_id, r.actor_email)
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (state.user) knownUsers.value.set(state.user.id, state.user.email)
  load()
})
watch([period, actorId, collectionId, action], () => load())
let searchTimer
watch(search, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(load, 300)
})

// ---- summary --------------------------------------------------------------
const REQUEST_ACTIONS = ['CREATE_REQUEST', 'UPDATE_REQUEST', 'DELETE_REQUEST']
const stats = computed(() => {
  const users = new Set(logs.value.map((l) => l.actor_id).filter(Boolean))
  return [
    { label: 'Events', value: logs.value.length + (hasMore.value ? '+' : '') },
    { label: 'Active users', value: users.size },
    { label: 'Request changes', value: logs.value.filter((l) => REQUEST_ACTIONS.includes(l.action)).length },
    { label: 'Sign-ins', value: logs.value.filter((l) => l.action === 'SIGN_IN').length },
  ]
})
const perUser = computed(() => {
  const counts = new Map()
  for (const l of logs.value) {
    const key = l.actor_email || 'deleted user'
    const c = counts.get(key) || { email: key, id: l.actor_id, total: 0, last: l.created_at }
    c.total++
    counts.set(key, c)
  }
  const list = [...counts.values()].sort((a, b) => b.total - a.total)
  const max = list[0]?.total || 1
  return list.slice(0, 8).map((u) => ({ ...u, pct: Math.max(4, Math.round((u.total / max) * 100)) }))
})

// ---- feed grouped by day ---------------------------------------------------
const dayKey = (iso) => new Date(iso).toDateString()
function dayLabel(iso) {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86400_000)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}
const groups = computed(() => {
  const out = []
  for (const l of logs.value) {
    const key = dayKey(l.created_at)
    if (out.at(-1)?.key !== key) out.push({ key, label: dayLabel(l.created_at), items: [] })
    out.at(-1).items.push(l)
  }
  return out
})
const time = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
const collectionLabel = (l) => {
  if (!l.collection_id && !l.collection_name) return null
  const live = state.collections.find((c) => c.id === l.collection_id)
  return live?.name || l.collection_name || 'deleted collection'
}
const isDeleted = (l) => !!l.collection_name && !state.collections.some((c) => c.id === l.collection_id)

// ---- CSV export ----------------------------------------------------------------
function exportCsv() {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const lines = [['time', 'user', 'action', 'collection', 'target', 'details'].join(',')]
  for (const l of logs.value) {
    lines.push([l.created_at, l.actor_email, ACTIONS[l.action] || l.action, collectionLabel(l) || '', l.target_name, describeLog(l)].map(esc).join(','))
  }
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: `curlion-activity-${new Date().toISOString().slice(0, 10)}.csv` })
  a.click()
  URL.revokeObjectURL(url)
}

const userOptions = computed(() => [...knownUsers.value.entries()].sort((a, b) => a[1].localeCompare(b[1])))
const actionOptions = Object.entries(ACTIONS).filter(([k]) => !['ADD_MEMBER', 'REMOVE_MEMBER'].includes(k))
const periodOptions = PERIODS.map((p) => ({ value: p.id, label: p.label }))
const userSelectOptions = computed(() => [{ value: '', label: 'All users' }, ...userOptions.value.map(([id, email]) => ({ value: id, label: email }))])
const collectionOptions = computed(() => [
  { value: '', label: 'All collections' },
  { value: '__account__', label: 'Sign-in / sign-out', class: 'text-zinc-400' },
  ...state.collections.map((c) => ({ value: c.id, label: c.name })),
])
const activitySelectOptions = [{ value: '', label: 'All activity' }, ...actionOptions.map(([id, label]) => ({ value: id, label }))]
</script>

<template>
  <Modal title="Activity log" width="max-w-6xl" @close="emit('close')">
    <!-- Filters -->
    <div class="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-3 text-xs">
      <UiSelect v-model="period" :options="periodOptions" class="w-36" />
      <UiSelect v-model="actorId" :options="userSelectOptions" class="w-48" menu-width="16rem" />
      <UiSelect v-model="collectionId" :options="collectionOptions" class="w-48" menu-width="16rem" />
      <UiSelect v-model="action" :options="activitySelectOptions" class="w-44" menu-width="14rem" />
      <div class="flex min-w-48 flex-1 items-center gap-1.5 rounded border border-zinc-700 bg-zinc-900 px-2 focus-within:border-zinc-500">
        <Search :size="13" class="text-zinc-500" />
        <input v-model="search" placeholder="Search name, collection or user" class="w-full bg-transparent py-1.5 outline-none placeholder:text-zinc-600" />
      </div>
      <button class="inline-flex items-center gap-1 rounded px-2 py-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Refresh" @click="load()">
        <RefreshCw :size="13" :class="{ 'animate-spin': loading }" />
      </button>
      <button class="inline-flex items-center gap-1 rounded px-2 py-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40" :disabled="!logs.length" title="Download the loaded entries as CSV" @click="exportCsv">
        <Download :size="13" /> CSV
      </button>
    </div>

    <div class="grid gap-4 p-4 text-sm lg:grid-cols-[1fr_260px]">
      <!-- Feed -->
      <section class="min-w-0">
        <p v-if="error" class="mb-3 rounded border border-red-900 bg-red-950/40 p-3 text-red-300">{{ error }}</p>
        <div v-if="loading && !logs.length" class="py-16 text-center text-zinc-500"><Loader2 class="inline animate-spin" :size="18" /></div>
        <p v-else-if="!logs.length" class="py-16 text-center text-zinc-500">No activity for these filters.</p>

        <div v-for="g in groups" :key="g.key" class="mb-5">
          <h3 class="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase">{{ g.label }}</h3>
          <ol class="divide-y divide-zinc-800 rounded border border-zinc-800">
            <li v-for="l in g.items" :key="l.id" class="flex gap-3 px-3 py-2">
              <span class="w-11 shrink-0 pt-0.5 font-mono text-xs text-zinc-500" :title="new Date(l.created_at).toLocaleString()">{{ time(l.created_at) }}</span>
              <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[11px] text-zinc-300 uppercase" :title="l.actor_email">{{ (l.actor_email || '?')[0] }}</span>
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span class="text-zinc-300">{{ l.actor_email || 'deleted user' }}</span>
                  <span class="rounded px-1.5 py-0.5 text-[11px] font-medium" :class="actionColor(l.action)">{{ ACTIONS[l.action] || l.action }}</span>
                  <span v-if="!['SIGN_IN', 'SIGN_OUT'].includes(l.action)" class="font-medium text-zinc-100">{{ l.target_name }}</span>
                  <span v-if="collectionLabel(l) && l.target_name !== collectionLabel(l)" class="text-xs text-zinc-500">
                    in <span :class="isDeleted(l) ? 'line-through' : 'text-zinc-400'">{{ collectionLabel(l) }}</span>
                  </span>
                </div>
                <p v-if="describeLog(l)" class="mt-0.5 font-mono text-xs break-all text-zinc-500">{{ describeLog(l) }}</p>
              </div>
            </li>
          </ol>
        </div>

        <button v-if="hasMore" :disabled="loading" class="w-full rounded border border-zinc-800 py-2 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100 disabled:opacity-50" @click="load({ more: true })">
          <Loader2 v-if="loading" :size="13" class="inline animate-spin" /> Load older entries
        </button>
      </section>

      <!-- Summary -->
      <aside class="space-y-4 lg:sticky lg:top-0 lg:self-start">
        <div class="grid grid-cols-2 gap-2">
          <div v-for="s in stats" :key="s.label" class="rounded border border-zinc-800 px-3 py-2">
            <p class="text-lg font-semibold text-zinc-100 tabular-nums">{{ s.value }}</p>
            <p class="text-[11px] text-zinc-500">{{ s.label }}</p>
          </div>
        </div>
        <div class="rounded border border-zinc-800 p-3">
          <h3 class="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase">Most active</h3>
          <p v-if="!perUser.length" class="text-xs text-zinc-600">No one yet.</p>
          <button
            v-for="u in perUser"
            :key="u.email"
            class="mb-2 block w-full text-left"
            :title="u.id ? `Show only ${u.email}` : ''"
            @click="u.id && (actorId = actorId === u.id ? '' : u.id)"
          >
            <div class="mb-0.5 flex items-center justify-between gap-2 text-xs">
              <span class="truncate" :class="actorId === u.id ? 'text-orange-400' : 'text-zinc-300'">{{ u.email }}</span>
              <span class="shrink-0 text-zinc-500 tabular-nums">{{ u.total }}</span>
            </div>
            <div class="h-1.5 rounded bg-zinc-800"><div class="h-1.5 rounded bg-orange-500/70" :style="{ width: u.pct + '%' }"></div></div>
          </button>
        </div>
        <p class="text-[11px] leading-relaxed text-zinc-600">
          Edits are grouped per person, about once a minute, after they sync. Counts cover the entries loaded for the current filters.
        </p>
      </aside>
    </div>
  </Modal>
</template>
