<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Activity, Cloud, CloudOff, Globe2, Info, Laptop, Loader2, LogOut, Monitor, Moon, Settings2, Sun, Zap } from 'lucide-vue-next'
import { setDark, theme } from './lib/theme.js'
import { vTopLayer } from './lib/topLayer.js'
import Sidebar from './components/Sidebar.vue'
import RequestEditor from './components/RequestEditor.vue'
import TabBar from './components/TabBar.vue'
import CollectionOverview from './components/CollectionOverview.vue'
import BeaconLogo from './components/BeaconLogo.vue'
import ResponseViewer from './components/ResponseViewer.vue'
import EnvironmentModal from './components/EnvironmentModal.vue'
import ImportModal from './components/ImportModal.vue'
import CodeModal from './components/CodeModal.vue'
import LoginScreen from './components/LoginScreen.vue'
import CollectionModal from './components/CollectionModal.vue'
import ActivityDashboard from './components/ActivityDashboard.vue'
import AgentModal from './components/AgentModal.vue'
import UnsavedDialog from './components/UnsavedDialog.vue'
import VarPopover from './components/VarPopover.vue'
import { activeOverview, activeRequest, addNewRequest, checkAgent, cloudEnabled, init, openTabs, saveNow, send, setActiveEnv, setMode, signOut, state } from './store.js'

const modal = ref(null) // env | import | code | collection | activity | agent
const collectionCtx = ref(null) // { col, tab }
function openCollection(ctx) {
  collectionCtx.value = ctx
  modal.value = 'collection'
}
const sidebarOpen = ref(true)

// Agent button: switch to Agent mode; open the setup when it is already selected or not running
async function pickAgent() {
  if (state.mode === 'agent') return (modal.value = 'agent')
  setMode('agent')
  if (!(await checkAgent())) modal.value = 'agent'
}

const signingOut = ref(false)
async function doSignOut() {
  signingOut.value = true
  try {
    await signOut()
  } finally {
    signingOut.value = false
  }
}

// ---- Resizable panes (sidebar width, request/response split), remembered per browser
const SIDEBAR_DEFAULT = 288
const SPLIT_DEFAULT = 0.5
function loadNum(key, fallback) {
  try {
    const n = parseFloat(localStorage.getItem(key))
    return Number.isFinite(n) ? n : fallback
  } catch {
    return fallback
  }
}
function saveNum(key, n) {
  try {
    localStorage.setItem(key, String(n))
  } catch {}
}
const clamp = (n, min, max) => Math.min(max, Math.max(min, n))
const sidebarWidth = ref(loadNum('beacon.sidebarWidth', SIDEBAR_DEFAULT))
const split = ref(loadNum('beacon.split', SPLIT_DEFAULT)) // request editor share of the main column
const mainEl = ref(null)
const dragging = ref(null) // 'sidebar' | 'split'

function startDrag(kind, e) {
  e.preventDefault()
  dragging.value = kind
  const move = (ev) => {
    if (kind === 'sidebar') {
      sidebarWidth.value = clamp(ev.clientX, 200, Math.min(640, window.innerWidth - 360))
    } else {
      const r = mainEl.value.getBoundingClientRect()
      split.value = clamp((ev.clientY - r.top) / r.height, 0.15, 0.85)
    }
  }
  const up = () => {
    dragging.value = null
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    saveNum('beacon.sidebarWidth', sidebarWidth.value)
    saveNum('beacon.split', split.value)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}
function resetPane(kind) {
  if (kind === 'sidebar') saveNum('beacon.sidebarWidth', (sidebarWidth.value = SIDEBAR_DEFAULT))
  else saveNum('beacon.split', (split.value = SPLIT_DEFAULT))
}

function onKey(e) {
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault()
    saveNow()
  } else if (mod && e.key === 'Enter') {
    e.preventDefault()
    send()
  }
}
onMounted(() => {
  init()
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))


const syncLabel = {
  local: 'Local only',
  'signed-out': 'Sign in to sync',
  syncing: 'Syncing…',
  synced: 'Synced',
  error: 'Sync error',
}
</script>

