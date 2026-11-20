<!-- "Save changes?" when closing tabs with unsaved edits (driven by state.unsavedPrompt). -->
<script setup>
import { onMounted, ref } from 'vue'
import Modal from './Modal.vue'
import { answerUnsaved, state } from '../store.js'

const p = state.unsavedPrompt
const saveBtn = ref(null)
onMounted(() => saveBtn.value?.focus())
</script>

<template>
  <Modal title="Unsaved changes" width="max-w-md" @close="answerUnsaved('cancel')">
    <div class="space-y-2 p-4 text-sm">
      <p class="text-zinc-200">
        Save changes to <b class="text-zinc-100">“{{ p.name }}”</b> before closing?
      </p>
      <p class="text-xs text-zinc-500">
        Without saving, your edits to this request are lost.
        <template v-if="p.total > 1"> Tab {{ p.index }} of {{ p.total }} with unsaved changes.</template>
      </p>
    </div>
    <template #footer>
      <button v-if="p.showIgnoreAll" class="mr-auto rounded px-3 py-1.5 text-xs text-red-400 hover:bg-red-950/40" :title="`Close the remaining ${p.total - p.index + 1} tab(s) without saving`" @click="answerUnsaved('ignoreAll')">
        Ignore all ({{ p.total - p.index + 1 }})
      </button>
      <button class="rounded px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" @click="answerUnsaved('cancel')">Cancel</button>
      <button class="rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700" @click="answerUnsaved('discard')">Don't save</button>
      <button ref="saveBtn" class="rounded bg-orange-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-600" @click="answerUnsaved('save')">Save</button>
    </template>
  </Modal>
</template>
