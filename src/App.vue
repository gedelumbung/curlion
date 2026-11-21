<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Activity, CloudOff, Globe2, Info, Laptop, Loader2, LogOut, Monitor, Moon, Settings2, SlidersHorizontal, Sun, Zap } from 'lucide-vue-next'
import { setDark, theme, themeLabel } from './lib/theme.js'
import { vTopLayer } from './lib/topLayer.js'
import Sidebar from './components/Sidebar.vue'
import RequestEditor from './components/RequestEditor.vue'
import TabBar from './components/TabBar.vue'
import CollectionOverview from './components/CollectionOverview.vue'
import MessageLog from './components/MessageLog.vue'
import UiSelect from './components/UiSelect.vue'
import CurlionLogo from './components/CurlionLogo.vue'
import ResponseViewer from './components/ResponseViewer.vue'
import EnvironmentModal from './components/EnvironmentModal.vue'
import ImportModal from './components/ImportModal.vue'
import CodeModal from './components/CodeModal.vue'
import LoginScreen from './components/LoginScreen.vue'
import CollectionModal from './components/CollectionModal.vue'
import ActivityDashboard from './components/ActivityDashboard.vue'
import AgentModal from './components/AgentModal.vue'
import AboutModal from './components/AboutModal.vue'
import SettingsModal from './components/SettingsModal.vue'
import UnsavedDialog from './components/UnsavedDialog.vue'
import SaveRequestDialog from './components/SaveRequestDialog.vue'
import VarPopover from './components/VarPopover.vue'
import { activeOverview, activeRequest, addNewRequest, checkAgent, cloudEnabled, init, openTabs, saveNow, send, setActiveEnv, setMode, signOut, state } from './store.js'

const modal = ref(null) // env | import | code | collection | activity | agent | about | settings
const collectionCtx = ref(null) // { col, tab }
function openCollection(ctx) {
  collectionCtx.value = ctx
  modal.value = 'collection'
}
const sidebarOpen = ref(true)

const MODES = [
  { id: 'direct', label: 'Direct', icon: Monitor, title: 'Direct: fetch from your browser. Works with localhost if the API allows CORS.' },
  { id: 'proxy', label: 'Proxy', icon: Zap, title: 'Proxy: through the Netlify proxy, bypasses CORS for public APIs. Cannot reach localhost.' },
  { id: 'agent', label: 'Agent', icon: Laptop, title: 'Agent: send from your computer through the Curlion Agent (localhost, local network, no CORS)' },
]

const envOptions = computed(() => [
  { value: '', label: 'No environment', class: 'text-zinc-400' },
  ...state.environments.filter((e) => !e.isGlobal).map((e) => ({ value: e.id, label: e.name })),
])

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
const sidebarWidth = ref(loadNum('curlion.sidebarWidth', SIDEBAR_DEFAULT))
const split = ref(loadNum('curlion.split', SPLIT_DEFAULT)) // request editor share of the main column
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
    saveNum('curlion.sidebarWidth', sidebarWidth.value)
    saveNum('curlion.split', split.value)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}
