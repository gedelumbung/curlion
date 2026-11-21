<!-- Curlion mark (inline SVG): the icon part of public/brand/curlion-logo-{dark,light}.svg,
     with the dark or light palette following the app theme. -->
<script setup>
import { computed, useId } from 'vue'
import { theme } from '../lib/theme.js'

const gradId = `curlion-grad-${useId()}` // unique per instance: the logo appears more than once
const c = computed(() =>
  theme.value === 'dark'
    ? { g0: '#00D2FF', g1: '#1A73E8', chev: '#00C4FA', under: '#00B8F4' }
    : { g0: '#00B4D8', g1: '#1A73E8', chev: '#00B4D8', under: '#0284C7' },
)
</script>

<template>
  <svg viewBox="9 12 96 96" fill="none" role="img" aria-label="Curlion">
    <defs>
      <linearGradient :id="gradId" x1="20" y1="20" x2="100" y2="100" gradientUnits="userSpaceOnUse">
        <stop offset="0%" :stop-color="c.g0" />
        <stop offset="100%" :stop-color="c.g1" />
      </linearGradient>
    </defs>
    <path d="M 30 31 A 42 42 0 0 1 88 26 L 93 20 L 97 38 L 79 35 L 83 31 A 32 32 0 0 0 37 38 Z" :fill="`url(#${gradId})`" />
    <path d="M 30 89 A 42 42 0 0 0 88 94 L 93 100 L 97 82 L 79 85 L 83 89 A 32 32 0 0 1 37 82 Z" :fill="`url(#${gradId})`" />
    <path d="M 22 46 L 37 60 L 22 74" :stroke="c.chev" stroke-width="9.5" stroke-linecap="round" stroke-linejoin="round" />
    <line x1="47" y1="74" x2="71" y2="74" :stroke="c.under" stroke-width="9.5" stroke-linecap="round" />
  </svg>
</template>
