<!-- Per-collection settings: publish docs, activity log. -->
<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { Copy, ExternalLink, Eye, History, Loader2, RefreshCw, Globe } from 'lucide-vue-next'
import Modal from './Modal.vue'
import {
  cloudEnabled,
  docsPreviewUrl,
  docsUrl,
  fetchActivity,
  getPublished,
  publishDocs,
  canEdit,
  roleOf,
  state,
  toast,
  touchCollection,
} from '../store.js'
import { ACTIONS, actionColor, ago, describeLog } from '../lib/activity.js'
import { SLUG_RE, slugify } from '../lib/publish.js'
import { copyText } from '../lib/ui.js'
import { unpublishDocs } from '../store.js'

const props = defineProps({
  collection: { type: Object, required: true },
  initialTab: { type: String, default: 'publish' },
})
const emit = defineEmits(['close'])
const tab = ref(props.initialTab)
const col = computed(() => props.collection)
const role = computed(() => roleOf(col.value))
const isOwner = computed(() => role.value === 'owner')
const online = computed(() => cloudEnabled && !!state.user)

const busy = ref(false)
const error = ref('')

// ---- Publish -------------------------------------------------------------
const published = ref(null) // { slug, published_at }
const slug = ref(col.value.publicSlug || slugify(col.value.name))
const slugValid = computed(() => SLUG_RE.test(slug.value))

async function loadPublished() {
  if (!online.value || !col.value.syncedAt) return
  try {
    published.value = await getPublished(col.value.id)
    if (published.value) slug.value = published.value.slug
  } catch (e) {
    error.value = e.message
  }
}

