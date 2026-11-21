<!-- Settings: appearance and code editor options (stored per browser, applied live). -->
<script setup>
import { computed } from 'vue'
import { Minus, Plus, RotateCcw } from 'lucide-vue-next'
import Modal from './Modal.vue'
import UiSelect from './UiSelect.vue'
import CodeEditor from './CodeEditor.vue'
import { DEFAULTS, FONT_FAMILIES, indentString, resetSettings, settings } from '../lib/settings.js'
import { PALETTES, palette, setTheme, theme } from '../lib/theme.js'

const emit = defineEmits(['close'])

const fontOptions = FONT_FAMILIES.map((f) => ({ value: f.id, label: f.label }))
const clamp = (n, min, max) => Math.min(max, Math.max(min, n))
const bump = (key, delta, min, max) => (settings[key] = clamp(settings[key] + delta, min, max))

const sample = computed(() =>
  JSON.stringify({ id: 42, name: 'Curlion', tags: ['api', 'http'], active: true, owner: { email: 'dev@example.com' } }, null, indentString()),
)
const isDefault = computed(() => Object.entries(DEFAULTS).every(([k, v]) => settings[k] === v))
</script>

<template>
  <Modal title="Settings" width="max-w-lg" @close="emit('close')">
    <div class="px-5 pt-4 pb-5 text-sm">
      <!-- Appearance -->
      <section>
        <h3 class="settings-heading">Appearance</h3>
      </section>
      <div class="pt-1 pb-3">
        <span>Theme</span>
        <div v-for="mode in ['dark', 'light']" :key="mode" class="mt-2">
          <p class="mb-1.5 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">{{ mode }}</p>
          <div class="grid grid-cols-4 gap-2">
            <button
              v-for="p in PALETTES"
              :key="p.id + mode"
              class="theme-card"
              :class="{ on: palette === p.id && theme === mode }"
              :aria-pressed="palette === p.id && theme === mode"
              :title="p[mode].label"
              @click="setTheme(p.id, mode)"
            >
              <span class="theme-swatch" :style="{ background: p[mode].swatch[0], color: p[mode].swatch[1] }">
                <span class="theme-lines">
                  <i :style="{ background: p[mode].swatch[3] }"></i>
                  <i :style="{ background: p[mode].swatch[4], width: '70%' }"></i>
                  <i :style="{ background: p[mode].swatch[5], width: '45%' }"></i>
                </span>
                <span class="theme-accent" :style="{ background: p[mode].swatch[2] }"></span>
              </span>
              <span class="theme-name">{{ p[mode].label }}</span>
            </button>
          </div>
        </div>
      </div>
      <div class="settings-row">
        <span>Interface size</span>
        <div class="segmented">
          <button v-for="s in [90, 100, 110, 120]" :key="s" :class="{ on: settings.uiScale === s }" @click="settings.uiScale = s">{{ s }}%</button>
        </div>
      </div>

      <!-- Editor -->
      <section class="mt-5">
        <h3 class="settings-heading">Code editor</h3>
      </section>
      <div class="settings-row">
        <span>Font family</span>
        <UiSelect v-model="settings.fontFamily" :options="fontOptions" class="w-44" />
      </div>
      <div class="settings-row">
        <span>Font size</span>
        <div class="stepper">
          <button title="Smaller" @click="bump('editorFontSize', -1, 10, 22)"><Minus :size="13" /></button>
          <span class="tabular-nums">{{ settings.editorFontSize }}px</span>
          <button title="Larger" @click="bump('editorFontSize', 1, 10, 22)"><Plus :size="13" /></button>
        </div>
      </div>
      <div class="settings-row">
        <span>Font padding <span class="text-zinc-600">(per line)</span></span>
        <div class="flex items-center gap-2">
          <input v-model.number="settings.fontPadding" type="range" min="0" max="10" step="1" class="w-28 accent-orange-500" />
          <span class="w-8 text-right text-xs text-zinc-400 tabular-nums">{{ settings.fontPadding }}px</span>
        </div>
      </div>
      <div class="settings-row">
        <span>Auto close quotes &amp; brackets</span>
        <button
          role="switch"
          :aria-checked="settings.autoClose"
          class="relative h-5 w-9 shrink-0 rounded-full transition-colors"
          :class="settings.autoClose ? 'bg-orange-500' : 'bg-zinc-700'"
          @click="settings.autoClose = !settings.autoClose"
        >
          <span class="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-zinc-950 transition-transform" :class="{ 'translate-x-4': settings.autoClose }"></span>
        </button>
      </div>
      <div class="settings-row">
        <span>Indentation</span>
        <div class="segmented">
          <button :class="{ on: settings.indentType === 'spaces' }" @click="settings.indentType = 'spaces'">Spaces</button>
          <button :class="{ on: settings.indentType === 'tabs' }" @click="settings.indentType = 'tabs'">Tabs</button>
        </div>
      </div>
      <div class="settings-row">
        <span>Indent size</span>
        <div class="segmented">
          <button v-for="n in [2, 4, 8]" :key="n" :class="{ on: settings.indentSize === n }" @click="settings.indentSize = n">{{ n }}</button>
        </div>
      </div>

      <!-- Preview -->
      <section class="mt-5">
        <h3 class="settings-heading">Preview</h3>
        <div class="h-44 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
          <CodeEditor :model-value="sample" language="json" readonly :variables="false" />
        </div>
        <p class="mt-2 text-xs text-zinc-500">Saved in this browser. Indentation also applies to Beautify and pretty-printed responses.</p>
      </section>
    </div>
    <template #footer>
      <button class="mr-auto inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40" :disabled="isDefault" @click="resetSettings">
        <RotateCcw :size="13" /> Reset to defaults
      </button>
      <button class="rounded bg-orange-500 px-4 py-1.5 text-xs font-medium text-on-accent hover:bg-orange-600" @click="emit('close')">Done</button>
    </template>
  </Modal>
