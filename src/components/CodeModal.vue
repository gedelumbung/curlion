<script setup>
import { computed, ref } from 'vue'
import { Copy } from 'lucide-vue-next'
import Modal from './Modal.vue'
import CodeEditor from './CodeEditor.vue'
import { activeRequest, scope, toast } from '../store.js'
import { resolveRequest } from '../lib/resolve.js'
import { generateSnippet, SNIPPET_LANGS } from '../lib/snippets.js'
import { copyText } from '../lib/ui.js'

const emit = defineEmits(['close'])
const lang = ref(localStorage.getItem('echo.snippetLang') || 'curl')
const maskSecrets = ref(true)

const code = computed(() => {
  if (!activeRequest.value) return ''
  const resolved = resolveRequest(activeRequest.value, scope.value, { maskSecrets: maskSecrets.value })
  return generateSnippet(lang.value, resolved)
})

function pick(id) {
  lang.value = id
  try {
    localStorage.setItem('echo.snippetLang', id)
  } catch {}
}
async function copy() {
  await copyText(code.value)
  toast('Snippet copied', 'success', 1500)
}
</script>

<template>
  <Modal title="Code snippet" width="max-w-4xl" @close="emit('close')">
    <div class="flex h-[60vh] text-sm">
      <aside class="w-48 shrink-0 space-y-0.5 border-r border-zinc-800 p-2">
        <button v-for="l in SNIPPET_LANGS" :key="l.id" class="w-full rounded px-2 py-1.5 text-left" :class="lang === l.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/50'" @click="pick(l.id)">
          {{ l.label }}
        </button>
      </aside>
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex items-center gap-3 border-b border-zinc-800 px-3 py-2 text-xs text-zinc-400">
          <label class="inline-flex items-center gap-1.5"><input v-model="maskSecrets" type="checkbox" class="accent-orange-500" /> Keep secret variables as <code v-pre>{{name}}</code></label>
          <button class="ml-auto inline-flex items-center gap-1 rounded bg-zinc-800 px-3 py-1 text-zinc-200 hover:bg-zinc-700" @click="copy"><Copy :size="13" /> Copy</button>
        </div>
        <div class="min-h-0 flex-1">
          <CodeEditor :model-value="code" readonly :variables="false" />
        </div>
      </div>
    </div>
  </Modal>
</template>
