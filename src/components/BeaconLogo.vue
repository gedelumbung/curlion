<!-- Beacon logo (inline SVG). The outer rings use currentColor so they follow the theme;
     the signal rings stay green. public/favicon.svg is the same drawing for the browser tab. -->
<script setup>
import { useId } from 'vue'
const maskId = `beacon-slot-${useId()}` // unique per instance: the logo appears more than once
</script>

<template>
  <svg viewBox="0 0 64 64" fill="none" stroke-width="6" role="img" aria-label="Beacon">
    <defs>
      <mask :id="maskId" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
        <rect width="64" height="64" fill="#fff" />
        <rect x="29.25" y="42" width="5.5" height="22" fill="#000" />
      </mask>
    </defs>
    <g :mask="`url(#${maskId})`">
      <circle cx="32" cy="32" r="27" stroke="currentColor" />
      <circle cx="32" cy="32" r="16" stroke="#4caf50" />
    </g>
    <circle cx="32" cy="32" r="5" stroke="#4caf50" stroke-width="4.5" />
  </svg>
</template>
