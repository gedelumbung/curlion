<!-- Email/password sign-in form, used by the login screen and the docs page.
     There is no sign-up or OAuth: accounts are created by an administrator in Supabase. -->
<script setup>
import { ref } from 'vue'
import { supabase } from '../lib/supabase.js'
import { logSignIn } from '../store.js'

const email = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')

async function submit() {
  busy.value = true
  error.value = ''
  try {
    const { data, error: e } = await supabase.auth.signInWithPassword({ email: email.value, password: password.value })
    if (e) throw e
    logSignIn(data.user) // activity dashboard
    // a successful sign-in is picked up through supabase.auth.onAuthStateChange
  } catch (e) {
    error.value = e.message === 'Invalid login credentials' ? 'Wrong email or password.' : e.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form class="space-y-3 text-sm" @submit.prevent="submit">
    <input v-model="email" type="email" required placeholder="Email" autocomplete="email" class="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 outline-none focus:border-zinc-500" />
    <input
      v-model="password"
      type="password"
      required
      placeholder="Password"
      autocomplete="current-password"
      class="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 outline-none focus:border-zinc-500"
    />
    <button type="submit" :disabled="busy" class="w-full rounded bg-orange-500 py-2 font-medium text-white hover:bg-orange-600 disabled:opacity-50">
      {{ busy ? 'Signing in…' : 'Sign in' }}
    </button>
    <p v-if="error" class="text-red-400">{{ error }}</p>
    <p class="text-center text-xs text-zinc-500">No account? Ask your administrator to create one.</p>
  </form>
</template>
