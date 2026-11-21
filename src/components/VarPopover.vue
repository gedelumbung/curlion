<!-- Inline {{variable}} editor (like Postman): opens below a variable clicked in any editor.
     Defined: edit your current value and the (shared) initial value. Undefined: add it.
     Dynamic ({{$uuid}}…): explains what it generates. -->
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Eye, EyeOff, Lock, Plus, RotateCcw, X } from 'lucide-vue-next'
import { activeEnv, addVariable, closeVarPopover, cloudEnabled, globalEnv, scope, setCurrentValue, state, touchEnvironment } from '../store.js'
import { DYNAMIC_DESCRIPTIONS, DYNAMIC_VARS } from '../lib/variables.js'
import { vTopLayer } from '../lib/topLayer.js'
import UiSelect from './UiSelect.vue'

const card = ref(null)
const pos = ref({ left: 0, top: 0 })
const reveal = ref(false)

const name = computed(() => state.varPopover?.name)
const dynamic = computed(() => name.value in DYNAMIC_VARS)
const entry = computed(() => (name.value ? scope.value.get(name.value) : null))
const env = computed(() => (entry.value ? state.environments.find((e) => e.id === entry.value.envId) : null))
const variable = computed(() => env.value?.variables.find((v) => v.id === entry.value.varId) || null)
const shared = computed(() => cloudEnabled && !!env.value && !env.value.isGlobal)

const current = computed({
  get: () => (env.value && variable.value ? (state.envCurrent[env.value.id]?.[variable.value.id] ?? '') : ''),
  set: (val) => setCurrentValue(env.value.id, variable.value.id, val),
})
function onInitialInput(e) {
  variable.value.value = e.target.value
  touchEnvironment(env.value)
}
const inputType = computed(() => (variable.value?.isSecret && !reveal.value ? 'password' : 'text'))

// ---- add an undefined variable ---------------------------------------------
const targets = computed(() => [activeEnv.value, globalEnv.value].filter(Boolean))
const targetOptions = computed(() =>
  targets.value.map((t) => ({ value: t.id, label: t.isGlobal ? 'Globals' : t.name, hint: t.isGlobal ? 'only you' : cloudEnabled ? 'shared' : '' })),
)
const targetId = ref(activeEnv.value?.id || globalEnv.value?.id)
const newValue = ref('')
const looksSecret = computed(() => /token|secret|password|key/i.test(name.value || ''))
function add() {
  const target = state.environments.find((e) => e.id === targetId.value)
  if (!target) return
  // In a shared environment a secret-looking value stays private (current value only).
  const isShared = cloudEnabled && !target.isGlobal
  const keepPrivate = isShared && looksSecret.value
  const v = addVariable(target.id, name.value, keepPrivate ? '' : newValue.value, looksSecret.value)
  if (v && keepPrivate && newValue.value) setCurrentValue(target.id, v.id, newValue.value)
  newValue.value = ''
}

// ---- placement and closing ----------------------------------------------------
async function place() {
  await nextTick()
  const r = state.varPopover?.rect
  if (!r || !card.value) return
  const w = card.value.offsetWidth
  const h = card.value.offsetHeight
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8))
  const below = r.bottom + 6
  const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below
  pos.value = { left, top }
}
watch(() => state.varPopover, () => {
  reveal.value = false
  newValue.value = ''
  targetId.value = activeEnv.value?.id || globalEnv.value?.id
  place()
})
watch(() => [entry.value, dynamic.value], place)
watch(() => state.active?.requestId, closeVarPopover)