</template>

<style scoped>
.theme-card {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  border-radius: var(--radius-md);
  padding: 3px;
  border: 1px solid transparent;
  text-align: left;
}
.theme-card:hover {
  background: var(--color-zinc-800);
}
.theme-card.on {
  border-color: var(--color-orange-500);
  background: color-mix(in srgb, var(--color-orange-500) 8%, transparent);
}
.theme-swatch {
  position: relative;
  display: block;
  height: 2.6rem;
  border-radius: 3px;
  box-shadow: inset 0 0 0 1px rgb(127 127 127 / 0.25);
  overflow: hidden;
}
.theme-lines {
  position: absolute;
  inset: 0.45rem 0.5rem auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.theme-lines i {
  display: block;
  height: 4px;
  width: 85%;
  border-radius: 2px;
}
.theme-accent {
  position: absolute;
  right: 0.4rem;
  bottom: 0.35rem;
  width: 0.7rem;
  height: 0.7rem;
  border-radius: 50%;
}
.theme-name {
  overflow: hidden;
  padding: 0 2px;
  font-size: 11.5px;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--color-zinc-300);
}
.theme-card.on .theme-name {
  color: var(--color-zinc-100);
}
.settings-heading {
  margin-bottom: 0.25rem;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-zinc-500);
}
.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-height: 2.5rem;
  border-bottom: 1px solid var(--color-zinc-800);
  color: var(--color-zinc-300);
}
.segmented {
  display: inline-flex;
  padding: 2px;
  border-radius: var(--radius-md);
  background: var(--color-zinc-900);
  border: 1px solid var(--color-zinc-800);
}
.segmented button {
  padding: 3px 10px;
  border-radius: var(--radius);
  font-size: 12px;
  color: var(--color-zinc-500);
}
.segmented button:hover {
  color: var(--color-zinc-200);
}
.segmented button.on {
  background: var(--color-zinc-800);
  color: var(--color-zinc-100);
  box-shadow: inset 0 -2px 0 var(--color-orange-500);
}
.stepper {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 2px;
  border-radius: var(--radius-md);
  background: var(--color-zinc-900);
  border: 1px solid var(--color-zinc-800);
  font-size: 12px;
  color: var(--color-zinc-200);
}
.stepper button {
  padding: 3px 6px;
  border-radius: var(--radius);
  color: var(--color-zinc-400);
}
.stepper button:hover {
  background: var(--color-zinc-800);
  color: var(--color-zinc-100);
}
</style>
