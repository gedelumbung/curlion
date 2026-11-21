<!--
  Text input with a suggestion list (replaces the native <datalist>). The list only
  exists while it is shown. ↑ ↓ to move, Enter/Tab to accept, Esc to close.
-->
<script setup>
import { computed, nextTick, onBeforeUnmount, ref, useId } from 'vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  suggestions: { type: Array, default: () => [] },
  placeholder: { type: String, default: '' },
  inputClass: { type: [String, Array, Object], default: '' },
  limit: { type: Number, default: 8 },
})
const emit = defineEmits(['update:modelValue', 'input'])

const id = useId()
const input = ref(null)
const menu = ref(null)
const focused = ref(false)
const dismissed = ref(false)
const activeIdx = ref(0)
const pos = ref({ left: 0, top: 0, width: 0 })

const matches = computed(() => {
  const q = props.modelValue.trim().toLowerCase()
  if (!props.suggestions.length) return []
  const list = q
    ? [...props.suggestions.filter((s) => s.toLowerCase().startsWith(q)), ...props.suggestions.filter((s) => !s.toLowerCase().startsWith(q) && s.toLowerCase().includes(q))]
    : props.suggestions
  return list.filter((s) => s.toLowerCase() !== q).slice(0, props.limit)
})
const open = computed(() => focused.value && !dismissed.value && matches.value.length > 0)

async function place() {
  const r = input.value?.getBoundingClientRect()
  if (!r) return
  pos.value = { left: r.left, top: r.bottom + 4, width: Math.max(r.width, 200) }
  await nextTick()
  try {
    if (menu.value && !menu.value.matches(':popover-open')) menu.value.showPopover?.()
  } catch {}
}

function onInput(e) {
  emit('update:modelValue', e.target.value)
  emit('input', e)
  dismissed.value = false
  activeIdx.value = 0
  place()
}
function onFocus() {
  window.addEventListener('scroll', onScroll, true)
  focused.value = true
  dismissed.value = false
  activeIdx.value = 0
  place()
}
function onBlur() {
  window.removeEventListener('scroll', onScroll, true)
  focused.value = false
}
function accept(i) {
  const s = matches.value[i]
  if (s === undefined) return
  emit('update:modelValue', s)
  emit('input', { target: { value: s } })
  dismissed.value = true
}
function onKeydown(e) {
  if (!open.value) return
  if (e.key === 'ArrowDown') activeIdx.value = (activeIdx.value + 1) % matches.value.length
  else if (e.key === 'ArrowUp') activeIdx.value = (activeIdx.value - 1 + matches.value.length) % matches.value.length
  else if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) accept(activeIdx.value)
  else if (e.key === 'Escape') dismissed.value = true
  else return
  if (e.key !== 'Tab') e.preventDefault()
}
function onScroll() {
  dismissed.value = true
}
onBeforeUnmount(() => window.removeEventListener('scroll', onScroll, true))
</script>

<template>
  <span class="relative block">
    <input
      ref="input"
      :value="modelValue"
      :placeholder="placeholder"
      :class="inputClass"
      role="combobox"
      autocomplete="off"
      spellcheck="false"
      :aria-expanded="open"
      :aria-controls="`${id}-list`"
      @input="onInput"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKeydown"
    />
    <div
      v-if="open"
      :id="`${id}-list`"
      ref="menu"
      popover="manual"
      role="listbox"
      class="ui-select-menu max-h-64 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-800 p-1 text-[13px] text-zinc-200 shadow-xl"
      :style="{ left: pos.left + 'px', top: pos.top + 'px', minWidth: pos.width + 'px' }"
      @mousedown.prevent
    >
      <div
        v-for="(s, i) in matches"
        :key="s"
        role="option"
        :aria-selected="i === activeIdx"
        class="cursor-pointer rounded px-2 py-1 font-mono whitespace-nowrap"
        :class="i === activeIdx ? 'bg-zinc-700/80 text-zinc-100' : ''"
        @mouseenter="activeIdx = i"
        @click="accept(i)"
      >
        {{ s }}
      </div>
    </div>
  </span>
</template>
