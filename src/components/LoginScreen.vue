<!-- Full-page sign-in gate shown when Supabase is configured and nobody is signed in. -->
<script setup>
import AuthForm from './AuthForm.vue'
import BeaconLogo from './BeaconLogo.vue'

defineProps({ subtitle: { type: String, default: 'Sign in to open your collections.' } })
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-zinc-950 p-4 text-zinc-200">
    <div class="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
      <div class="mb-5 flex flex-col items-center gap-2 text-center">
        <BeaconLogo class="h-12 w-12 text-zinc-100" />
        <h1 class="text-lg font-semibold text-zinc-100">Beacon</h1>
        <p class="text-sm text-zinc-500">{{ subtitle }}</p>
      </div>
      <AuthForm />
    </div>
  </div>
</template>
