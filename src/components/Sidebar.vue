<script setup>
import { computed, nextTick, ref } from 'vue'
import { ChevronRight, Clock, Copy, Download, FilePlus, FolderPlus, Globe, History, KeyRound, Layers, MoreHorizontal, Pencil, Play, Plus, Search, Trash2, Upload, Users } from 'lucide-vue-next'
import TreeNode from './TreeNode.vue'
import {
  addNewRequest,
  addFolder,
  collectionTabId,
  openCollectionOverview,
  openHistoryEntry,
  addRequest,
  clearHistory,
  createCollection,
  deleteCollection,
  deleteNode,
  duplicateNode,
  openRequest,
  state,
  wsCollections,
  wsHistory,
  roleOf,
  toggleExpanded,
  touchCollection,
} from '../store.js'
import { findNode } from '../lib/model.js'
import { vTopLayer } from '../lib/topLayer.js'
import { exportPostman } from '../lib/postman.js'
import { downloadJson, methodColor, statusColor } from '../lib/ui.js'

const emit = defineEmits(['import', 'collection', 'settings', 'run']) // settings / run: ({ col, node }) auth & headers, Collection Runner
const tab = ref('collections')
const renamingId = ref(null)
const menu = ref(null) // { x, y, items }

const q = computed(() => state.search.trim().toLowerCase())
function colVisible(col) {
  if (!q.value) return true
  if (col.name.toLowerCase().includes(q.value)) return true
  let hit = false
  const walk = (items) =>
    items.forEach((n) => {
      if (n.name.toLowerCase().includes(q.value) || (n.type === 'request' && n.url.toLowerCase().includes(q.value))) hit = true
      if (n.type === 'folder') walk(n.items)
    })
  walk(col.items)
  return hit
}

function openMenu(e, col, node = null) {
  const rect = e.currentTarget?.getBoundingClientRect?.()
  const x = Math.min(e.clientX || rect?.left || 0, window.innerWidth - 200)
  const y = Math.min(e.clientY || rect?.bottom || 0, window.innerHeight - 320)
  const isContainer = !node || node.type === 'folder'
  const parentId = node ? node.id : col.id
  const items = []
  const role = roleOf(col)
  if (!node) {
    items.push({ icon: Globe, label: 'Publish docs', run: () => emit('collection', { col, tab: 'publish' }) })
    items.push({ icon: History, label: 'Activity log', run: () => emit('collection', { col, tab: 'activity' }), divider: true })
  }
  if (isContainer) {
    items.push({ icon: FilePlus, label: 'Add request', run: () => addRequest(col, parentId) })
    items.push({ icon: FolderPlus, label: 'Add folder', run: () => startRename(addFolder(col, parentId).id) })
    items.push({ icon: KeyRound, label: 'Auth & headers', run: () => emit('settings', { col, node }) })
    items.push({ icon: Play, label: node ? 'Run folder' : 'Run collection', run: () => emit('run', { col, node: node || null }) })
  }
  items.push({ icon: Pencil, label: 'Rename', run: () => (node ? startRename(node.id) : beginColRename(col)) })
  if (node) {
    items.push({ icon: Copy, label: 'Duplicate', run: () => duplicateNode(col, node.id) })
    items.push({
      icon: Trash2,
      label: 'Delete',
      danger: true,
      run: () => confirm(`Delete "${node.name}"${node.type === 'folder' ? ' and everything inside it' : ''}?`) && deleteNode(col, node.id),
    })
  } else {
    items.push({ icon: Download, label: 'Export (Postman v2.1)', run: () => downloadJson(exportPostman(col), `${col.name.replace(/[^\w-]+/g, '_')}.postman_collection.json`) })
    // only the creator can delete a collection; everyone else can edit it
    if (role === 'owner') items.push({ icon: Trash2, label: 'Delete collection', danger: true, run: () => confirm(`Delete collection "${col.name}" for everyone?`) && deleteCollection(col.id) })
  }
  menu.value = { x, y, items }
}

async function startRename(id) {
  await nextTick()
  renamingId.value = id
}

// collection-level rename (root row)
const colDraft = ref('')
async function beginColRename(col) {
  colDraft.value = col.name
  renamingId.value = col.id
  await nextTick()
  document.getElementById('col-rename-' + col.id)?.select()
}
function commitColRename(col) {
  if (renamingId.value !== col.id) return
  if (colDraft.value.trim()) col.name = colDraft.value.trim()
  renamingId.value = null
  touchCollection(col)
}

function newCollection() {
  const col = createCollection()
  beginColRename(col)
}

function runItem(item) {
  menu.value = null
  item.run()
}

// History click: open what was sent in a tab, like Postman (double-click keeps the tab)
const openHistory = (h) => openHistoryEntry(h)
function askClearHistory() {
  if (confirm('Clear history?')) clearHistory()
}
const fmtTime = (ts) => new Date(ts).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })
</script>

