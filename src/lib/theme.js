// Light / dark theme. The whole UI is built on the zinc palette, which style.css
// remaps under [data-theme="light"], so switching only flips this attribute.
import { ref, watch } from 'vue'

const KEY = 'beacon.theme'

function initial() {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {}
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export const theme = ref(initial())

function apply(t) {
  document.documentElement.dataset.theme = t
}
apply(theme.value)

watch(theme, (t) => {
  apply(t)
  try {
    localStorage.setItem(KEY, t)
  } catch {}
})

export function setDark(on) {
  theme.value = on ? 'dark' : 'light'
}
