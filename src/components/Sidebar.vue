<script setup>
import { computed, nextTick, ref } from 'vue'
import { ChevronRight, Clock, Copy, Download, FilePlus, FolderPlus, Globe, History, Layers, MoreHorizontal, Pencil, Plus, Search, Trash2, Upload, Users } from 'lucide-vue-next'
import TreeNode from './TreeNode.vue'
import {
  addNewRequest,
  addFolder,
  collectionTabId,
  openCollectionOverview,
  addRequest,
  clearHistory,
  createCollection,
  deleteCollection,
  deleteNode,
  duplicateNode,
  openRequest,
  state,
  roleOf,
  toggleExpanded,
  touchCollection,
} from '../store.js'
import { findNode } from '../lib/model.js'
import { vTopLayer } from '../lib/topLayer.js'
import { exportPostman } from '../lib/postman.js'
import { downloadJson, methodColor, statusColor } from '../lib/ui.js'

const emit = defineEmits(['import', 'collection'])
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
  const y = Math.min(e.clientY || rect?.bottom || 0, window.innerHeight - 260)
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

function openHistory(h) {
  const col = state.collections.find((c) => c.id === h.collectionId)
  if (col && findNode(col.items, h.requestId)) openRequest(col.id, h.requestId, { preview: true })
}
function askClearHistory() {
  if (confirm('Clear history?')) clearHistory()
}
const fmtTime = (ts) => new Date(ts).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })
</script>

<template>
  <aside class="flex h-full min-h-0 flex-col border-r border-zinc-800 bg-zinc-925" @click="menu = null">
    <div class="flex gap-1 border-b border-zinc-800 p-2 text-xs">
      <button class="inline-flex flex-1 items-center justify-center gap-1.5 rounded py-1.5" :class="tab === 'collections' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'" @click="tab = 'collections'">
        <Layers :size="14" /> Collections
      </button>
      <button class="inline-flex flex-1 items-center justify-center gap-1.5 rounded py-1.5" :class="tab === 'history' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'" @click="tab = 'history'">
        <Clock :size="14" /> History
      </button>
    </div>

    <template v-if="tab === 'collections'">
      <div class="flex items-center gap-1 p-2">
        <div class="flex flex-1 items-center gap-1.5 rounded border border-zinc-800 bg-zinc-900 px-2 focus-within:border-zinc-600">
          <Search :size="13" class="text-zinc-500" />
          <input v-model="state.search" placeholder="Search name or URL" class="w-full bg-transparent py-1 text-[13px] outline-none placeholder:text-zinc-600" />
        </div>
        <button class="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="New request" @click="addNewRequest"><FilePlus :size="15" /></button>
        <button class="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="New collection" @click="newCollection"><Plus :size="16" /></button>
        <button class="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Import" @click="emit('import')"><Upload :size="15" /></button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-1 pb-4">
        <template v-for="col in state.collections" :key="col.id">
          <div v-if="colVisible(col)">
            <div
              class="group flex cursor-pointer items-center gap-1.5 rounded px-1 py-1 text-[13px] font-medium text-zinc-300 hover:bg-zinc-800/60"
              :class="{ 'bg-zinc-800 text-zinc-100': state.active?.requestId === collectionTabId(col.id) }"
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
        <div v-if="!state.collections.length" class="p-4 text-center text-sm text-zinc-500">
          No collections yet.
          <button class="mt-2 block w-full rounded bg-zinc-800 py-1.5 text-zinc-200 hover:bg-zinc-700" @click="newCollection">Create collection</button>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="flex items-center justify-between px-3 py-2 text-xs text-zinc-500">
        <span>Last {{ state.history.length }} requests</span>
        <button v-if="state.history.length" class="hover:text-red-400" @click="askClearHistory">Clear</button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-1 pb-4">
        <button v-for="h in state.history" :key="h.id" class="flex w-full flex-col rounded px-2 py-1.5 text-left hover:bg-zinc-800/60" @click="openHistory(h)">
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
