<!-- OAuth 2.0 settings and the current access token (kept in this browser only). -->
<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { Copy, KeyRound, Loader2, RefreshCw, Trash2 } from 'lucide-vue-next'
import VarInput from './VarInput.vue'
import UiSelect from './UiSelect.vue'
import { cancelOAuth, clearOAuthToken, completeOAuthRedirect, getNewOAuthToken, refreshOAuthToken, state, toast } from '../store.js'
import { OAUTH_GRANTS, defaultRedirectUri } from '../lib/oauth.js'
import { copyText } from '../lib/ui.js'

const props = defineProps({
  auth: { type: Object, required: true }, // auth with .oauth2 settings
  ownerKey: { type: String, required: true }, // id of the request / folder / collection: the token is stored under it
})
const o = computed(() => props.auth.oauth2)
const isCode = computed(() => o.value.grantType !== 'client_credentials')
const CLIENT_AUTH = [
  { value: 'basic', label: 'Basic Auth header' },
  { value: 'body', label: 'In the request body' },
]
const callbackUrl = defaultRedirectUri()
const advanced = ref(false)

// ---- token -------------------------------------------------------------------------
const now = ref(Date.now())
const clock = setInterval(() => (now.value = Date.now()), 15_000)
onBeforeUnmount(() => clearInterval(clock))
const token = computed(() => state.oauthTokens[props.ownerKey] || null)
const expiry = computed(() => {
  const t = token.value
  if (!t?.expiresAt) return { text: 'no expiry given', expired: false }
  const s = Math.round((t.expiresAt - now.value) / 1000)
  if (s <= 0) return { text: `expired ${fmt(-s)} ago`, expired: true }
  return { text: `expires in ${fmt(s)}`, expired: false }
})
function fmt(s) {
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)} min`
  if (s < 172800) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86400)} days`
}
const masked = (t) => (t.length > 14 ? `${t.slice(0, 8)}…${t.slice(-4)}` : t)

const busy = ref('')
const error = ref('')
const pending = computed(() => state.oauthPending?.key === props.ownerKey)
const pasted = ref('')

async function run(kind, fn) {
  busy.value = kind
  error.value = ''
  try {
    await fn()
    toast(kind === 'refresh' ? 'Access token refreshed' : 'Access token received', 'success', 2000)
  } catch (e) {
    if (e.message !== 'Sign-in cancelled.') error.value = e.message
  } finally {
    busy.value = ''
  }
}
const getToken = () => run('get', () => getNewOAuthToken(props.auth, props.ownerKey))
const refresh = () => run('refresh', () => refreshOAuthToken(props.auth, props.ownerKey))
function submitPasted() {
  if (pasted.value.trim()) completeOAuthRedirect(pasted.value)
  pasted.value = ''
}
async function copyCallback() {
  await copyText(callbackUrl)
  toast('Callback URL copied', 'success', 1500)
}
async function copyToken() {
  await copyText(token.value.accessToken)
  toast('Access token copied', 'success', 1500)
}
</script>

