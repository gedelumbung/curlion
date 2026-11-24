<!-- Auth settings of a request, folder or collection. -->
<script setup>
import { computed, watch } from 'vue'
import { ArrowUpRight } from 'lucide-vue-next'
import VarInput from './VarInput.vue'
import UiSelect from './UiSelect.vue'
import OAuth2Editor from './OAuth2Editor.vue'
import { AUTH_DEFAULTS, newAuth } from '../lib/model.js'
import { effectiveAuth } from '../lib/resolve.js'

const props = defineProps({
  holder: { type: Object, required: true }, // request, folder or collection (its .auth is edited)
  kind: { type: String, default: 'request' }, // request | folder | collection
  ancestors: { type: Array, default: () => [] }, // collection and folders above, for "inherit"
})
const emit = defineEmits(['edit-parent']) // (folder or collection the inherited auth comes from)

// Older folders / collections have no auth yet; a type's settings are added when it is picked
// (not on open, so viewing a request does not mark it as edited).
watch(
  () => [props.holder, props.holder.auth?.type],
  () => {
    const h = props.holder
    if (!h.auth) h.auth = newAuth(props.kind === 'collection' ? 'none' : 'inherit')
    const make = AUTH_DEFAULTS[h.auth.type]
    if (make && !h.auth[h.auth.type]) h.auth[h.auth.type] = make()
  },
  { immediate: true },
)
const auth = computed(() => props.holder.auth)

const TYPE_LABEL = { inherit: 'Inherit from parent', none: 'No Auth', bearer: 'Bearer Token', basic: 'Basic Auth', apikey: 'API Key', oauth2: 'OAuth 2.0' }
const types = computed(() => Object.entries(TYPE_LABEL).filter(([v]) => v !== 'inherit' || props.kind !== 'collection').map(([value, label]) => ({ value, label })))
const APIKEY_IN = [
  { value: 'header', label: 'Header' },
  { value: 'query', label: 'Query Params' },
]

const inherited = computed(() => (auth.value.type === 'inherit' ? effectiveAuth(null, props.ancestors) : null))
const noun = { request: 'request', folder: 'folder', collection: 'collection' }
</script>

<template>
  <div class="grid gap-4 md:grid-cols-[200px_1fr]">
    <div>
      <label class="mb-1 block text-xs text-zinc-500">Type</label>
      <UiSelect v-model="auth.type" :options="types" class="w-full" button-class="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm" />
    </div>
    <div class="space-y-3 text-sm">
      <template v-if="auth.type === 'inherit'">
        <p v-if="inherited.source" class="pt-5 text-zinc-400">
          Uses <span class="text-zinc-200">{{ TYPE_LABEL[inherited.auth.type] || inherited.auth.type }}</span> from
          <button class="inline-flex items-center gap-0.5 text-orange-400 hover:underline" @click="emit('edit-parent', inherited.source)">
            {{ inherited.source.name }} <ArrowUpRight :size="13" />
          </button>
        </p>
        <p v-else class="pt-5 text-zinc-500">
          No folder or collection above sets auth, so this {{ noun[kind] }} is sent without it.
          <button v-if="ancestors.length" class="text-orange-400 hover:underline" @click="emit('edit-parent', ancestors[0])">Set collection auth</button>
        </p>
      </template>
      <p v-if="auth.type === 'none'" class="pt-5 text-zinc-500">
        {{ kind === 'request' ? 'This request does not use any authorization.' : `Requests in this ${noun[kind]} that inherit auth are sent without it.` }}
      </p>
      <template v-if="auth.type === 'bearer'">
        <label class="block text-xs text-zinc-500">Token</label>
        <VarInput v-model="auth.bearer.token" placeholder="Token or a {{variable}}" class="field" />
      </template>
      <template v-if="auth.type === 'basic'">
        <label class="block text-xs text-zinc-500">Username</label>
        <VarInput v-model="auth.basic.username" class="field" />
        <label class="block text-xs text-zinc-500">Password</label>
        <VarInput v-model="auth.basic.password" class="field" masked />
      </template>
      <template v-if="auth.type === 'apikey'">
        <label class="block text-xs text-zinc-500">Key</label>
        <VarInput v-model="auth.apikey.key" placeholder="X-API-Key" class="field" />
        <label class="block text-xs text-zinc-500">Value</label>
        <VarInput v-model="auth.apikey.value" class="field" />
        <label class="block text-xs text-zinc-500">Add to</label>
        <UiSelect v-model="auth.apikey.in" :options="APIKEY_IN" class="w-36" />
      </template>
      <OAuth2Editor v-if="auth.type === 'oauth2' && auth.oauth2" :auth="auth" :owner-key="holder.id" />
      <p v-if="kind !== 'request' && !['inherit', 'none'].includes(auth.type)" class="text-xs text-zinc-600">
        Used by every request in this {{ noun[kind] }} whose auth is set to "Inherit from parent".
      </p>
    </div>
  </div>
</template>
