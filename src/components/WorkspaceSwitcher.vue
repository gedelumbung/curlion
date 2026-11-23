<!--
  Workspace switcher in the top bar (like Postman): pick, create, rename and delete
  workspaces. Every user can create team workspaces; only the creator can delete one.
-->
<script setup>
import { computed, nextTick, ref } from 'vue'
import { Check, ChevronDown, Loader2, Pencil, Plus, Trash2, User, Users } from 'lucide-vue-next'
import { vTopLayer } from '../lib/topLayer.js'
import { canDeleteWorkspace, cloudEnabled, createWorkspace, currentWorkspace, deleteWorkspace, renameWorkspace, state, switchWorkspace, toast } from '../store.js'

const btn = ref(null)
const open = ref(false)
const pos = ref({ left: 0, top: 0 })
const busy = ref(false)

const renamingId = ref(null)
const renameDraft = ref('')
const creating = ref(false)
const newName = ref('')

const personal = computed(() => state.workspaces.filter((w) => w.isPersonal))
const team = computed(() => state.workspaces.filter((w) => !w.isPersonal))

function toggle() {
  if (open.value) return close()
  const r = btn.value.getBoundingClientRect()
  pos.value = { left: r.left, top: r.bottom + 4 }
  open.value = true
}
function close() {
  open.value = false
  renamingId.value = null
  creating.value = false
  newName.value = ''
}

async function run(fn, failMsg) {
  busy.value = true
  try {
    return await fn()
  } catch (e) {
    toast(`${failMsg}: ${e.message || e}`, 'error')
  } finally {
    busy.value = false
  }
}

async function pick(ws) {
  if (renamingId.value) return
  close()
  await run(() => switchWorkspace(ws.id), 'Could not switch workspace')
}

async function startCreate() {
  creating.value = true
  await nextTick()
  document.getElementById('ws-new-name')?.focus()
}
async function commitCreate() {
  if (!newName.value.trim()) return (creating.value = false)
  const name = newName.value
  close()
  const ws = await run(() => createWorkspace(name), 'Could not create workspace')
  if (ws) toast(`Workspace "${ws.name}" created`, 'success', 1800)
}

async function startRename(ws) {
  renamingId.value = ws.id
  renameDraft.value = ws.name
  await nextTick()
  document.getElementById('ws-rename-' + ws.id)?.select()
}
async function commitRename(ws) {
  if (renamingId.value !== ws.id) return
  renamingId.value = null
  await run(() => renameWorkspace(ws.id, renameDraft.value), 'Could not rename workspace')
}

async function remove(ws) {
  const what = cloudEnabled ? ' for everyone' : ''
  if (!confirm(`Delete workspace "${ws.name}"${what}? All its collections and environments are deleted too.`)) return
  close()
  const ok = await run(() => deleteWorkspace(ws.id), 'Could not delete workspace')
  if (ok) toast(`Workspace "${ws.name}" deleted`, 'success', 1800)
}
</script>

<template>
  <button
    ref="btn"
    class="flex h-7 max-w-56 items-center gap-1.5 rounded-md px-2 text-[13px] text-zinc-300 hover:bg-zinc-800/60"
    :class="{ 'bg-zinc-800/60': open }"
    title="Switch workspace"
    aria-haspopup="menu"
    :aria-expanded="open"
    @click="toggle"
  >
    <Loader2 v-if="busy" :size="14" class="shrink-0 animate-spin text-zinc-500" />
    <User v-else-if="currentWorkspace?.isPersonal" :size="14" class="shrink-0 text-zinc-500" />
    <Users v-else :size="14" class="shrink-0 text-zinc-500" />
    <span class="truncate">{{ currentWorkspace?.name || 'Workspace' }}</span>
    <ChevronDown :size="13" class="shrink-0 text-zinc-500" />
  </button>

  <Teleport to="body">
    <div v-if="open" v-top-layer class="top-layer" @click="close" @contextmenu.prevent="close" @keydown.esc="close">
      <div
        class="absolute w-72 rounded-md border border-zinc-700 bg-zinc-800 py-1 text-sm shadow-xl"
        role="menu"
        :style="{ left: pos.left + 'px', top: pos.top + 'px' }"
        @click.stop
      >
        <template v-for="group in [{ label: 'Personal', list: personal }, { label: 'Team workspaces', list: team }]" :key="group.label">
          <div v-if="group.list.length" class="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">{{ group.label }}</div>
          <div
            v-for="ws in group.list"
            :key="ws.id"
            class="group flex items-center gap-2 px-3 py-1.5"
            :class="renamingId === ws.id ? '' : 'cursor-pointer hover:bg-zinc-700'"
            role="menuitemradio"
            :aria-checked="ws.id === state.workspaceId"
            @click="pick(ws)"
          >
            <User v-if="ws.isPersonal" :size="14" class="shrink-0 text-zinc-400" />
            <Users v-else :size="14" class="shrink-0 text-zinc-400" />
            <input
              v-if="renamingId === ws.id"
              :id="'ws-rename-' + ws.id"
              v-model="renameDraft"
              class="min-w-0 flex-1 rounded border border-zinc-600 bg-zinc-900 px-1.5 py-0.5 text-sm outline-none focus:border-orange-500"
              @click.stop
              @keydown.enter="commitRename(ws)"
              @keydown.esc.stop="renamingId = null"
              @blur="commitRename(ws)"
            />
            <span v-else class="min-w-0 flex-1 truncate" :class="ws.id === state.workspaceId ? 'text-zinc-100' : 'text-zinc-300'">{{ ws.name }}</span>
            <template v-if="renamingId !== ws.id">
              <button class="hidden rounded p-0.5 text-zinc-400 group-hover:block hover:bg-zinc-600 hover:text-zinc-100" title="Rename" @click.stop="startRename(ws)"><Pencil :size="13" /></button>
              <button v-if="canDeleteWorkspace(ws)" class="hidden rounded p-0.5 text-zinc-400 group-hover:block hover:bg-zinc-600 hover:text-red-400" title="Delete workspace" @click.stop="remove(ws)"><Trash2 :size="13" /></button>
              <Check v-if="ws.id === state.workspaceId" :size="14" class="shrink-0 text-orange-500" />
            </template>
          </div>
        </template>

        <div class="my-1 border-t border-zinc-700"></div>
        <div v-if="creating" class="flex items-center gap-2 px-3 py-1.5">
          <Users :size="14" class="shrink-0 text-zinc-400" />
          <input
            id="ws-new-name"
            v-model="newName"
            placeholder="Workspace name"
            class="min-w-0 flex-1 rounded border border-zinc-600 bg-zinc-900 px-1.5 py-0.5 text-sm outline-none placeholder:text-zinc-600 focus:border-orange-500"
            @keydown.enter="commitCreate"
            @keydown.esc.stop="creating = false"
          />
          <button class="rounded bg-orange-500 px-2 py-0.5 text-xs font-medium text-on-accent hover:bg-orange-600" @click="commitCreate">Create</button>
        </div>
        <button v-else class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-700" @click="startCreate">
          <Plus :size="14" /> New workspace
        </button>
        <p v-if="cloudEnabled" class="px-3 pt-1 pb-1.5 text-[11px] leading-snug text-zinc-500">Team workspaces are visible to everyone signed in. My Workspace is only visible to you.</p>
      </div>
    </div>
  </Teleport>
</template>