<template>
  <div class="space-y-3">
    <div class="grid gap-3 sm:grid-cols-2">
      <div>
        <label class="mb-1 block text-xs text-zinc-500">Grant type</label>
        <UiSelect v-model="o.grantType" :options="OAUTH_GRANTS" class="w-full" button-class="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm" />
      </div>
      <label v-if="isCode" class="mt-5 inline-flex items-center gap-2 text-sm text-zinc-300">
        <input v-model="o.pkce" type="checkbox" class="accent-orange-500" /> Use PKCE
        <span class="text-xs text-zinc-500">(recommended)</span>
      </label>
    </div>

    <template v-if="isCode">
      <label class="block text-xs text-zinc-500">Auth URL</label>
      <VarInput v-model="o.authUrl" placeholder="https://auth.example.com/oauth/authorize" class="field" />
    </template>
    <label class="block text-xs text-zinc-500">Access Token URL</label>
    <VarInput v-model="o.tokenUrl" placeholder="https://auth.example.com/oauth/token" class="field" />
    <div class="grid gap-3 sm:grid-cols-2">
      <div>
        <label class="mb-1 block text-xs text-zinc-500">Client ID</label>
        <VarInput v-model="o.clientId" class="field" />
      </div>
      <div>
        <label class="mb-1 block text-xs text-zinc-500">Client Secret <span class="text-zinc-600">{{ isCode && o.pkce ? '(optional with PKCE)' : '' }}</span></label>
        <VarInput v-model="o.clientSecret" class="field" masked />
      </div>
    </div>
    <label class="block text-xs text-zinc-500">Scope <span class="text-zinc-600">(space-separated)</span></label>
    <VarInput v-model="o.scope" placeholder="read write" class="field" />

    <p v-if="isCode" class="flex flex-wrap items-center gap-1 text-xs text-zinc-500">
      Register this callback URL with your provider:
      <code class="text-zinc-300">{{ o.redirectUri || callbackUrl }}</code>
      <button v-if="!o.redirectUri" class="rounded p-0.5 hover:bg-zinc-800 hover:text-zinc-100" title="Copy" @click="copyCallback"><Copy :size="12" /></button>
    </p>

    <button class="text-xs text-zinc-400 hover:text-zinc-100" @click="advanced = !advanced">{{ advanced ? '▾' : '▸' }} Advanced</button>
    <div v-if="advanced" class="space-y-3 border-l border-zinc-800 pl-3">
      <template v-if="isCode">
        <label class="block text-xs text-zinc-500">Callback URL <span class="text-zinc-600">(empty: {{ callbackUrl }}; with another URL, paste where you land after sign-in)</span></label>
        <VarInput v-model="o.redirectUri" :placeholder="callbackUrl" class="field" />
      </template>
      <label class="block text-xs text-zinc-500">Audience <span class="text-zinc-600">(optional, e.g. Auth0)</span></label>
      <VarInput v-model="o.audience" class="field" />
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="mb-1 block text-xs text-zinc-500">Send client credentials</label>
          <UiSelect v-model="o.clientAuth" :options="CLIENT_AUTH" class="w-full" button-class="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label class="mb-1 block text-xs text-zinc-500">Header prefix</label>
          <input v-model="o.headerPrefix" class="field w-full font-mono text-[13px] outline-none" placeholder="Bearer" />
        </div>
      </div>
      <label class="inline-flex items-center gap-2 text-sm text-zinc-300">
        <input v-model="o.autoRefresh" type="checkbox" class="accent-orange-500" /> Refresh the token automatically when it expires
      </label>
    </div>

    <!-- Current token -->
    <div class="rounded border border-zinc-800 bg-zinc-900/60 p-3">
      <div class="flex flex-wrap items-center gap-2">
        <KeyRound :size="14" class="text-zinc-500" />
        <template v-if="token">
          <button class="font-mono text-[13px] text-zinc-200 hover:text-orange-400" title="Copy the access token" @click="copyToken">{{ masked(token.accessToken) }}</button>
          <span class="text-xs" :class="expiry.expired ? 'text-amber-400' : 'text-zinc-500'">{{ expiry.text }}</span>
          <span v-if="token.refreshToken" class="text-xs text-zinc-500">· refresh token</span>
        </template>
        <span v-else class="text-xs text-zinc-500">No access token yet.</span>
        <span class="ml-auto flex gap-1">
          <button v-if="token?.refreshToken" class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" :disabled="!!busy" @click="refresh">
            <RefreshCw :size="12" :class="{ 'animate-spin': busy === 'refresh' }" /> Refresh
          </button>
          <button v-if="token" class="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-400" title="Forget this token" @click="clearOAuthToken(ownerKey)"><Trash2 :size="13" /></button>
        </span>
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <button class="inline-flex items-center gap-1.5 rounded bg-orange-500 px-3 py-1.5 text-xs font-semibold text-on-accent hover:bg-orange-600 disabled:opacity-50" :disabled="!!busy" @click="getToken">
          <Loader2 v-if="busy === 'get'" :size="13" class="animate-spin" /> Get new access token
        </button>
        <button v-if="pending" class="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800" @click="cancelOAuth">Cancel</button>
        <span v-if="pending" class="text-xs text-zinc-500">Finish signing in in the popup window…</span>
      </div>
      <form v-if="pending" class="mt-2 flex gap-2" @submit.prevent="submitPasted">
        <input v-model="pasted" class="field min-w-0 flex-1 font-mono text-xs outline-none" placeholder="Or paste the full URL you were redirected to" />
        <button class="rounded bg-zinc-800 px-3 text-xs hover:bg-zinc-700">Use</button>
      </form>
      <p v-if="error" class="mt-2 text-xs text-red-400">{{ error }}</p>
      <p class="mt-2 text-xs text-zinc-600">
        The token is requested through the current send mode (Direct, Proxy or Agent) and kept in this browser only; it is never synced or published.
        {{ o.grantType === 'client_credentials' ? 'Requests fetch one automatically when needed.' : '' }}
      </p>
    </div>
  </div>
</template>
