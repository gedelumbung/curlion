<!--
  Lightweight custom select (no dependencies). The option list only exists while open,
  so a closed select is just a button.

  <UiSelect v-model="x" :options="[{ value, label, class?, hint? }]" />

  The list is shown in the browser top layer (Popover API) so it paints above everything,
  and stays a DOM descendant of the select so it keeps working inside modal dialogs.
  Keyboard: Enter/Space/↓ to open, ↑ ↓ Home End to move, Enter to pick, Esc/Tab to close,
  type letters to jump.
-->
<script setup>
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { Check, ChevronDown } from 'lucide-vue-next'

const props = defineProps({
  modelValue: { default: null },
  options: { type: Array, required: true }, // { value, label, class?, hint? }
  placeholder: { type: String, default: 'Select…' },
  disabled: { type: Boolean, default: false },
  title: { type: String, default: undefined },
  buttonClass: { type: [String, Array, Object], default: 'rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5' },
  menuWidth: { type: String, default: null }, // e.g. '12rem'; defaults to the button width
})
const emit = defineEmits(['update:modelValue', 'change'])

const id = useId()
const btn = ref(null)
const menu = ref(null)
const open = ref(false)
const activeIdx = ref(-1)
const pos = ref({ left: 0, top: 0, minWidth: 0 })

const selectedIdx = computed(() => props.options.findIndex((o) => o.value === props.modelValue))
const selected = computed(() => props.options[selectedIdx.value] || null)

function place() {
  const r = btn.value?.getBoundingClientRect()
  if (!r) return
  const h = menu.value?.offsetHeight || 0
  const w = menu.value?.offsetWidth || r.width
  const below = r.bottom + 4
  const top = below + h > window.innerHeight - 8 && r.top - h - 4 > 8 ? r.top - h - 4 : below
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8))
  pos.value = { left, top, minWidth: r.width }
}

async function show() {
  if (props.disabled || open.value) return
  open.value = true
  activeIdx.value = selectedIdx.value >= 0 ? selectedIdx.value : 0
  place()
  await nextTick()
  try {
    menu.value?.showPopover?.()
  } catch {}
  place() // again, now that the list has its real size
  scrollActive()
  document.addEventListener('mousedown', onOutside, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', hide)
}
function hide({ focus = false } = {}) {
  if (!open.value) return
  open.value = false
  document.removeEventListener('mousedown', onOutside, true)
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', hide)
  if (focus) btn.value?.focus()
}
onBeforeUnmount(() => hide())

function pick(i) {
  const o = props.options[i]
  if (!o) return
  if (o.value !== props.modelValue) {
    emit('update:modelValue', o.value)
    emit('change', o.value)
  }
  hide({ focus: true })
}

const onOutside = (e) => {
  if (btn.value?.contains(e.target) || menu.value?.contains(e.target)) return
  hide()
}
const onScroll = (e) => !menu.value?.contains(e.target) && hide()

async function scrollActive() {
  await nextTick()
  menu.value?.querySelector(`[data-idx="${activeIdx.value}"]`)?.scrollIntoView({ block: 'nearest' })
}
function move(delta) {
  const n = props.options.length
  if (!n) return
  activeIdx.value = (activeIdx.value + delta + n) % n
  scrollActive()
}

// type-ahead: jump to the next option starting with the typed text
let typed = ''
let typedTimer
function typeAhead(ch) {
  typed += ch.toLowerCase()
  clearTimeout(typedTimer)
  typedTimer = setTimeout(() => (typed = ''), 600)
  const n = props.options.length
  const start = open.value ? activeIdx.value : selectedIdx.value
  for (let k = 1; k <= n; k++) {
    const i = (start + (typed.length > 1 ? 0 : k) + n) % n
    if (String(props.options[i].label).toLowerCase().startsWith(typed)) {
      if (open.value) {
        activeIdx.value = i
        scrollActive()
      } else pick(i)
      return
    }
  }
}

function onKeydown(e) {
  const k = e.key
  if (!open.value) {
    if (k === 'Enter' || k === ' ' || k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault()
      show()
    } else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) typeAhead(k)
    return
  }
  if (k === 'ArrowDown') move(1)
  else if (k === 'ArrowUp') move(-1)
  else if (k === 'Home') (activeIdx.value = 0), scrollActive()
  else if (k === 'End') (activeIdx.value = props.options.length - 1), scrollActive()
  else if (k === 'Enter' || k === ' ') pick(activeIdx.value)
  else if (k === 'Escape') hide({ focus: true })
  else if (k === 'Tab') return hide()
  else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) typeAhead(k)
  else return
  e.preventDefault()
  e.stopPropagation()
}

watch(() => props.options.length, () => open.value && place())
</script>

<template>
  <span class="inline-flex min-w-0">
  <button
    ref="btn"
    type="button"
    class="inline-flex w-full min-w-0 items-center justify-between gap-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-orange-500/70 disabled:cursor-not-allowed disabled:opacity-50"
    :class="buttonClass"
    :disabled="disabled"
    :title="title"
    role="combobox"
    aria-haspopup="listbox"
    :aria-expanded="open"
    :aria-controls="`${id}-list`"
    @click="open ? hide() : show()"
    @keydown="onKeydown"
  >
    <span class="truncate" :class="selected ? selected.class : 'text-zinc-500'">{{ selected ? selected.label : placeholder }}</span>
    <ChevronDown :size="13" class="shrink-0 text-zinc-500 transition-transform" :class="{ 'rotate-180': open }" />
  </button>

    <div
      v-if="open"
      :id="`${id}-list`"
      ref="menu"
      popover="manual"
      role="listbox"
      class="ui-select-menu max-h-72 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-800 p-1 text-sm text-zinc-200 shadow-xl"
      :style="{ left: pos.left + 'px', top: pos.top + 'px', minWidth: menuWidth || pos.minWidth + 'px' }"
      @mousedown.prevent
      @keydown="onKeydown"
    >
      <div
        v-for="(o, i) in options"
        :key="String(o.value)"
        :data-idx="i"
        role="option"
        :aria-selected="o.value === modelValue"
        class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 whitespace-nowrap"
        :class="i === activeIdx ? 'bg-zinc-700/80' : ''"
        @mouseenter="activeIdx = i"
        @click="pick(i)"
      >
        <Check :size="13" class="shrink-0" :class="o.value === modelValue ? 'text-orange-400' : 'invisible'" />
        <span class="min-w-0 flex-1 truncate" :class="o.class">{{ o.label }}</span>
        <span v-if="o.hint" class="shrink-0 pl-3 text-xs text-zinc-500">{{ o.hint }}</span>
      </div>
      <p v-if="!options.length" class="px-2 py-1.5 text-zinc-500">No options</p>
    </div>
  </span>
</template>

