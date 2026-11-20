<script setup>
// Rendered with <dialog>.showModal() so it lives in the browser's top layer:
// it always paints above the app, whatever z-index or compositing the page uses.
import { X } from 'lucide-vue-next'
import { onMounted, ref, useId } from 'vue'

defineProps({ title: String, width: { type: String, default: 'max-w-2xl' } })
const emit = defineEmits(['close'])
const dialog = ref(null)
const titleId = useId()

onMounted(() => dialog.value.showModal())
</script>

<template>
  <dialog
    ref="dialog"
    class="modal-dialog"
    :aria-labelledby="titleId"
    @cancel.prevent="emit('close')"
    @close="emit('close')"
  >
    <div class="flex min-h-full items-start justify-center p-4 pt-[8vh]" @mousedown.self="emit('close')">
      <div
        class="flex max-h-[84vh] w-full flex-col rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 shadow-2xl ring-1 shadow-black/60 ring-black/40"
        :class="width"
      >
        <header class="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h2 :id="titleId" class="font-semibold">{{ title }}</h2>
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
  </dialog>
</template>