<template>
  <div v-if="!state.ready" class="flex h-screen items-center justify-center bg-zinc-950 text-zinc-500">
    <Loader2 class="animate-spin" />
  </div>

  <!-- With Supabase configured, everything is behind sign-in -->
  <LoginScreen v-else-if="cloudEnabled && !state.user" />

  <div v-else class="flex h-screen flex-col bg-zinc-950 text-zinc-200">
    <!-- Top bar -->
    <header :inert="!!modal" class="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800 px-3">
      <button class="flex items-center gap-2 font-semibold" title="Toggle sidebar" @click="sidebarOpen = !sidebarOpen">
        <BeaconLogo class="h-6 w-6 text-zinc-100" />
        <span class="hidden sm:inline">Beacon</span>
      </button>

      <div class="ml-auto flex items-center gap-2 text-sm">
        <!-- Mode -->
        <div class="flex rounded-md border border-zinc-700 p-0.5 text-xs">
          <button class="inline-flex items-center gap-1 rounded px-2 py-1" :class="state.mode === 'direct' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'" title="Direct Browser Mode: fetch from your browser. Works with localhost if the API allows CORS." @click="setMode('direct')">
            <Monitor :size="13" /> Direct
          </button>
          <button class="inline-flex items-center gap-1 rounded px-2 py-1" :class="state.mode === 'proxy' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'" title="Netlify Proxy Mode: bypasses CORS for public APIs. Cannot reach localhost." @click="setMode('proxy')">
            <Zap :size="13" /> Proxy
          </button>
          <button
            class="inline-flex items-center gap-1 rounded px-2 py-1"
            :class="state.mode === 'agent' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'"
            :title="state.mode === 'agent' ? `Agent mode: ${state.agent.status === 'online' ? 'agent running' : 'agent not running'}. Click for setup.` : 'Agent mode: send from your computer through the Beacon Agent (localhost, local network, no CORS)'"
            @click="pickAgent"
          >
            <Laptop :size="13" /> Agent
            <span
              v-if="state.mode === 'agent'"
              class="h-1.5 w-1.5 rounded-full"
              :class="state.agent.status === 'online' ? 'bg-emerald-500' : state.agent.status === 'offline' ? 'bg-red-500' : 'bg-zinc-500'"
            ></span>
          </button>
        </div>

        <!-- Environment switcher -->
        <div class="flex items-center rounded-md border border-zinc-700">
          <Globe2 :size="14" class="ml-2 text-zinc-500" />
          <select :value="state.activeEnvId || ''" class="max-w-40 bg-transparent px-2 py-1 text-xs outline-none" @change="setActiveEnv($event.target.value || null)">
            <option value="" class="bg-zinc-900">No environment</option>
            <option v-for="e in state.environments.filter((x) => !x.isGlobal)" :key="e.id" :value="e.id" class="bg-zinc-900">{{ e.name }}</option>
          </select>
          <button class="border-l border-zinc-700 p-1.5 text-zinc-400 hover:text-zinc-100" title="Manage environments" @click="modal = 'env'"><Settings2 :size="14" /></button>
        </div>

        <!-- Theme switch: on = dark -->
        <button
          role="switch"
          :aria-checked="theme === 'dark'"
          :title="theme === 'dark' ? 'Dark mode on (click for light)' : 'Dark mode off (click for dark)'"
          class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-zinc-700 transition-colors"
          :class="theme === 'dark' ? 'bg-zinc-800' : 'bg-zinc-900'"
          @click="setDark(theme !== 'dark')"
        >
          <span class="absolute flex h-5 w-5 items-center justify-center rounded-full shadow transition-transform" :class="theme === 'dark' ? 'translate-x-5 bg-orange-500 text-white' : 'translate-x-0.5 bg-white text-amber-500'">
            <Moon v-if="theme === 'dark'" :size="12" />
            <Sun v-else :size="12" />
          </span>
        </button>

        <!-- Workspace activity log -->
        <button v-if="cloudEnabled && state.user" class="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Activity log: who changed what" @click="modal = 'activity'">
          <Activity :size="14" /> <span class="hidden lg:inline">Activity</span>
        </button>

        <!-- Account / sync -->
        <template v-if="cloudEnabled">
          <div class="flex items-center gap-2 text-xs">
            <span class="inline-flex items-center gap-1" :class="state.sync.status === 'error' ? 'text-red-400' : 'text-zinc-400'" :title="state.sync.message || state.user.email">
              <Loader2 v-if="state.sync.status === 'syncing'" :size="13" class="animate-spin" />
              <Cloud v-else :size="13" />
              {{ syncLabel[state.sync.status] }}
            </span>
            <span class="hidden max-w-40 truncate text-zinc-500 md:inline">{{ state.user.email }}</span>
            <button class="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-60" :title="signingOut ? 'Syncing, then signing out…' : 'Sign out'" :disabled="signingOut" @click="doSignOut">
              <Loader2 v-if="signingOut" :size="14" class="animate-spin" />
              <LogOut v-else :size="14" />
            </button>
          </div>
        </template>
        <span v-else class="inline-flex items-center gap-1 text-xs text-zinc-500" title="Supabase is not configured. Data is stored in this browser only (IndexedDB).">
          <CloudOff :size="13" /> Local only
        </span>
      </div>
    </header>

    <div :inert="!!modal" class="flex min-h-0 flex-1" :class="{ 'select-none': dragging, 'cursor-col-resize': dragging === 'sidebar', 'cursor-row-resize': dragging === 'split' }">
      <Sidebar v-show="sidebarOpen" class="shrink-0" :style="{ width: sidebarWidth + 'px' }" @import="modal = 'import'" @collection="openCollection" />
      <div
        v-show="sidebarOpen"
        class="relative z-10 -ml-1 w-1 shrink-0 cursor-col-resize transition-colors hover:bg-orange-500/60"
        :class="{ 'bg-orange-500/60': dragging === 'sidebar' }"
        title="Drag to resize · double-click to reset"
        @pointerdown="startDrag('sidebar', $event)"
        @dblclick="resetPane('sidebar')"
      ></div>

      <main class="flex min-w-0 flex-1 flex-col">
        <TabBar v-if="openTabs.length" />
        <div v-if="activeRequest" ref="mainEl" class="flex min-h-0 flex-1 flex-col">
          <!-- keyed by request so each tab gets fresh editor state (active sub-tab, scroll) -->
          <RequestEditor :key="activeRequest.id" class="min-h-0" :style="{ flex: `0 0 ${split * 100}%` }" @show-code="modal = 'code'" />
          <div
            class="relative z-10 -mb-1 h-1 shrink-0 cursor-row-resize transition-colors hover:bg-orange-500/60"
            :class="{ 'bg-orange-500/60': dragging === 'split' }"
            title="Drag to resize · double-click to reset"
            @pointerdown="startDrag('split', $event)"
            @dblclick="resetPane('split')"
          ></div>
          <ResponseViewer :key="activeRequest.id" class="min-h-0 flex-1" />
        </div>
        <CollectionOverview v-else-if="activeOverview" :key="activeOverview.id" :collection="activeOverview" @collection="openCollection" />
        <div v-else class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-zinc-500">
          <BeaconLogo class="h-12 w-12 text-zinc-100 opacity-60" />
          <p>Select a request from the sidebar, or</p>
          <div class="flex gap-2">
            <button class="rounded bg-orange-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-600" @click="addNewRequest">New request</button>
            <button class="rounded bg-zinc-800 px-4 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700" @click="modal = 'import'">Import</button>
          </div>
          <p class="mt-4 flex items-center gap-1 text-xs text-zinc-600">
            <Info :size="12" /> Ctrl/⌘+Enter to send · Ctrl/⌘+S to save &amp; sync · paste cURL into the URL bar
          </p>
        </div>
      </main>
    </div>

    <EnvironmentModal v-if="modal === 'env'" @close="modal = null" />
    <ImportModal v-if="modal === 'import'" @close="modal = null" />
    <CodeModal v-if="modal === 'code'" @close="modal = null" />
    <ActivityDashboard v-if="modal === 'activity'" @close="modal = null" />
    <AgentModal v-if="modal === 'agent'" @close="modal = null" />
    <!-- keyed so each prompt in a multi-tab close gets a fresh dialog -->
    <VarPopover v-if="state.varPopover" />
    <UnsavedDialog v-if="state.unsavedPrompt" :key="state.unsavedPrompt.index + ':' + state.unsavedPrompt.name" />
    <CollectionModal v-if="modal === 'collection'" :collection="collectionCtx.col" :initial-tab="collectionCtx.tab" @close="modal = null" />

    <!-- Toasts: top layer, re-shown for each new toast so they sit above any open modal -->
    <div v-if="state.toasts.length" :key="state.toasts.at(-1).id" v-top-layer class="top-layer passthrough">
      <div class="absolute right-4 bottom-4 flex flex-col gap-2">
        <div
          v-for="t in state.toasts"
          :key="t.id"
          class="pointer-events-auto max-w-sm rounded-md border px-3 py-2 text-sm shadow-lg"
          :class="{
            'border-emerald-800 bg-emerald-950 text-emerald-200': t.type === 'success',
            'border-red-800 bg-red-950 text-red-200': t.type === 'error',
            'border-zinc-700 bg-zinc-800 text-zinc-200': t.type === 'info',
          }"
        >
          {{ t.message }}
        </div>
      </div>
    </div>
  </div>
</template>
