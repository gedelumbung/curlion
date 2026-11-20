<script setup>
import { X } from 'lucide-vue-next'
import { onBeforeUnmount, onMounted } from 'vue'

defineProps({ title: String, width: { type: String, default: 'max-w-2xl' } })
const emit = defineEmits(['close'])
const onKey = (e) => e.key === 'Escape' && emit('close')
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto p-4 pt-[8vh]"
      style="background-color: rgb(9 9 11 / 0.9)"
      @mousedown.self="emit('close')"
    >
      <div
        class="flex max-h-[84vh] w-full flex-col rounded-lg border border-zinc-700 shadow-2xl ring-1 shadow-black/60 ring-black/40"
        style="background-color: #18181b"
        :class="width"
        role="dialog"
        aria-modal="true"
      >
        <header class="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h2 class="font-semibold">{{ title }}</h2>
          <button class="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" @click="emit('close')"><X :size="18" /></button>
        </header>
        <div class="min-h-0 flex-1 overflow-auto">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="flex items-center justify-end gap-2 border-t border-zinc-800 px-4 py-3">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>
