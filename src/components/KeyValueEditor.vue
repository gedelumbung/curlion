<!-- Key / value / description table used for params, headers, form bodies and sample headers. -->
<script setup>
import { Paperclip, Plus, Trash2, Type } from 'lucide-vue-next'
import VarInput from './VarInput.vue'
import SuggestInput from './SuggestInput.vue'
import { kv } from '../lib/model.js'
import { fileStore } from '../lib/resolve.js'
import { ref } from 'vue'

const props = defineProps({
  rows: { type: Array, required: true },
  keySuggestions: { type: Array, default: () => [] },
  valueSuggestions: { type: Array, default: () => [] },
  allowFiles: { type: Boolean, default: false },
  showDescription: { type: Boolean, default: true },
  keyPlaceholder: { type: String, default: 'Key' },
  valuePlaceholder: { type: String, default: 'Value' },
})
const emit = defineEmits(['change'])
const fileTick = ref(0) // re-render after picking files (fileStore is not reactive)

const changed = () => emit('change')

function add() {
  props.rows.push(kv('', '', props.allowFiles ? { type: 'text' } : {}))
  changed()
}
function remove(i) {
  const [row] = props.rows.splice(i, 1)
  fileStore.delete(row.id)
  changed()
}
function pickFile(row, e) {
  const file = e.target.files?.[0]
  if (!file) return
  fileStore.set(row.id, file)
  row.fileName = file.name
  fileTick.value++
  changed()
}
function toggleType(row) {
  row.type = row.type === 'file' ? 'text' : 'file'
  changed()
}
</script>

<template>
  <div class="text-sm">
    <table class="kv-table w-full table-fixed border-collapse">
      <thead>
        <tr class="text-left text-xs text-zinc-500">
          <th class="w-8"></th>
          <th class="px-2 py-1 font-medium">Key</th>
          <th class="px-2 py-1 font-medium">Value</th>
          <th v-if="showDescription" class="hidden px-2 py-1 font-medium lg:table-cell">Description</th>
          <th class="w-16"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in rows" :key="row.id" class="group border-t border-zinc-800">
          <td class="pl-2 text-center">
            <input v-model="row.enabled" type="checkbox" class="accent-orange-500" @change="changed" />
          </td>
          <td class="px-2 py-1">
            <SuggestInput
              v-model="row.key"
              :suggestions="keySuggestions"
              :placeholder="keyPlaceholder"
              :input-class="['w-full bg-transparent font-mono text-[13px] outline-none placeholder:text-zinc-600', { 'opacity-50': row.enabled === false }]"
              @input="changed"
            />
          </td>
          <td class="px-2 py-1" :class="{ 'opacity-50': row.enabled === false }">
            <div v-if="allowFiles && row.type === 'file'" class="flex items-center gap-2" :data-tick="fileTick">
              <label class="cursor-pointer truncate rounded bg-zinc-800 px-2 py-0.5 text-xs hover:bg-zinc-700">
                {{ fileStore.get(row.id)?.name || 'Select file' }}
                <input type="file" class="hidden" @change="pickFile(row, $event)" />
              </label>
              <span v-if="row.fileName && !fileStore.get(row.id)" class="truncate text-xs text-amber-400" title="Files are kept in memory only. Re-select after reload.">
                {{ row.fileName }} (re-select)
              </span>
            </div>
            <VarInput v-else v-model="row.value" :placeholder="valuePlaceholder" @update:model-value="changed" />
          </td>
          <td v-if="showDescription" class="hidden px-2 py-1 lg:table-cell">
            <input v-model="row.description" placeholder="Description" class="w-full bg-transparent text-[13px] text-zinc-400 outline-none placeholder:text-zinc-700" @input="changed" />
          </td>
          <td class="pr-2 text-right whitespace-nowrap">
            <button
              v-if="allowFiles"
              class="rounded p-1 text-zinc-500 opacity-0 group-hover:opacity-100 hover:bg-zinc-800 hover:text-zinc-200"
              :title="row.type === 'file' ? 'Switch to text' : 'Switch to file'"
              @click="toggleType(row)"
            >
              <Type v-if="row.type === 'file'" :size="14" />
              <Paperclip v-else :size="14" />
            </button>
            <button class="rounded p-1 text-zinc-500 opacity-0 group-hover:opacity-100 hover:bg-zinc-800 hover:text-red-400" title="Remove" @click="remove(i)">
              <Trash2 :size="14" />
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <button class="mt-1 ml-2 inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" @click="add">
      <Plus :size="14" /> Add
    </button>
  </div>
</template>
