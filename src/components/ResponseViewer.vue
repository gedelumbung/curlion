<script setup>
import { computed, ref } from 'vue'
import { AlertTriangle, Check, Copy, FileDown, Save, WrapText } from 'lucide-vue-next'
import CodeEditor from './CodeEditor.vue'
import JsonTree from './JsonTree.vue'
import { activeError, activeLoading, activeRequest, activeResponse, addSampleNow, state, toast } from '../store.js'
import { kv, newSample } from '../lib/model.js'
import { copyText, formatSize, statusColor } from '../lib/ui.js'

const res = activeResponse
const tab = ref('body')
const view = ref('pretty') // pretty | tree | raw
const wrap = ref(false)

const lang = computed(() => {
  const ct = res.value?.contentType || ''
  if (res.value?.json !== undefined) return 'json'
  return /xml/.test(ct) ? 'xml' : /html/.test(ct) ? 'html' : 'text'
})
const pretty = computed(() => {
  if (!res.value) return ''
  if (res.value.json !== undefined) return JSON.stringify(res.value.json, null, 2)
  return res.value.body
})

const wrapVar = (name) => '{' + '{' + name + '}' + '}'

async function copyBody() {
  await copyText(view.value === 'raw' ? res.value.body : pretty.value)
  toast('Response copied', 'success', 1500)
}

function saveAsSample() {
  const r = res.value
  const s = newSample(`${r.status} ${r.statusText || 'Response'}`.trim(), {
    status: r.status,
    headers: r.headers.filter((h) => /^(content-type|cache-control|location|x-)/i.test(h.key)).map((h) => kv(h.key, h.value)),
    body: pretty.value,
  })
  addSampleNow(activeRequest.value.id, s)
  toast('Saved as sample. See the "Samples / Mock" tab.', 'success')
}
</script>

<template>
  <section class="flex min-h-0 flex-col border-t border-zinc-800">
    <!-- Status line -->
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-sm">
      <span class="font-medium text-zinc-300">Response</span>
      <template v-if="res">
        <nav class="flex gap-1 text-xs">
          <button v-for="t in ['body', 'headers']" :key="t" class="rounded px-2 py-1 capitalize" :class="tab === t ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'" @click="tab = t">
            {{ t }}<span v-if="t === 'headers'" class="ml-1 text-zinc-500">{{ res.headers.length }}</span>
          </button>
        </nav>
        <span class="ml-auto font-mono text-xs" :class="statusColor(res.status)">{{ res.status }} {{ res.statusText }}</span>
        <span class="font-mono text-xs text-zinc-400">{{ res.time }} ms</span>
        <span class="font-mono text-xs text-zinc-400">{{ formatSize(res.size) }}</span>
        <button class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Save as Sample / Mock" @click="saveAsSample">
          <Save :size="13" /> Save as Sample
        </button>
      </template>
    </div>

    <!-- Extract results -->
    <div v-if="res?.extracted?.length" class="flex flex-wrap gap-2 px-4 pb-2 text-xs">
      <span v-for="x in res.extracted" :key="x.variable" class="inline-flex items-center gap-1 rounded px-2 py-0.5" :class="x.ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'">
        <Check v-if="x.ok" :size="12" /><AlertTriangle v-else :size="12" />
        {{ wrapVar(x.variable) }} {{ x.ok ? `set in ${x.env}` : x.message }}
      </span>
    </div>

    <div class="min-h-0 flex-1 overflow-auto">
      <div v-if="activeLoading" class="flex h-full items-center justify-center text-sm text-zinc-500">Sending request…</div>
      <div v-else-if="activeError" class="m-4 rounded border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
        <p class="font-medium">Could not get a response</p>
        <p class="mt-1 text-red-300/80">{{ activeError }}</p>
      </div>
      <div v-else-if="!res" class="flex h-full items-center justify-center p-6 text-center text-sm text-zinc-600">
        Click Send to get a response. Tip: paste a cURL command into the URL bar.
      </div>

      <template v-else-if="tab === 'body'">
        <div v-if="res.binary" class="flex flex-col items-center gap-3 p-6 text-sm text-zinc-400">
          <FileDown :size="32" class="text-orange-400" />
          <p>Binary response downloaded as <span class="font-mono text-zinc-200">{{ res.fileName }}</span></p>
          <p class="text-xs text-zinc-600">{{ res.contentType }}</p>
          <img v-if="res.previewUrl" :src="res.previewUrl" class="max-h-64 rounded border border-zinc-800" alt="Response preview" />
        </div>
        <div v-else class="flex h-full flex-col">
          <div class="flex items-center gap-1 px-4 pb-1 text-xs">
            <button v-for="v in ['pretty', 'tree', 'raw']" :key="v" class="rounded px-2 py-0.5 capitalize" :class="view === v ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'" :disabled="v === 'tree' && res.json === undefined" @click="view = v">
              {{ v }}
            </button>
            <button class="ml-auto rounded p-1 hover:bg-zinc-800" :class="wrap ? 'text-orange-400' : 'text-zinc-500'" title="Wrap lines" @click="wrap = !wrap"><WrapText :size="14" /></button>
            <button class="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100" title="Copy" @click="copyBody"><Copy :size="14" /></button>
          </div>
          <div v-if="view === 'tree' && res.json !== undefined" class="flex-1 overflow-auto px-4 pb-4">
            <JsonTree :value="res.json" />
          </div>
          <div v-else class="min-h-0 flex-1">
            <CodeEditor :model-value="view === 'raw' ? res.body : pretty" :language="view === 'raw' ? 'text' : lang" readonly :variables="false" :wrap="wrap || view === 'raw'" />
          </div>
        </div>
      </template>

      <table v-else class="w-full text-sm">
        <tbody>
          <tr v-for="(h, i) in res.headers" :key="i" class="border-t border-zinc-800">
            <td class="w-1/3 px-4 py-1.5 align-top font-mono text-[13px] text-zinc-400">{{ h.key }}</td>
            <td class="px-4 py-1.5 font-mono text-[13px] break-all text-zinc-200">{{ h.value }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
