<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { ChevronRight, Folder, FolderOpen, MoreHorizontal } from 'lucide-vue-next'
import { canEdit, moveNode, openRequest, renameNode, state, toggleExpanded } from '../store.js'
import { methodColor } from '../lib/ui.js'

defineOptions({ name: 'TreeNode' })
const props = defineProps({
  node: { type: Object, required: true },
  collection: { type: Object, required: true },
  depth: { type: Number, default: 1 },
  query: { type: String, default: '' },
  renamingId: { type: String, default: null },
})
const emit = defineEmits(['menu', 'rename-done'])

const q = computed(() => props.query.trim().toLowerCase())

function matches(n) {
  if (!q.value) return true
  if (n.name.toLowerCase().includes(q.value)) return true
  if (n.type === 'request') return n.url.toLowerCase().includes(q.value)
  return n.items.some(matches)
}
const visible = computed(() => matches(props.node))
// when the folder name itself matches, show all its children
const childQuery = computed(() => (props.node.type === 'folder' && q.value && props.node.name.toLowerCase().includes(q.value) ? '' : props.query))

const isFolder = computed(() => props.node.type === 'folder')
const open = computed(() => (q.value ? true : !!state.expanded[props.node.id]))
const active = computed(() => state.active?.requestId === props.node.id)

function click() {
  if (isFolder.value) toggleExpanded(props.node.id)
  else openRequest(props.collection.id, props.node.id, { preview: true })
}
// double-click a request: open it as a regular (non-preview) tab
function dblclick() {
  if (!isFolder.value) openRequest(props.collection.id, props.node.id)
}

// inline rename
const input = ref(null)
const draft = ref('')
const renaming = computed(() => props.renamingId === props.node.id)
watch(renaming, async (r) => {
  if (r) {
    draft.value = props.node.name
    await nextTick()
    input.value?.select()
  }
})
function commit() {
  if (draft.value.trim() && draft.value !== props.node.name) renameNode(props.collection, props.node.id, draft.value.trim())
  emit('rename-done')
}

// drag & drop (within one collection)
const dropHint = ref(false)
function onDragStart(e) {
  e.dataTransfer.setData('application/x-curlion', JSON.stringify({ collectionId: props.collection.id, id: props.node.id }))
  e.dataTransfer.effectAllowed = 'move'
}
function onDrop(e) {
  dropHint.value = false
  const raw = e.dataTransfer.getData('application/x-curlion')
  if (!raw) return
  const { collectionId, id } = JSON.parse(raw)
  if (collectionId !== props.collection.id || id === props.node.id) return
  if (isFolder.value) moveNode(props.collection, id, props.node.id)
  else {
    // drop onto a request: place before it in the same container
    const parentId = findParentId(props.collection.items, props.node.id)
    moveNode(props.collection, id, parentId, props.node.id)
  }
}
function findParentId(items, id, parent = null) {
  for (const n of items) {
    if (n.id === id) return parent
    if (n.type === 'folder') {
      const p = findParentId(n.items, id, n.id)
      if (p !== undefined) return p
    }
  }
  return undefined
}
</script>

<template>
  <div v-if="visible">
    <div
      class="tree-row group gap-1.5 pr-1"
      :class="[active ? 'active' : 'text-zinc-400 hover:text-zinc-200', dropHint ? 'ring-1 ring-orange-500 ring-inset' : '']"
      :style="{ paddingLeft: depth * 12 + 'px' }"
      :draggable="canEdit(collection)"
      @click="click"
      @dblclick="dblclick"
      @contextmenu.prevent="canEdit(collection) && emit('menu', $event, node)"
      @dragstart.stop="onDragStart"
      @dragover.prevent="dropHint = true"
      @dragleave="dropHint = false"
      @drop.prevent.stop="onDrop"
    >
      <template v-if="isFolder">
        <ChevronRight :size="13" class="shrink-0 transition-transform" :class="{ 'rotate-90': open }" />
        <FolderOpen v-if="open" :size="14" class="shrink-0 text-zinc-500" />
        <Folder v-else :size="14" class="shrink-0 text-zinc-500" />
      </template>
      <span v-else class="w-12 shrink-0 text-right font-mono text-[10px] font-bold" :class="methodColor[node.method]">{{ node.method === 'DELETE' ? 'DEL' : node.method === 'OPTIONS' ? 'OPT' : node.method }}</span>

      <input v-if="renaming" ref="input" v-model="draft" class="min-w-0 flex-1 rounded border border-orange-500 bg-zinc-900 px-1 outline-none" @click.stop @keydown.enter="commit" @keydown.esc="emit('rename-done')" @blur="commit" />
      <span v-else class="min-w-0 flex-1 truncate">{{ node.name }}</span>

      <button v-if="canEdit(collection)" class="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-zinc-700" @click.stop="emit('menu', $event, node)"><MoreHorizontal :size="14" /></button>
    </div>
    <div v-if="isFolder && open">
      <TreeNode
        v-for="child in node.items"
        :key="child.id"
        :node="child"
        :collection="collection"
        :depth="depth + 1"
        :query="childQuery"
        :renaming-id="renamingId"
        @menu="(e, n) => emit('menu', e, n)"
        @rename-done="emit('rename-done')"
      />
      <p v-if="!node.items.length" class="py-1 text-xs text-zinc-600" :style="{ paddingLeft: (depth + 1) * 12 + 18 + 'px' }">Empty folder</p>
    </div>
  </div>
</template>