const onKey = (e) => e.key === 'Escape' && closeVarPopover()
const onDown = (e) => {
  if (card.value?.contains(e.target)) return
  if (e.target instanceof Element && e.target.closest('.cm-var[data-var]')) return // clicking another variable re-targets
  closeVarPopover()
}
const onScroll = (e) => !card.value?.contains(e.target) && closeVarPopover()
onMounted(() => {
  place()
  window.addEventListener('keydown', onKey)
  document.addEventListener('mousedown', onDown, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', closeVarPopover)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('mousedown', onDown, true)
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', closeVarPopover)
})
</script>

<template>
  <div v-top-layer class="top-layer passthrough">
    <div
      ref="card"
      class="pointer-events-auto absolute w-80 rounded-md border border-zinc-700 bg-zinc-800 text-xs shadow-xl"
      :style="{ left: pos.left + 'px', top: pos.top + 'px' }"
      role="dialog"
      :aria-label="`Variable ${name}`"
    >
      <header class="flex items-center gap-2 border-b border-zinc-700 px-3 py-2">
        <code class="min-w-0 truncate font-mono text-[13px] text-zinc-100">{{ '{' + '{' + name + '}' + '}' }}</code>
        <span v-if="dynamic" class="shrink-0 rounded bg-violet-500/15 px-1.5 py-0.5 text-violet-300">dynamic</span>
        <span v-else-if="env" class="shrink-0 truncate rounded bg-zinc-700/60 px-1.5 py-0.5 text-zinc-300" :title="env.isGlobal ? 'Private to you' : shared ? 'Shared with your team' : ''">
          {{ env.name }}
        </span>
        <span v-else class="shrink-0 rounded bg-red-500/15 px-1.5 py-0.5 text-red-400">not defined</span>
        <Lock v-if="variable?.isSecret" :size="12" class="shrink-0 text-amber-400" title="Secret" />
        <button class="ml-auto shrink-0 rounded p-0.5 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-100" title="Close (Esc)" @click="closeVarPopover"><X :size="14" /></button>
      </header>

      <!-- dynamic variable -->
      <div v-if="dynamic" class="space-y-1 p-3 text-zinc-300">
        <p>{{ DYNAMIC_DESCRIPTIONS[name] }}.</p>
        <p class="text-zinc-500">A new value is generated every time the request is sent.</p>
      </div>

      <!-- defined: edit values -->
      <div v-else-if="variable" class="space-y-2.5 p-3">
        <label class="block">
          <span class="mb-1 flex items-center gap-1 text-zinc-400">Current value <span class="text-zinc-600">(only you)</span></span>
          <span class="flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900 px-2 focus-within:border-zinc-500">
            <input
              v-model="current"
              :type="inputType"
              :placeholder="variable.value && !variable.isSecret ? variable.value : 'same as initial value'"
              class="min-w-0 flex-1 bg-transparent py-1.5 font-mono text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600"
              autocomplete="off"
              spellcheck="false"
              @keydown.enter="closeVarPopover"
            />
            <button v-if="current" class="shrink-0 rounded p-0.5 text-zinc-500 hover:text-zinc-200" title="Reset to the initial value" @click="current = ''"><RotateCcw :size="12" /></button>
          </span>
        </label>
        <label class="block">
          <span class="mb-1 block text-zinc-400">{{ shared ? 'Initial value' : 'Value' }} <span class="text-zinc-600">{{ shared ? '(shared with team)' : env.isGlobal ? '(your Globals)' : '' }}</span></span>
          <span class="flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900 px-2 focus-within:border-zinc-500">
            <input
              :value="variable.value"
              :type="inputType"
              placeholder="empty"
              class="min-w-0 flex-1 bg-transparent py-1.5 font-mono text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600"
              autocomplete="off"
              spellcheck="false"
              @input="onInitialInput"
              @keydown.enter="closeVarPopover"
            />
          </span>
        </label>
        <div class="flex items-center justify-between text-zinc-500">
          <span>Using: <span class="text-zinc-300">{{ entry.isCurrent ? 'current value' : 'initial value' }}</span></span>
          <button v-if="variable.isSecret" class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-zinc-700 hover:text-zinc-100" @click="reveal = !reveal">
            <EyeOff v-if="reveal" :size="12" /><Eye v-else :size="12" /> {{ reveal ? 'Hide' : 'Show' }}
          </button>
        </div>
      </div>

      <!-- undefined: add it -->
      <form v-else class="space-y-2.5 p-3" @submit.prevent="add">
        <p class="text-zinc-400">This variable is not defined in the active environment or Globals.</p>
        <label class="block">
          <span class="mb-1 block text-zinc-400">Add to</span>
          <UiSelect v-model="targetId" :options="targetOptions" class="w-full" button-class="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100" />
        </label>
        <label class="block">
          <span class="mb-1 block text-zinc-400">Value</span>
          <input
            v-model="newValue"
            :type="looksSecret ? 'password' : 'text'"
            class="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-[12px] text-zinc-100 outline-none focus:border-zinc-500"
            autocomplete="off"
            spellcheck="false"
          />
        </label>
        <p v-if="looksSecret && cloudEnabled" class="text-zinc-500">Looks like a secret: it is stored as your current value only, not shared.</p>
        <button type="submit" class="inline-flex w-full items-center justify-center gap-1 rounded bg-orange-500 py-1.5 font-medium text-white hover:bg-orange-600"><Plus :size="13" /> Add variable</button>
      </form>
    </div>
  </div>
</template>
