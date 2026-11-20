<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Cloud, CloudOff, Globe2, Info, Loader2, LogOut, Monitor, Settings2, Zap } from 'lucide-vue-next'
import Sidebar from './components/Sidebar.vue'
import RequestEditor from './components/RequestEditor.vue'
import ResponseViewer from './components/ResponseViewer.vue'
import EnvironmentModal from './components/EnvironmentModal.vue'
import ImportModal from './components/ImportModal.vue'
import CodeModal from './components/CodeModal.vue'
import AuthModal from './components/AuthModal.vue'
import CollectionModal from './components/CollectionModal.vue'
import { activeRequest, addRequest, cloudEnabled, createCollection, init, saveNow, send, setActiveEnv, setMode, signOut, state } from './store.js'

const modal = ref(null) // env | import | code | auth | collection
const collectionCtx = ref(null) // { col, tab }
function openCollection(ctx) {
  collectionCtx.value = ctx
  modal.value = 'collection'
}
const sidebarOpen = ref(true)

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

function quickNewRequest() {
  const col = state.collections[0] || createCollection('My Collection')
  addRequest(col, null)
}

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

  <div v-else class="flex h-screen flex-col bg-zinc-950 text-zinc-200">
    <!-- Top bar -->
    <header :inert="!!modal" class="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800 px-3">
      <button class="flex items-center gap-2 font-semibold" title="Toggle sidebar" @click="sidebarOpen = !sidebarOpen">
        <img src="/favicon.svg" class="h-6 w-6" alt="" />
        <span class="hidden sm:inline">PostLite</span>
      </button>

      <div class="ml-auto flex items-center gap-2 text-sm">
        <!-- Mode -->
        <div class="flex rounded-md border border-zinc-700 p-0.5 text-xs">
          <button class="inline-flex items-center gap-1 rounded px-2 py-1" :class="state.mode === 'direct' ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'" title="Direct Browser Mode: fetch from your browser. Works with localhost if the API allows CORS." @click="setMode('direct')">
            <Monitor :size="13" /> Direct
          </button>
          <button class="inline-flex items-center gap-1 rounded px-2 py-1" :class="state.mode === 'proxy' ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'" title="Netlify Proxy Mode: bypasses CORS for public APIs. Cannot reach localhost." @click="setMode('proxy')">
            <Zap :size="13" /> Proxy
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

        <!-- Account / sync -->
        <template v-if="cloudEnabled">
          <button v-if="!state.user" class="inline-flex items-center gap-1.5 rounded-md bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700" @click="modal = 'auth'">
            <Cloud :size="14" /> Sign in
          </button>
          <div v-else class="flex items-center gap-2 text-xs">
            <span class="inline-flex items-center gap-1" :class="state.sync.status === 'error' ? 'text-red-400' : 'text-zinc-400'" :title="state.sync.message || state.user.email">
              <Loader2 v-if="state.sync.status === 'syncing'" :size="13" class="animate-spin" />
              <Cloud v-else :size="13" />
              {{ syncLabel[state.sync.status] }}
            </span>
            <span class="hidden max-w-40 truncate text-zinc-500 md:inline">{{ state.user.email }}</span>
            <button class="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100" title="Sign out" @click="signOut"><LogOut :size="14" /></button>
          </div>
        </template>
        <span v-else class="inline-flex items-center gap-1 text-xs text-zinc-500" title="Supabase is not configured. Data is stored in this browser only (IndexedDB).">
          <CloudOff :size="13" /> Local only
        </span>
      </div>
    </header>

    <div :inert="!!modal" class="flex min-h-0 flex-1" :class="{ invisible: modal }">
      <Sidebar v-show="sidebarOpen" class="w-72 shrink-0" @import="modal = 'import'" @collection="openCollection" />

      <main class="flex min-w-0 flex-1 flex-col">
        <template v-if="activeRequest">
          <RequestEditor class="min-h-0 flex-1" @show-code="modal = 'code'" />
          <ResponseViewer class="min-h-0 flex-1" />
        </template>
        <div v-else class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-zinc-500">
          <img src="/favicon.svg" class="h-12 w-12 opacity-60" alt="" />
          <p>Select a request from the sidebar, or</p>
          <div class="flex gap-2">
            <button class="rounded bg-orange-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-600" @click="quickNewRequest">New request</button>
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
    <AuthModal v-if="modal === 'auth'" @close="modal = null" />
    <CollectionModal v-if="modal === 'collection'" :collection="collectionCtx.col" :initial-tab="collectionCtx.tab" @close="modal = null" />

    <!-- Toasts -->
    <div class="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2">
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
</template>
