<!-- Auth and headers of a collection or folder, inherited by the requests inside it. -->
<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { KeyRound, List } from 'lucide-vue-next'
import Modal from './Modal.vue'
import AuthEditor from './AuthEditor.vue'
import KeyValueEditor from './KeyValueEditor.vue'
import { canEdit, makeRequestsInherit, toast, touchCollection } from '../store.js'
import { folderPath, walk } from '../lib/model.js'
import { inheritedHeaders } from '../lib/resolve.js'
import { STANDARD_HEADERS } from '../lib/ui.js'

const props = defineProps({
  collection: { type: Object, required: true },
  node: { type: Object, default: null }, // folder; null = the collection itself
  initialTab: { type: String, default: 'auth' },
})
const emit = defineEmits(['close', 'open']) // open: (collection, folder|null) another level

const target = computed(() => props.node || props.collection)
const kind = computed(() => (props.node ? 'folder' : 'collection'))
const ancestors = computed(() => (props.node ? [props.collection, ...(folderPath(props.collection.items, props.node.id) || [])] : []))
const parentHeaders = computed(() => inheritedHeaders(ancestors.value))
const tab = ref(props.initialTab)
const readonly = computed(() => !canEdit(props.collection))

watch(
  target,
  (t) => {
    if (!t.headers) t.headers = []
  },
  { immediate: true },
)
// folder / collection settings are saved right away (they are not part of a request draft).
// Watched from onMounted so filling in missing defaults on open does not count as an edit.
onMounted(() =>
  watch(
    () => [target.value.auth, target.value.headers],
    () => touchCollection(props.collection),
    { deep: true },
  ),
)

// Requests created before inheritance existed default to "No Auth": offer to switch them over.
const noAuthRequests = computed(() => {
  const list = []
  walk(target.value.items, (n) => {
    if (n.type === 'request' && (!n.auth || n.auth.type === 'none')) list.push(n)
  })
  return list
})
function inheritAll() {
  makeRequestsInherit(props.collection, noAuthRequests.value)
  toast('Requests now inherit this auth', 'success', 2000)
}

function editParent(source) {
  emit('open', props.collection, source.id === props.collection.id ? null : source)
}
const tabs = [
  { id: 'auth', label: 'Auth', icon: KeyRound },
  { id: 'headers', label: 'Headers', icon: List },
]
</script>

<template>
  <Modal :title="`${target.name} · ${kind === 'folder' ? 'Folder' : 'Collection'} settings`" width="max-w-3xl" @close="emit('close')">
    <nav class="flex gap-1 border-b border-zinc-800 px-3 text-sm">
      <button v-for="t in tabs" :key="t.id" class="relative inline-flex items-center gap-1.5 px-3 py-2" :class="tab === t.id ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'" @click="tab = t.id">
        <component :is="t.icon" :size="14" /> {{ t.label }}
        <span v-if="t.id === 'headers' && target.headers?.filter((h) => h.enabled !== false && h.key).length" class="text-xs text-emerald-400">{{ target.headers.filter((h) => h.enabled !== false && h.key).length }}</span>
        <span v-if="tab === t.id" class="absolute inset-x-2 -bottom-px h-0.5 rounded bg-orange-500"></span>
      </button>
    </nav>

    <div class="min-h-72 py-4 text-sm" :inert="readonly">
      <div v-if="tab === 'auth'" class="px-4">
        <AuthEditor :holder="target" :kind="kind" :ancestors="ancestors" @edit-parent="editParent" />
        <div v-if="noAuthRequests.length && target.auth?.type !== 'none'" class="mt-6 flex flex-wrap items-center gap-3 rounded border border-zinc-800 bg-zinc-900/60 p-3 text-xs text-zinc-400">
          <span class="min-w-0 flex-1">{{ noAuthRequests.length }} request{{ noAuthRequests.length === 1 ? ' is' : 's are' }} set to "No Auth" and will not use this.</span>
          <button class="rounded bg-zinc-800 px-3 py-1 text-zinc-200 hover:bg-zinc-700" @click="inheritAll">Make {{ noAuthRequests.length === 1 ? 'it' : 'them' }} inherit</button>
        </div>
      </div>
      <template v-else>
        <p class="px-4 pb-2 text-xs text-zinc-500">
          Sent with every request in this {{ kind }}. A request (or a folder further down) that sets a header with the same name overrides it.
        </p>
        <KeyValueEditor :rows="target.headers" :key-suggestions="STANDARD_HEADERS" />
        <div v-if="parentHeaders.length" class="mt-4 px-4">
          <p class="mb-1 text-xs text-zinc-500">Inherited from above</p>
          <ul class="rounded border border-zinc-800 font-mono text-[13px]">
            <li v-for="h in parentHeaders" :key="h.sourceId + h.key" class="flex gap-3 border-t border-zinc-800 px-3 py-1.5 first:border-t-0">
              <span class="w-1/3 truncate text-zinc-400">{{ h.key }}</span>
              <span class="min-w-0 flex-1 truncate text-zinc-300">{{ h.value }}</span>
              <span class="shrink-0 font-sans text-xs text-zinc-600">{{ h.source }}</span>
            </li>
          </ul>
        </div>
      </template>
      <p v-if="readonly" class="px-4 pt-4 text-xs text-zinc-500">You cannot edit this collection.</p>
    </div>
  </Modal>
</template>
