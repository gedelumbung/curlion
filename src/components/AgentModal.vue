<!-- Beacon Agent: status and setup instructions. -->
<script setup>
import { computed, onMounted, ref } from 'vue'
import { Check, CheckCircle2, Copy, Loader2, RefreshCw, XCircle } from 'lucide-vue-next'
import Modal from './Modal.vue'
import { checkAgent, setAgentPort, setMode, state } from '../store.js'
import { AGENT_DEFAULT_PORT } from '../lib/http.js'
import { copyText } from '../lib/ui.js'

const emit = defineEmits(['close'])
const checking = ref(false)
const port = ref(state.agent.port)
const copied = ref(null)

const origin = location.origin
const portArg = computed(() => (Number(port.value) === AGENT_DEFAULT_PORT ? '' : ` --port ${port.value}`))
const commands = computed(() => [
  { id: 'unix', label: 'macOS / Linux', text: `curl -fsSLO ${origin}/beacon-agent.mjs && node beacon-agent.mjs --origin ${origin}${portArg.value}` },
  { id: 'win', label: 'Windows (PowerShell)', text: `iwr ${origin}/beacon-agent.mjs -OutFile beacon-agent.mjs; node beacon-agent.mjs --origin ${origin}${portArg.value}` },
])

async function check() {
  checking.value = true
  try {
    await checkAgent()
  } finally {
    checking.value = false
  }
}
onMounted(check)

function savePort() {
  setAgentPort(port.value)
}
async function copy(c) {
  await copyText(c.text)
  copied.value = c.id
  setTimeout(() => copied.value === c.id && (copied.value = null), 1500)
}
function useAgent() {
  setMode('agent')
  emit('close')
}
</script>

<template>
  <Modal title="Beacon Agent" width="max-w-2xl" @close="emit('close')">
    <div class="space-y-5 p-4 text-sm">
      <p class="text-zinc-400">
        The agent is a small program you run on your computer. In <b class="text-zinc-200">Agent mode</b>, Beacon sends requests through it, so they can reach
        <code class="text-zinc-300">localhost</code>, your local network and APIs that do not allow CORS, and can set headers browsers block (Cookie, Host, User-Agent).
      </p>

      <!-- Status -->
      <div class="flex items-center gap-3 rounded border px-3 py-2" :class="state.agent.status === 'online' ? 'border-emerald-800 bg-emerald-950/40' : 'border-zinc-800 bg-zinc-900/60'">
        <CheckCircle2 v-if="state.agent.status === 'online'" :size="18" class="text-emerald-400" />
        <XCircle v-else :size="18" class="text-zinc-500" />
        <span class="flex-1">
          <template v-if="state.agent.status === 'online'">Agent {{ state.agent.version }} is running on port {{ state.agent.port }}.</template>
          <template v-else>No agent found on 127.0.0.1:{{ state.agent.port }}.</template>
        </span>
        <button class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" @click="check">
          <Loader2 v-if="checking" :size="13" class="animate-spin" /><RefreshCw v-else :size="13" /> Check again
        </button>
      </div>

      <!-- Setup -->
      <ol class="list-decimal space-y-4 pl-5 text-zinc-300">
        <li>
          Install <a href="https://nodejs.org" target="_blank" class="text-orange-400 hover:underline">Node.js</a> 18 or newer (once).
        </li>
        <li>
          Open a terminal and run:
          <div v-for="c in commands" :key="c.id" class="mt-2">
            <p class="mb-1 text-xs text-zinc-500">{{ c.label }}</p>
            <div class="flex items-start gap-2 rounded border border-zinc-800 bg-zinc-950 p-2">
              <code class="min-w-0 flex-1 font-mono text-xs break-all text-zinc-200">{{ c.text }}</code>
              <button class="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100" title="Copy" @click="copy(c)">
                <Check v-if="copied === c.id" :size="14" class="text-emerald-400" /><Copy v-else :size="14" />
              </button>
            </div>
          </div>
          <p class="mt-2 text-xs text-zinc-500">Keep that terminal open while you work. Next time, only the <code>node beacon-agent.mjs …</code> part is needed.</p>
        </li>
        <li>
          If the browser asks to let this site <b class="text-zinc-200">access devices on your local network</b>, choose <b class="text-zinc-200">Allow</b>.
          <span class="text-zinc-500">(If you blocked it earlier: site settings in the address bar → Local network access → Allow.)</span>
        </li>
      </ol>

      <div class="flex flex-wrap items-end gap-3 border-t border-zinc-800 pt-4">
        <label class="text-xs text-zinc-500">
          Port
          <input v-model="port" type="number" min="1024" max="65535" class="mt-1 block w-28 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200 outline-none focus:border-zinc-500" @change="savePort" />
        </label>
        <p class="flex-1 text-xs text-zinc-500">
          The agent only listens on 127.0.0.1 and only accepts requests from <span class="text-zinc-300">{{ origin }}</span>.
          Self-signed HTTPS certificates are accepted; add <code>--strict-tls</code> to verify them.
        </p>
        <button v-if="state.mode !== 'agent'" class="rounded bg-orange-500 px-4 py-1.5 font-medium text-white hover:bg-orange-600" @click="useAgent">Use Agent mode</button>
      </div>
    </div>
  </Modal>
</template>