function resetPane(kind) {
  if (kind === 'sidebar') saveNum('curlion.sidebarWidth', (sidebarWidth.value = SIDEBAR_DEFAULT))
  else saveNum('curlion.split', (split.value = SPLIT_DEFAULT))
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
    <header :inert="!!modal" class="flex h-11 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-925 px-3">
      <button class="flex items-center gap-2 rounded px-1 py-1 hover:bg-zinc-800/60" title="Toggle sidebar" @click="sidebarOpen = !sidebarOpen">
        <CurlionLogo class="h-[22px] w-[22px]" />
        <span class="hidden text-[15px] font-semibold tracking-tight text-zinc-100 sm:inline">Curlion</span>
      </button>

      <div class="ml-auto flex items-center gap-1.5 text-xs">
        <!-- Send mode -->
        <div class="flex items-center rounded-md bg-zinc-900 p-0.5" role="radiogroup" aria-label="Send mode">
          <button
            v-for="m in MODES"
            :key="m.id"
            role="radio"
            :aria-checked="state.mode === m.id"
            class="relative inline-flex h-6 items-center gap-1.5 rounded px-2.5 transition-colors"
            :class="state.mode === m.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200'"
            :title="m.id === 'agent' && state.mode === 'agent' ? `Agent ${state.agent.status === 'online' ? 'running' : 'not running'}. Click for setup.` : m.title"
            @click="m.id === 'agent' ? pickAgent() : setMode(m.id)"
          >
            <component :is="m.icon" :size="13" />
            {{ m.label }}
            <span
              v-if="m.id === 'agent' && state.mode === 'agent'"
              class="h-1.5 w-1.5 rounded-full"
              :class="state.agent.status === 'online' ? 'bg-emerald-500' : state.agent.status === 'offline' ? 'bg-red-500' : 'bg-zinc-500'"
            ></span>
          </button>
        </div>

        <span class="mx-1 h-5 w-px bg-zinc-800"></span>

        <!-- Environment -->
        <div class="flex items-center rounded-md hover:bg-zinc-900">
          <Globe2 :size="14" class="ml-2 shrink-0" :class="state.activeEnvId ? 'text-orange-500' : 'text-zinc-500'" />
          <UiSelect
            :model-value="state.activeEnvId || ''"
            :options="envOptions"
            class="w-40"
            button-class="h-7 px-2 text-xs"
            menu-width="14rem"
            title="Active environment"
            @update:model-value="setActiveEnv($event || null)"
          />
        </div>
        <button class="icon-btn" title="Manage environments" @click="modal = 'env'"><Settings2 :size="15" /></button>

        <span class="mx-1 h-5 w-px bg-zinc-800"></span>

        <button v-if="cloudEnabled && state.user" class="icon-btn" title="Activity log: who changed what" @click="modal = 'activity'"><Activity :size="15" /></button>
        <button class="icon-btn" :title="`Switch to ${themeLabel(theme === 'dark' ? 'light' : 'dark')}`" @click="setDark(theme !== 'dark')">
          <Sun v-if="theme === 'dark'" :size="15" />
          <Moon v-else :size="15" />
        </button>
        <button class="icon-btn" title="Settings" @click="modal = 'settings'"><SlidersHorizontal :size="15" /></button>
        <button class="icon-btn" title="About Curlion" @click="modal = 'about'"><Info :size="15" /></button>

        <!-- Account / sync -->
        <template v-if="cloudEnabled">
          <span class="mx-1 h-5 w-px bg-zinc-800"></span>
          <span class="inline-flex items-center gap-1.5 px-1" :class="state.sync.status === 'error' ? 'text-red-400' : 'text-zinc-500'" :title="state.sync.message || state.user.email">
            <Loader2 v-if="state.sync.status === 'syncing'" :size="13" class="animate-spin" />
            <span v-else class="h-1.5 w-1.5 rounded-full" :class="state.sync.status === 'error' ? 'bg-red-500' : 'bg-emerald-500'"></span>
            {{ syncLabel[state.sync.status] }}
          </span>
          <span class="hidden max-w-40 truncate text-zinc-500 lg:inline">{{ state.user.email }}</span>
          <button class="icon-btn disabled:opacity-60" :title="signingOut ? 'Syncing, then signing out…' : 'Sign out'" :disabled="signingOut" @click="doSignOut">
            <Loader2 v-if="signingOut" :size="15" class="animate-spin" />
            <LogOut v-else :size="15" />
          </button>
        </template>
        <span v-else class="ml-1 inline-flex items-center gap-1.5 text-zinc-500" title="Supabase is not configured. Data is stored in this browser only (IndexedDB).">
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
          <MessageLog v-if="activeRequest.protocol === 'ws' || activeRequest.protocol === 'socketio'" :key="'log' + activeRequest.id" class="min-h-0 flex-1" />
          <ResponseViewer v-else :key="activeRequest.id" class="min-h-0 flex-1" />
        </div>
        <CollectionOverview v-else-if="activeOverview" :key="activeOverview.id" :collection="activeOverview" @collection="openCollection" />
        <div v-else class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-zinc-500">
          <CurlionLogo class="h-12 w-12 text-zinc-100 opacity-60" />
          <p>Select a request from the sidebar, or</p>
          <div class="flex gap-2">
            <button class="rounded bg-orange-500 px-4 py-1.5 text-sm font-medium text-on-accent hover:bg-orange-600" @click="addNewRequest">New request</button>
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
    <AboutModal v-if="modal === 'about'" @close="modal = null" />
    <SettingsModal v-if="modal === 'settings'" @close="modal = null" />
    <!-- keyed so each prompt in a multi-tab close gets a fresh dialog -->
    <VarPopover v-if="state.varPopover" />
    <SaveRequestDialog v-if="state.savePrompt" />
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
