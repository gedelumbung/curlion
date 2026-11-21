<!-- "Save to collection" for a request opened from History (driven by state.savePrompt). -->
<script setup>
import { computed, onMounted, ref } from 'vue'
import Modal from './Modal.vue'
import UiSelect from './UiSelect.vue'
import { answerSavePrompt, state } from '../store.js'

const p = state.savePrompt
const name = ref(p.name || 'New Request')
const activeCol = state.collections.find((c) => c.id === state.tabs.find((t) => t.requestId !== p.requestId && t.collectionId)?.collectionId)
const collectionId = ref(activeCol?.id || state.collections[0]?.id || '__new__')
const newCollectionName = ref('My Collection')
const options = computed(() => [
  ...state.collections.map((c) => ({ value: c.id, label: c.name })),
  { value: '__new__', label: '+ New collection', class: 'text-orange-400' },
])
const nameInput = ref(null)
onMounted(() => nameInput.value?.select())

function save() {
  if (!name.value.trim()) return
  answerSavePrompt({ name: name.value.trim(), collectionId: collectionId.value, newCollectionName: newCollectionName.value.trim() })
}
</script>

<template>
  <Modal title="Save request" width="max-w-md" @close="answerSavePrompt(null)">
    <form class="space-y-3 p-4 text-sm" @submit.prevent="save">
      <label class="block">
        <span class="mb-1 block text-xs text-zinc-500">Request name</span>
        <input ref="nameInput" v-model="name" required class="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 outline-none focus:border-zinc-500" />
      </label>
      <label class="block">
        <span class="mb-1 block text-xs text-zinc-500">Save to collection</span>
        <UiSelect v-model="collectionId" :options="options" class="w-full" />
      </label>
      <label v-if="collectionId === '__new__'" class="block">
        <span class="mb-1 block text-xs text-zinc-500">New collection name</span>
        <input v-model="newCollectionName" class="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 outline-none focus:border-zinc-500" />
      </label>
      <button type="submit" class="hidden" aria-hidden="true"></button>
    </form>
    <template #footer>
      <button class="rounded px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" @click="answerSavePrompt(null)">Cancel</button>
      <button class="rounded bg-orange-500 px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-orange-600" @click="save">Save</button>
    </template>
  </Modal>
</template>
