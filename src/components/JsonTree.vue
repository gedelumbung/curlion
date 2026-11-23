<!-- Collapsible JSON tree viewer. -->
<script setup>
import { computed, ref } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import { linkParts } from '../lib/links.js'

defineOptions({ name: 'JsonTree' })
const props = defineProps({
  value: { required: true },
  name: { type: [String, Number], default: null },
  depth: { type: Number, default: 0 },
  last: { type: Boolean, default: true },
})
const open = ref(props.depth < 2)
const isObj = computed(() => props.value !== null && typeof props.value === 'object')
const isArr = computed(() => Array.isArray(props.value))
const entries = computed(() => (isObj.value ? Object.entries(props.value) : []))
const brackets = computed(() => (isArr.value ? ['[', ']'] : ['{', '}']))
const prim = computed(() => {
  const v = props.value
  if (v === null) return { text: 'null', cls: 'text-zinc-500' }
  if (typeof v === 'string') return { text: JSON.stringify(v), cls: 'text-emerald-300' }
  if (typeof v === 'number') return { text: String(v), cls: 'text-amber-300' }
  if (typeof v === 'boolean') return { text: String(v), cls: 'text-violet-300' }
  return { text: String(v), cls: '' }
})
</script>

<template>
  <div class="font-mono text-[13px] leading-6" :style="{ paddingLeft: depth ? '1rem' : 0 }">
    <template v-if="isObj">
      <span class="cursor-pointer select-none" @click="open = !open">
        <ChevronRight :size="12" class="mr-0.5 inline transition-transform" :class="{ 'rotate-90': open }" />
        <span v-if="name !== null" class="text-sky-300">{{ typeof name === 'number' ? name : JSON.stringify(name) }}</span><span v-if="name !== null" class="text-zinc-500">: </span>
        <span class="text-zinc-400">{{ brackets[0] }}</span>
        <span v-if="!open" class="text-zinc-500"> {{ entries.length }} {{ isArr ? 'items' : 'keys' }} {{ brackets[1] }}{{ last ? '' : ',' }}</span>
      </span>
      <template v-if="open">
        <JsonTree v-for="([k, v], i) in entries" :key="k" :name="isArr ? Number(k) : k" :value="v" :depth="depth + 1" :last="i === entries.length - 1" />
        <div class="text-zinc-400" style="padding-left: 0.9rem">{{ brackets[1] }}{{ last ? '' : ',' }}</div>
      </template>
    </template>
    <div v-else class="pl-3.5">
      <span v-if="name !== null" class="text-sky-300">{{ typeof name === 'number' ? name : JSON.stringify(name) }}</span><span v-if="name !== null" class="text-zinc-500">: </span>
      <span :class="prim.cls" class="break-all"><template v-for="(p, i) in linkParts(prim.text)" :key="i"><a v-if="p.url" :href="p.url" target="_blank" rel="noopener noreferrer" class="underline decoration-current/45 underline-offset-2 hover:decoration-current" :title="`Open ${p.url} in a new tab`">{{ p.text }}</a><template v-else>{{ p.text }}</template></template></span><span class="text-zinc-500">{{ last ? '' : ',' }}</span>
    </div>
  </div>
</template>
