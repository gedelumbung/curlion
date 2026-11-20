<script setup>
import { ref, watch } from 'vue'
import { Eye, EyeOff, Globe, Lock, Plus, Trash2, Unlock } from 'lucide-vue-next'
import Modal from './Modal.vue'
import { createEnvironment, deleteEnvironment, setActiveEnv, state, touchEnvironment } from '../store.js'
import { uid } from '../lib/model.js'
import { DYNAMIC_DESCRIPTIONS } from '../lib/variables.js'

const emit = defineEmits(['close'])
const selectedId = ref(state.activeEnvId || state.environments.find((e) => e.isGlobal)?.id)
const env = ref(null)
const revealed = ref({})
watch(
  [selectedId, () => state.environments.length],
  () => (env.value = state.environments.find((e) => e.id === selectedId.value) || state.environments[0]),
  { immediate: true },
)

const changed = () => touchEnvironment(env.value)

function add() {
  const e = createEnvironment('New Environment')
  selectedId.value = e.id
}
function addVar() {
  env.value.variables.push({ id: uid(), key: '', value: '', enabled: true, isSecret: false })
  changed()
}
function removeVar(i) {
  env.value.variables.splice(i, 1)
  changed()
}
function remove() {
  if (!confirm(`Delete environment "${env.value.name}"?`)) return
  deleteEnvironment(env.value.id)
  selectedId.value = state.environments[0]?.id
}
</script>

<template>
  <Modal title="Environments" width="max-w-4xl" @close="emit('close')">
    <div class="flex min-h-96 text-sm">
      <aside class="w-52 shrink-0 space-y-0.5 border-r border-zinc-800 p-2">
        <button
          v-for="e in state.environments"
          :key="e.id"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left"
          :class="e.id === env?.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/50'"
          @click="selectedId = e.id"
        >
          <Globe v-if="e.isGlobal" :size="14" class="text-sky-400" />
          <span class="truncate">{{ e.name }}</span>
          <span v-if="e.id === state.activeEnvId" class="ml-auto h-2 w-2 rounded-full bg-emerald-500" title="Active"></span>
        </button>
        <button class="inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" @click="add"><Plus :size="14" /> New environment</button>
      </aside>

      <div v-if="env" class="min-w-0 flex-1 p-4">
        <div class="mb-3 flex items-center gap-2">
          <input v-model="env.name" :disabled="env.isGlobal" class="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-medium outline-none focus:border-zinc-500 disabled:border-transparent" @input="changed" />
          <template v-if="!env.isGlobal">
            <button v-if="state.activeEnvId !== env.id" class="rounded bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700" @click="setActiveEnv(env.id)">Set active</button>
            <span v-else class="px-2 text-xs text-emerald-400">Active</span>
            <button class="rounded p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400" title="Delete" @click="remove"><Trash2 :size="15" /></button>
          </template>
        </div>
        <p v-if="env.isGlobal" class="mb-3 text-xs text-zinc-500">Globals are available in every environment. Active environment values override globals with the same name.</p>

        <table class="w-full table-fixed">
          <thead>
            <tr class="text-left text-xs text-zinc-500">
              <th class="w-8"></th>
              <th class="px-2 py-1 font-medium">Variable</th>
              <th class="px-2 py-1 font-medium">Value</th>
              <th class="w-20"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(v, i) in env.variables" :key="v.id" class="group border-t border-zinc-800">
              <td class="text-center"><input v-model="v.enabled" type="checkbox" class="accent-orange-500" @change="changed" /></td>
              <td class="px-2 py-1"><input v-model="v.key" placeholder="name" class="w-full bg-transparent font-mono text-[13px] outline-none" @input="changed" /></td>
              <td class="px-2 py-1">
                <input
                  v-model="v.value"
                  :type="v.isSecret && !revealed[v.id] ? 'password' : 'text'"
                  placeholder="value"
                  class="w-full bg-transparent font-mono text-[13px] outline-none"
                  autocomplete="off"
                  @input="changed"
                />
              </td>
              <td class="pr-1 text-right whitespace-nowrap">
                <button v-if="v.isSecret" class="rounded p-1 text-zinc-500 hover:text-zinc-200" :title="revealed[v.id] ? 'Hide' : 'Show'" @click="revealed[v.id] = !revealed[v.id]">
                  <EyeOff v-if="revealed[v.id]" :size="14" /><Eye v-else :size="14" />
                </button>
                <button
                  class="rounded p-1"
                  :class="v.isSecret ? 'text-amber-400' : 'text-zinc-600 hover:text-zinc-300'"
                  :title="v.isSecret ? 'Secret: masked and excluded from exports/public docs. Click to unmark.' : 'Mark as secret'"
                  @click="(v.isSecret = !v.isSecret), changed()"
                >
                  <Lock v-if="v.isSecret" :size="14" /><Unlock v-else :size="14" />
                </button>
                <button class="rounded p-1 text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-red-400" @click="removeVar(i)"><Trash2 :size="14" /></button>
              </td>
            </tr>
          </tbody>
        </table>
        <button class="mt-1 inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" @click="addVar"><Plus :size="14" /> Add variable</button>

        <details class="mt-6 text-xs text-zinc-500">
          <summary class="cursor-pointer hover:text-zinc-300">Built-in dynamic variables</summary>
          <ul class="mt-2 space-y-1">
            <li v-for="(d, k) in DYNAMIC_DESCRIPTIONS" :key="k"><code class="text-violet-300">{{ '{' + '{' + k + '}' + '}' }}</code> — {{ d }}</li>
          </ul>
        </details>
      </div>
    </div>
  </Modal>
</template>
