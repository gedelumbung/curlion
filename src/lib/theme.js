// Theme = palette (Ayu, Monokai, Dracula, Tokyo Night) × mode (dark / light).
// The whole UI is built on Tailwind's zinc/orange/... tokens, which style.css remaps per
// [data-palette][data-theme], so switching only flips these two attributes.
import { ref, watch } from 'vue'

const KEY = 'curlion.theme'
const PALETTE_KEY = 'curlion.palette'

/** Theme cards in Settings. `swatch` = [background, foreground, accent, hue, hue, hue]. */
export const PALETTES = [
  {
    id: 'ayu',
    dark: { label: 'Ayu Dark', swatch: ['#0d1017', '#bfbdb6', '#e6b450', '#aad94c', '#59c2ff', '#d2a6ff'] },
    light: { label: 'Ayu Light', swatch: ['#fcfcfc', '#5c6166', '#ffaa33', '#86b300', '#399ee6', '#a37acc'] },
  },
  {
    id: 'monokai',
    dark: { label: 'Monokai', swatch: ['#272822', '#f8f8f2', '#fd971f', '#a6e22e', '#66d9ef', '#f92672'] },
    light: { label: 'Monokai Light', swatch: ['#faf4f2', '#29242a', '#e16032', '#269d69', '#1c8ca8', '#e14775'] },
  },
  {
    id: 'dracula',
    dark: { label: 'Dracula', swatch: ['#282a36', '#f8f8f2', '#bd93f9', '#50fa7b', '#8be9fd', '#ff79c6'] },
    light: { label: 'Alucard', swatch: ['#fffbeb', '#1f1f1f', '#644ac9', '#14710a', '#036a96', '#a3144d'] },
  },
  {
    id: 'tokyo',
    dark: { label: 'Tokyo Night', swatch: ['#1a1b26', '#c0caf5', '#7aa2f7', '#9ece6a', '#7dcfff', '#bb9af7'] },
    light: { label: 'Tokyo Day', swatch: ['#e1e2e7', '#3760bf', '#2e7de9', '#587539', '#007197', '#9854f1'] },
  },
]

function read(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function initialMode() {
  const saved = read(KEY)
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}
function initialPalette() {
  const saved = read(PALETTE_KEY)
  return PALETTES.some((p) => p.id === saved) ? saved : 'ayu'
}

/** 'dark' | 'light' */
export const theme = ref(initialMode())
/** 'ayu' | 'monokai' | 'dracula' | 'tokyo' */
export const palette = ref(initialPalette())

function apply() {
  document.documentElement.dataset.theme = theme.value
  document.documentElement.dataset.palette = palette.value
}
apply()

watch([theme, palette], ([t, p]) => {
  apply()
  try {
    localStorage.setItem(KEY, t)
    localStorage.setItem(PALETTE_KEY, p)
  } catch {}
})

export function setDark(on) {
  theme.value = on ? 'dark' : 'light'
}

export function setTheme(paletteId, mode) {
  palette.value = paletteId
  theme.value = mode
}

/** Display name of a palette in a mode, e.g. "Dracula" / "Alucard". */
export function themeLabel(mode = theme.value, paletteId = palette.value) {
  return PALETTES.find((p) => p.id === paletteId)?.[mode].label || ''
}