async function publish() {
  busy.value = true
  error.value = ''
  try {
    await publishDocs(col.value, slug.value)
    published.value = { slug: slug.value, published_at: new Date().toISOString() }
    toast('Docs published', 'success')
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

async function unpublish() {
  if (!confirm('Unpublish? The docs link will stop working.')) return
  busy.value = true
  try {
    await unpublishDocs(col.value)
    published.value = null
    toast('Docs are private again', 'success')
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

async function copyLink() {
  await copyText(docsUrl(published.value.slug))
  toast('Link copied', 'success', 1500)
}

// ---- Activity ------------------------------------------------------------
const logs = ref([])
const logsLoading = ref(false)

async function loadActivity() {
  if (!online.value || !col.value.syncedAt) return
  logsLoading.value = true
  error.value = ''
  try {
    logs.value = await fetchActivity(col.value.id)
  } catch (e) {
    error.value = e.message
  } finally {
    logsLoading.value = false
  }
}

// ---- load per tab ----------------------------------------------------------
const loaders = { publish: loadPublished, activity: loadActivity }
onMounted(() => loaders[tab.value]?.())
watch(tab, (t) => {
  error.value = ''
  loaders[t]?.()
})

const tabs = [
  { id: 'publish', label: 'Publish Docs', icon: Globe },
  { id: 'activity', label: 'Activity Log', icon: History },
]
</script>

<template>
  <Modal :title="col.name" width="max-w-3xl" @close="emit('close')">
    <nav class="flex gap-1 border-b border-zinc-800 px-3 text-sm">
      <button v-for="t in tabs" :key="t.id" class="relative inline-flex items-center gap-1.5 px-3 py-2" :class="tab === t.id ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'" @click="tab = t.id">
        <component :is="t.icon" :size="14" /> {{ t.label }}
        <span v-if="tab === t.id" class="absolute inset-x-2 -bottom-px h-0.5 rounded bg-orange-500"></span>
      </button>
    </nav>

    <div class="min-h-80 p-4 text-sm">
      <!-- Not signed in -->
      <div v-if="!online && tab !== 'publish'" class="rounded border border-zinc-800 bg-zinc-900/60 p-4 text-zinc-400">
        <template v-if="!cloudEnabled">The activity log needs Supabase configured (see README). This workspace is local only.</template>
        <template v-else>Sign in to see this collection's activity.</template>
      </div>

      <!-- Publish -->
      <template v-else-if="tab === 'publish'">
        <label class="mb-1 block text-xs text-zinc-500">Description (shown at the top of the docs page)</label>
        <textarea
          v-model="col.description"
          :disabled="!canEdit(col)"
          rows="3"
          class="mb-4 w-full rounded border border-zinc-700 bg-zinc-900 p-2 outline-none focus:border-zinc-500"
          placeholder="What this API does, base URLs, how to authenticate…"
          @input="touchCollection(col)"
        ></textarea>

        <div v-if="!online" class="mb-4 rounded border border-zinc-800 bg-zinc-900/60 p-3 text-zinc-400">
          {{ cloudEnabled ? 'Sign in to publish docs.' : 'Publishing needs Supabase configured.' }} You can still preview the docs locally.
        </div>
        <template v-else-if="isOwner">
          <label class="mb-1 block text-xs text-zinc-500">Docs address <span class="text-zinc-600">(readable by any signed-in Curlion user)</span></label>
          <div class="flex items-center rounded border border-zinc-700 bg-zinc-900 focus-within:border-zinc-500" :class="{ 'border-red-700': !slugValid }">
            <span class="pl-3 text-zinc-500">{{ docsUrl('') }}</span>
            <input v-model="slug" class="min-w-0 flex-1 bg-transparent py-1.5 pr-3 font-mono outline-none" @input="slug = slug.toLowerCase()" />
          </div>
          <p v-if="!slugValid" class="mt-1 text-xs text-red-400">3–64 characters: lowercase letters, numbers and dashes.</p>

          <div class="mt-4 flex flex-wrap items-center gap-2">
            <button :disabled="busy || !slugValid" class="inline-flex items-center gap-1.5 rounded bg-orange-500 px-4 py-1.5 font-medium text-on-accent hover:bg-orange-600 disabled:opacity-50" @click="publish">
              <Loader2 v-if="busy" :size="14" class="animate-spin" />
              {{ published ? 'Update published docs' : 'Publish docs' }}
            </button>
            <template v-if="published">
              <button class="inline-flex items-center gap-1 rounded bg-zinc-800 px-3 py-1.5 hover:bg-zinc-700" @click="copyLink"><Copy :size="13" /> Copy link</button>
              <a :href="docsUrl(published.slug)" target="_blank" class="inline-flex items-center gap-1 rounded bg-zinc-800 px-3 py-1.5 hover:bg-zinc-700"><ExternalLink :size="13" /> Open</a>
              <button class="ml-auto rounded px-3 py-1.5 text-red-400 hover:bg-red-950/40" @click="unpublish">Unpublish</button>
            </template>
          </div>
          <p v-if="published" class="mt-3 text-xs text-emerald-400">Published {{ ago(published.published_at) }}. Edits are not live: press "Update published docs" to publish changes.</p>
        </template>
        <p v-else class="text-zinc-400">Only the person who created this collection can publish its docs.</p>

        <a :href="docsPreviewUrl(col.id)" target="_blank" class="mt-4 inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-100"><Eye :size="13" /> Preview docs (local, not shared)</a>
        <p class="mt-4 text-xs text-zinc-600">
          Published docs are a snapshot. Literal tokens, passwords and API keys in auth and sensitive headers are replaced with placeholders.
          <span v-pre>{{variables}}</span> are shown by name; environment values are never published.
        </p>
      </template>

      <!-- Activity -->
      <template v-else-if="tab === 'activity'">
        <div class="mb-3 flex items-center justify-between text-xs text-zinc-500">
          <span>Changes are grouped per person, about once a minute, after they sync.</span>
          <button class="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-zinc-800 hover:text-zinc-100" @click="loadActivity"><RefreshCw :size="13" :class="{ 'animate-spin': logsLoading }" /> Refresh</button>
        </div>
        <p v-if="!col.syncedAt" class="py-8 text-center text-zinc-500">This collection has not synced yet.</p>
        <p v-else-if="!logsLoading && !logs.length" class="py-8 text-center text-zinc-500">No activity yet.</p>
        <ol v-else class="space-y-2">
          <li v-for="log in logs" :key="log.id" class="rounded border border-zinc-800 px-3 py-2">
            <div class="flex flex-wrap items-center gap-2">
              <span class="rounded px-1.5 py-0.5 text-[11px] font-medium" :class="actionColor(log.action)">{{ ACTIONS[log.action] || log.action }}</span>
              <span class="font-medium text-zinc-200">{{ log.target_name }}</span>
              <span class="ml-auto text-xs text-zinc-500" :title="new Date(log.created_at).toLocaleString()">{{ ago(log.created_at) }}</span>
            </div>
            <p v-if="describeLog(log)" class="mt-1 font-mono text-xs break-all text-zinc-400">{{ describeLog(log) }}</p>
            <p class="mt-0.5 text-xs text-zinc-600">by {{ log.actor_email || 'deleted user' }}</p>
          </li>
        </ol>
      </template>

      <p v-if="error" class="mt-4 rounded border border-red-900 bg-red-950/40 p-3 text-red-300">{{ error }}</p>
    </div>
  </Modal>
</template>
