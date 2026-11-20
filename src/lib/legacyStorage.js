// Copy per-browser settings saved under an earlier app name ("echo.*") to the
// current "beacon.*" keys, once. Imported first in main.js, before anything reads them.
const OLD_PREFIX = 'echo.'
const NEW_PREFIX = 'beacon.'
const KEYS = ['theme', 'sidebarWidth', 'split', 'snippetLang']

try {
  for (const k of KEYS) {
    const old = localStorage.getItem(OLD_PREFIX + k)
    if (old !== null && localStorage.getItem(NEW_PREFIX + k) === null) localStorage.setItem(NEW_PREFIX + k, old)
  }
} catch {
  // storage unavailable (private mode etc.): defaults are used
}
