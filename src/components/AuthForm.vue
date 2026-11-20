<!-- Email/password + OAuth sign-in form, used by the login screen and the docs page. -->
<script setup>
import { ref } from 'vue'
import { supabase } from '../lib/supabase.js'

const mode = ref('signin')
const email = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')
const info = ref('')

// come back to the page the user started from (e.g. a /docs/<slug> link)
const returnTo = () => location.origin + location.pathname + location.search

async function submit() {
  busy.value = true
  error.value = ''
  info.value = ''
  try {
    if (mode.value === 'signin') {
      const { error: e } = await supabase.auth.signInWithPassword({ email: email.value, password: password.value })
      if (e) throw e
    } else {
      const { data, error: e } = await supabase.auth.signUp({ email: email.value, password: password.value, options: { emailRedirectTo: returnTo() } })
      if (e) throw e
      if (!data.session) info.value = 'Check your inbox to confirm your email, then sign in.'
    }
    // a successful sign-in is picked up through supabase.auth.onAuthStateChange
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

async function oauth(provider) {
  const { error: e } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo: returnTo() } })
  if (e) error.value = e.message
}
</script>

<template>
  <form class="space-y-3 text-sm" @submit.prevent="submit">
    <input v-model="email" type="email" required placeholder="Email" autocomplete="email" class="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 outline-none focus:border-zinc-500" />
    <input
      v-model="password"
      type="password"
      required
      minlength="6"
      placeholder="Password"
      :autocomplete="mode === 'signin' ? 'current-password' : 'new-password'"
      class="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 outline-none focus:border-zinc-500"
    />
    <button type="submit" :disabled="busy" class="w-full rounded bg-orange-500 py-2 font-medium text-white hover:bg-orange-600 disabled:opacity-50">
      {{ busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Sign up' }}
    </button>
    <div class="flex items-center gap-3 text-xs text-zinc-500"><span class="h-px flex-1 bg-zinc-800"></span>or<span class="h-px flex-1 bg-zinc-800"></span></div>
    <div class="flex gap-2">
      <button type="button" class="flex-1 rounded border border-zinc-700 py-2 hover:bg-zinc-800" @click="oauth('google')">Google</button>
      <button type="button" class="flex-1 rounded border border-zinc-700 py-2 hover:bg-zinc-800" @click="oauth('github')">GitHub</button>
    </div>
    <p v-if="error" class="text-red-400">{{ error }}</p>
    <p v-if="info" class="text-emerald-400">{{ info }}</p>
    <p class="text-center text-xs text-zinc-500">
      <template v-if="mode === 'signin'">No account? <button type="button" class="text-orange-400 hover:underline" @click="mode = 'signup'">Sign up</button></template>
      <template v-else>Have an account? <button type="button" class="text-orange-400 hover:underline" @click="mode = 'signin'">Sign in</button></template>
    </p>
  </form>
</template>
