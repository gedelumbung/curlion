<script setup>
import { ref } from 'vue'
import Modal from './Modal.vue'
import { supabase } from '../lib/supabase.js'
import { toast } from '../store.js'

const emit = defineEmits(['close'])
const mode = ref('signin')
const email = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')
const info = ref('')

async function submit() {
  busy.value = true
  error.value = ''
  info.value = ''
  try {
    if (mode.value === 'signin') {
      const { error: e } = await supabase.auth.signInWithPassword({ email: email.value, password: password.value })
      if (e) throw e
      toast('Signed in. Syncing your collections…', 'success')
      emit('close')
    } else {
      const { data, error: e } = await supabase.auth.signUp({ email: email.value, password: password.value, options: { emailRedirectTo: location.origin } })
      if (e) throw e
      if (data.session) {
        toast('Account created', 'success')
        emit('close')
      } else info.value = 'Check your inbox to confirm your email, then sign in.'
    }
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

async function oauth(provider) {
  const { error: e } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo: location.origin } })
  if (e) error.value = e.message
}
</script>

<template>
  <Modal :title="mode === 'signin' ? 'Sign in to sync' : 'Create account'" width="max-w-sm" @close="emit('close')">
    <form class="space-y-3 p-4 text-sm" @submit.prevent="submit">
      <p class="text-xs text-zinc-500">Your local collections and environments are uploaded after you sign in, then kept in sync.</p>
      <input v-model="email" type="email" required placeholder="Email" autocomplete="email" class="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 outline-none focus:border-zinc-500" />
      <input v-model="password" type="password" required minlength="6" placeholder="Password" :autocomplete="mode === 'signin' ? 'current-password' : 'new-password'" class="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 outline-none focus:border-zinc-500" />
      <button type="submit" :disabled="busy" class="w-full rounded bg-orange-500 py-2 font-medium text-white hover:bg-orange-600 disabled:opacity-50">
        {{ busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Sign up' }}
      </button>
      <div class="flex gap-2">
        <button type="button" class="flex-1 rounded border border-zinc-700 py-2 hover:bg-zinc-800" @click="oauth('github')">GitHub</button>
        <button type="button" class="flex-1 rounded border border-zinc-700 py-2 hover:bg-zinc-800" @click="oauth('google')">Google</button>
      </div>
      <p v-if="error" class="text-red-400">{{ error }}</p>
      <p v-if="info" class="text-emerald-400">{{ info }}</p>
      <p class="text-center text-xs text-zinc-500">
        <template v-if="mode === 'signin'">No account? <button type="button" class="text-orange-400 hover:underline" @click="mode = 'signup'">Sign up</button></template>
        <template v-else>Have an account? <button type="button" class="text-orange-400 hover:underline" @click="mode = 'signin'">Sign in</button></template>
      </p>
    </form>
  </Modal>
</template>
