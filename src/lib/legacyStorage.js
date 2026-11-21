// Copy per-browser settings saved under an earlier app name ("beacon.*", "echo.*") to the
// current "curlion.*" keys, once. Imported first in main.js, before anything reads them.
const OLD_PREFIXES = ['beacon.', 'echo.'] // newest first
const NEW_PREFIX = 'curlion.'
const KEYS = ['theme', 'sidebarWidth', 'split', 'snippetLang']

try {
  for (const k of KEYS) {
    if (localStorage.getItem(NEW_PREFIX + k) !== null) continue
    for (const prefix of OLD_PREFIXES) {
      const old = localStorage.getItem(prefix + k)
      if (old !== null) {
        localStorage.setItem(NEW_PREFIX + k, old)
        break
      }
    }
  }
} catch {
  // storage unavailable (private mode etc.): defaults are used
}
