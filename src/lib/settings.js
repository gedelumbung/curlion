// Per-browser editor/appearance settings (Settings dialog). Applied through CSS variables
// (fonts, sizes, line padding) and CodeMirror compartments (indentation, auto-close).
import { reactive, watch } from 'vue'

const KEY = 'curlion.settings'

/** Code fonts. Web fonts are loaded from Google Fonts only when picked. */
export const FONT_FAMILIES = [
  { id: 'jetbrains', label: 'JetBrains Mono', css: "'JetBrains Mono'", google: 'JetBrains+Mono:wght@400;500;600' },
  { id: 'fira', label: 'Fira Code', css: "'Fira Code'", google: 'Fira+Code:wght@400;500;600' },
  { id: 'plex', label: 'IBM Plex Mono', css: "'IBM Plex Mono'", google: 'IBM+Plex+Mono:wght@400;500;600' },
  { id: 'source', label: 'Source Code Pro', css: "'Source Code Pro'", google: 'Source+Code+Pro:wght@400;500;600' },
  { id: 'roboto', label: 'Roboto Mono', css: "'Roboto Mono'", google: 'Roboto+Mono:wght@400;500;600' },
  { id: 'ubuntu', label: 'Ubuntu Mono', css: "'Ubuntu Mono'", google: 'Ubuntu+Mono:wght@400;700' },
  { id: 'system', label: 'System monospace', css: 'ui-monospace', google: null },
]

export const DEFAULTS = Object.freeze({
  uiScale: 100, // % of the default interface size
  editorFontSize: 13, // px
  fontFamily: 'jetbrains',
  fontPadding: 2, // px above and below each editor line
  indentType: 'spaces', // spaces | tabs
  indentSize: 2,
  autoClose: true, // auto-close quotes and brackets in code editors
})

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}')
    return Object.fromEntries(Object.entries(saved).filter(([k]) => k in DEFAULTS))
  } catch {
    return {}
  }
}

export const settings = reactive({ ...DEFAULTS, ...load() })

export function resetSettings() {
  Object.assign(settings, DEFAULTS)
}

/** The string one indentation level inserts (also used for JSON pretty-printing). */
export const indentString = () => (settings.indentType === 'tabs' ? '\t' : ' '.repeat(settings.indentSize))

const loadedFonts = new Set()
function loadFont(font) {
  if (!font?.google || loadedFonts.has(font.id) || typeof document === 'undefined') return
  loadedFonts.add(font.id)
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = `https://fonts.googleapis.com/css2?family=${font.google}&display=swap`
  document.head.appendChild(link)
}

function apply() {
  if (typeof document === 'undefined') return
  const font = FONT_FAMILIES.find((f) => f.id === settings.fontFamily) || FONT_FAMILIES[0]
  loadFont(font)
  const root = document.documentElement.style
  root.setProperty('--editor-font', font.css)
  root.setProperty('--editor-font-size', `${settings.editorFontSize}px`)
  root.setProperty('--editor-line-pad', `${settings.fontPadding}px`)
  // Tailwind sizes are rem-based, so the root font size scales the whole interface
  root.setProperty('font-size', `${(16 * settings.uiScale) / 100}px`)
}

apply()
watch(
  settings,
  () => {
    apply()
    try {
      localStorage.setItem(KEY, JSON.stringify(settings))
    } catch {}
  },
  { deep: true },
)
