<!-- "About Curlion" dialog, opened from the header. -->
<script setup>
import Modal from './Modal.vue'
import { theme } from '../lib/theme.js'

const emit = defineEmits(['close'])
</script>

<template>
  <Modal title="About Curlion" width="max-w-lg" @close="emit('close')">
    <div class="space-y-5 px-6 py-6 text-sm leading-relaxed text-zinc-300">
      <img :src="theme === 'dark' ? '/brand/curlion-logo-dark.svg' : '/brand/curlion-logo-light.svg'" alt="Curlion" class="mx-auto h-20 w-auto" />
      <p>
        Curlion started with one simple question:
        <em class="text-zinc-100">“Why does sending a 10-line JSON payload require an app heavier than an operating system?”</em>
      </p>
      <p>
        So I built Curlion—well, technically, AI wrote the code while I bravely typed the prompts—so you can import your cURLs, test endpoints, and clock out on time
        without your laptop fans preparing for takeoff.
      </p>
      <p class="border-t border-zinc-800 pt-4 text-center text-xs text-zinc-500">
        Made with <kbd class="rounded border border-zinc-700 px-1 font-mono text-[11px] text-zinc-400">Ctrl+C</kbd>,
        <kbd class="rounded border border-zinc-700 px-1 font-mono text-[11px] text-zinc-400">Ctrl+V</kbd>, and aggressive prompting by
        <a href="https://gedelumbung.com" target="_blank" rel="noopener noreferrer" class="text-zinc-300 underline decoration-zinc-700 underline-offset-[3px] transition-colors hover:text-orange-400 hover:decoration-orange-400">Gede Lumbung</a>.
      </p>
    </div>
  </Modal>
</template>
