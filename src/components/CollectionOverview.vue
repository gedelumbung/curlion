<!-- Collection overview tab: opened by clicking a collection's name in the sidebar. -->
<script setup>
import { computed, ref, watch } from 'vue'
import { Download, FilePlus, FolderPlus, Globe, History, KeyRound, Layers, Play, Trash2, Users } from 'lucide-vue-next'
import { addFolder, addRequest, cloudEnabled, deleteCollection, fetchActivity, openRequest, renameNode, roleOf, state, touchCollection } from '../store.js'
import { ACTIONS, actionColor, ago } from '../lib/activity.js'
import { exportPostman } from '../lib/postman.js'
import { downloadJson, requestBadge } from '../lib/ui.js'

const props = defineProps({ collection: { type: Object, required: true } })
const emit = defineEmits(['collection', 'settings', 'run']) // collection: { col, tab } -> CollectionModal (publish / activity); settings: { col } auth & headers
const col = computed(() => props.collection)
const isOwner = computed(() => roleOf(col.value) === 'owner')
const online = computed(() => cloudEnabled && !!state.user)

// ---- name and description ------------------------------------------------------
const nameDraft = ref(col.value.name)
watch(() => col.value.name, (n) => (nameDraft.value = n))
function commitName() {
  const n = nameDraft.value.trim()
  if (n && n !== col.value.name) renameNode(col.value, col.value.id, n)
  else nameDraft.value = col.value.name
}

// ---- contents ---------------------------------------------------------------------
/** Requests grouped by folder path, in tree order. */
const groups = computed(() => {
  const out = []
  const walk = (items, path) => {
    const reqs = items.filter((n) => n.type === 'request')
    if (reqs.length || !path.length) out.push({ key: path.join('/') || '__root', title: path.join(' / '), requests: reqs })
    for (const f of items.filter((n) => n.type === 'folder')) walk(f.items, [...path, f.name])
  }
  walk(col.value.items, [])
  return out.filter((g) => g.requests.length)
})
const stats = computed(() => {
  let requests = 0
  let folders = 0
  let samples = 0
  const walk = (items) => {
    for (const n of items) {
      if (n.type === 'folder') {
        folders++
        walk(n.items)
      } else {
        requests++
        samples += n.samples?.length || 0
      }
    }
  }
  walk(col.value.items)
  return { requests, folders, samples }
})

// ---- recent activity --------------------------------------------------------------
const recent = ref([])
async function loadRecent() {
  recent.value = []
  if (!online.value || !col.value.syncedAt) return
  try {
    recent.value = await fetchActivity(col.value.id, 6)
  } catch {
    recent.value = []
  }
}
watch(() => col.value.id, loadRecent, { immediate: true })

// ---- actions ------------------------------------------------------------------------
const exportCol = () => downloadJson(exportPostman(col.value), `${col.value.name.replace(/[^\w-]+/g, '_')}.postman_collection.json`)
function remove() {
  if (confirm(`Delete collection "${col.value.name}" for everyone?`)) deleteCollection(col.value.id)
}
</script>