<template>
  <aside class="flex h-full min-h-0 flex-col border-r border-zinc-800 bg-zinc-925" @click="menu = null">
    <div class="flex border-b border-zinc-800 px-2 text-xs font-medium">
      <button v-for="t in [{ id: 'collections', label: 'Collections', icon: Layers }, { id: 'history', label: 'History', icon: Clock }]" :key="t.id" class="sidebar-tab" :class="{ on: tab === t.id }" @click="tab = t.id">
        <component :is="t.icon" :size="14" /> {{ t.label }}
      </button>
    </div>

    <template v-if="tab === 'collections'">
      <div class="flex items-center gap-0.5 px-2 py-2">
        <div class="mr-1 flex h-7 flex-1 items-center gap-1.5 rounded-md border border-transparent bg-zinc-900 px-2 focus-within:border-zinc-700">
          <Search :size="13" class="shrink-0 text-zinc-500" />
          <input v-model="state.search" placeholder="Search" class="w-full bg-transparent text-[13px] outline-none placeholder:text-zinc-600" />
        </div>
        <button class="icon-btn" title="New request" @click="addNewRequest"><FilePlus :size="15" /></button>
        <button class="icon-btn" title="New collection" @click="newCollection"><Plus :size="16" /></button>
        <button class="icon-btn" title="Import" @click="emit('import')"><Upload :size="15" /></button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-1 pb-4">
        <template v-for="col in wsCollections" :key="col.id">
          <div v-if="colVisible(col)">
            <div
              class="tree-row group gap-1.5 px-1 font-medium text-zinc-300"
              :class="{ active: state.active?.requestId === collectionTabId(col.id) }"
              title="Open collection overview"
              @click="openCollectionOverview(col.id)"
              @dblclick="beginColRename(col)"
              @contextmenu.prevent="openMenu($event, col)"
            >
              <button class="-m-0.5 shrink-0 rounded p-0.5 hover:bg-zinc-700" :title="state.expanded[col.id] ? 'Collapse' : 'Expand'" @click.stop="toggleExpanded(col.id)" @dblclick.stop>
                <ChevronRight :size="13" class="transition-transform" :class="{ 'rotate-90': q || state.expanded[col.id] }" />
              </button>
              <input
                v-if="renamingId === col.id"
                :id="'col-rename-' + col.id"
                v-model="colDraft"
                class="min-w-0 flex-1 rounded border border-orange-500 bg-zinc-900 px-1 outline-none"
                @click.stop
                @keydown.enter="commitColRename(col)"
                @keydown.esc="renamingId = null"
                @blur="commitColRename(col)"
              />
              <span v-else class="min-w-0 flex-1 truncate">{{ col.name }}</span>
              <Users v-if="roleOf(col) !== 'owner'" :size="12" class="shrink-0 text-sky-400" title="Created by another team member. Everyone can edit it; only its creator can delete it." />
              <Globe v-if="col.isPublic" :size="12" class="text-emerald-500" title="Docs published" />
              <button class="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-zinc-700" @click.stop="openMenu($event, col)"><MoreHorizontal :size="14" /></button>
            </div>
            <div v-if="q || state.expanded[col.id]">
              <TreeNode
                v-for="node in col.items"
                :key="node.id"
                :node="node"
                :collection="col"
                :query="col.name.toLowerCase().includes(q) ? '' : state.search"
                :renaming-id="renamingId"
                @menu="(e, n) => openMenu(e, col, n)"
                @rename-done="renamingId = null"
              />
              <button v-if="!col.items.length" class="ml-6 py-1 text-xs text-zinc-500 hover:text-orange-400" @click="addRequest(col, null)">+ Add a request</button>
            </div>
          </div>
        </template>
        <div v-if="!wsCollections.length" class="p-4 text-center text-sm text-zinc-500">
          No collections yet.
          <button class="mt-2 block w-full rounded bg-zinc-800 py-1.5 text-zinc-200 hover:bg-zinc-700" @click="newCollection">Create collection</button>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="flex items-center justify-between px-3 py-2 text-xs text-zinc-500">
        <span>Last {{ wsHistory.length }} requests</span>
        <button v-if="wsHistory.length" class="hover:text-red-400" @click="askClearHistory">Clear</button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-1 pb-4">
        <button v-for="h in wsHistory" :key="h.id" class="flex w-full cursor-pointer flex-col rounded px-2 py-1.5 text-left hover:bg-zinc-800/60" @click="openHistory(h)" @dblclick="openHistoryEntry(h, { preview: false })" :title="h.request ? 'Open this request as it was sent' : 'Open (older entry: method and URL only)'">
          <span class="flex items-center gap-2 text-[13px]">
            <span class="font-mono text-[10px] font-bold" :class="methodColor[h.method]">{{ h.method }}</span>
            <span class="truncate text-zinc-300">{{ h.name }}</span>
            <span class="ml-auto font-mono text-[11px]" :class="statusColor(h.status)">{{ h.status }}</span>
          </span>
          <span class="truncate font-mono text-[11px] text-zinc-600">{{ h.url }}</span>
          <span class="text-[11px] text-zinc-600">{{ fmtTime(h.ts) }} · {{ h.time }} ms</span>
        </button>
      </div>
    </template>

    <!-- Context menu -->
    <Teleport to="body">
      <div v-if="menu" v-top-layer class="top-layer" @click="menu = null" @contextmenu.prevent="menu = null">
        <div class="absolute w-52 rounded-md border border-zinc-700 bg-zinc-800 py-1 text-sm shadow-xl" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @click.stop>
          <template v-for="item in menu.items" :key="item.label">
            <button class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-700" :class="item.danger ? 'text-red-400' : 'text-zinc-200'" @click="runItem(item)">
              <component :is="item.icon" :size="14" /> {{ item.label }}
            </button>
            <div v-if="item.divider" class="my-1 border-t border-zinc-700"></div>
          </template>
        </div>
      </div>
    </Teleport>
  </aside>
</template>