<template>
  <section class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto max-w-4xl px-6 py-6">
      <!-- Header -->
      <div class="flex items-start gap-3">
        <span class="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-zinc-800 text-zinc-400"><Layers :size="18" /></span>
        <div class="min-w-0 flex-1">
          <input
            v-model="nameDraft"
            class="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-xl font-semibold text-zinc-100 outline-none hover:border-zinc-800 focus:border-zinc-600"
            title="Rename collection"
            @keydown.enter="$event.target.blur()"
            @keydown.esc="(nameDraft = col.name), $event.target.blur()"
            @blur="commitName"
          />
          <p class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-zinc-500">
            <span>{{ stats.requests }} request{{ stats.requests === 1 ? '' : 's' }}</span>
            <span>{{ stats.folders }} folder{{ stats.folders === 1 ? '' : 's' }}</span>
            <span>{{ stats.samples }} sample{{ stats.samples === 1 ? '' : 's' }}</span>
            <span v-if="col.updatedAt">updated {{ ago(col.updatedAt) }}</span>
            <span v-if="!isOwner" class="inline-flex items-center gap-1 text-sky-400"><Users :size="12" /> created by a teammate</span>
            <span v-if="col.isPublic" class="inline-flex items-center gap-1 text-emerald-400"><Globe :size="12" /> docs published</span>
          </p>
        </div>
      </div>

      <!-- Actions -->
      <div class="mt-4 flex flex-wrap gap-2 text-xs">
        <button class="inline-flex items-center gap-1.5 rounded bg-orange-500 px-3 py-1.5 font-medium text-on-accent hover:bg-orange-600" @click="addRequest(col, null)"><FilePlus :size="14" /> New request</button>
        <button class="inline-flex items-center gap-1.5 rounded bg-zinc-800 px-3 py-1.5 text-zinc-200 hover:bg-zinc-700" @click="addFolder(col, null)"><FolderPlus :size="14" /> New folder</button>
        <button class="inline-flex items-center gap-1.5 rounded bg-zinc-800 px-3 py-1.5 text-zinc-200 hover:bg-zinc-700" title="Collection Runner: send every request and check its tests" @click="emit('run', { col, node: null })"><Play :size="14" /> Run</button>
        <button class="inline-flex items-center gap-1.5 rounded bg-zinc-800 px-3 py-1.5 text-zinc-200 hover:bg-zinc-700" title="Auth and headers used by every request in this collection" @click="emit('settings', { col, node: null })"><KeyRound :size="14" /> Auth &amp; headers</button>
        <button class="inline-flex items-center gap-1.5 rounded bg-zinc-800 px-3 py-1.5 text-zinc-200 hover:bg-zinc-700" @click="emit('collection', { col, tab: 'publish' })"><Globe :size="14" /> Publish docs</button>
        <button class="inline-flex items-center gap-1.5 rounded bg-zinc-800 px-3 py-1.5 text-zinc-200 hover:bg-zinc-700" @click="emit('collection', { col, tab: 'activity' })"><History :size="14" /> Activity log</button>
        <button class="inline-flex items-center gap-1.5 rounded bg-zinc-800 px-3 py-1.5 text-zinc-200 hover:bg-zinc-700" @click="exportCol"><Download :size="14" /> Export</button>
        <button v-if="isOwner" class="ml-auto inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-red-400 hover:bg-red-950/40" @click="remove"><Trash2 :size="14" /> Delete</button>
      </div>

      <!-- Description -->
      <h2 class="mt-8 mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase">Description</h2>
      <textarea
        v-model="col.description"
        rows="4"
        class="w-full rounded border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
        placeholder="What this API does, base URLs, how to authenticate… (also shown at the top of the published docs)"
        @input="touchCollection(col)"
      ></textarea>

      <div class="mt-8 grid gap-8" :class="online ? 'lg:grid-cols-[1fr_280px]' : ''">
        <!-- Requests -->
        <div class="min-w-0">
          <h2 class="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase">Requests</h2>
          <p v-if="!stats.requests" class="rounded border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
            No requests yet.
            <button class="text-orange-400 hover:underline" @click="addRequest(col, null)">Add the first one</button>
          </p>
          <div v-for="g in groups" :key="g.key" class="mb-4">
            <p v-if="g.title" class="mb-1 text-xs text-zinc-500">{{ g.title }}</p>
            <ul class="divide-y divide-zinc-800 rounded border border-zinc-800">
              <li
                v-for="r in g.requests"
                :key="r.id"
                class="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-zinc-900"
                title="Open (double-click to keep the tab)"
                @click="openRequest(col.id, r.id, { preview: true })"
                @dblclick="openRequest(col.id, r.id)"
              >
                <span class="w-12 shrink-0 font-mono text-[11px] font-bold" :class="requestBadge(r).class">{{ requestBadge(r).label }}</span>
                <span class="w-48 shrink-0 truncate text-zinc-200">{{ r.name }}</span>
                <span class="min-w-0 flex-1 truncate font-mono text-xs text-zinc-500">{{ r.url }}</span>
              </li>
            </ul>
          </div>
        </div>

        <!-- Recent activity -->
        <aside v-if="online">
          <h2 class="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase">Recent activity</h2>
          <p v-if="!recent.length" class="text-xs text-zinc-600">{{ col.syncedAt ? 'No activity yet.' : 'Not synced yet.' }}</p>
          <ol class="space-y-2">
            <li v-for="l in recent" :key="l.id" class="text-xs">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="rounded px-1.5 py-0.5 text-[10px] font-medium" :class="actionColor(l.action)">{{ ACTIONS[l.action] || l.action }}</span>
                <span class="truncate text-zinc-300">{{ l.target_name }}</span>
              </div>
              <p class="mt-0.5 text-zinc-600">{{ l.actor_email || 'deleted user' }} · {{ ago(l.created_at) }}</p>
            </li>
          </ol>
          <button class="mt-3 text-xs text-orange-400 hover:underline" @click="emit('collection', { col, tab: 'activity' })">See all activity</button>
        </aside>
      </div>
    </div>
  </section>
</template>
