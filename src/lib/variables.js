// {{variable}} interpolation, dynamic built-in variables and JSON path lookup.
import { uid } from './model.js'

export const VAR_RE = /\{\{\s*([^{}\s]+)\s*\}\}/g

const FIRST = ['alex', 'budi', 'citra', 'dewi', 'eka', 'fajar', 'gita', 'hana', 'indra', 'joko']
const DOMAINS = ['example.com', 'mail.test', 'demo.dev']
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

export const DYNAMIC_VARS = {
  $uuid: () => uid(),
  $guid: () => uid(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1000) + 1),
  $randomEmail: () => `${pick(FIRST)}.${Math.random().toString(36).slice(2, 7)}@${pick(DOMAINS)}`,
}

export const DYNAMIC_DESCRIPTIONS = {
  $uuid: 'Random UUID v4',
  $guid: 'Random UUID v4',
  $timestamp: 'Current Unix timestamp (seconds)',
  $isoTimestamp: 'Current time, ISO 8601',
  $randomInt: 'Random integer 1-1000',
  $randomEmail: 'Random email address',
}

/**
 * Build the lookup used for interpolation from the global env and the active env.
 * Active env overrides global. Only enabled variables are included.
 *
 * Environments are shared with the team; `v.value` is the shared *initial value*.
 * `current` holds this user's *current values* ({ [envId]: { [varId]: value } }), kept in
 * this browser only. A non-empty current value wins over the initial value.
 * Returns Map<key, { value, isSecret, source, isCurrent, envId, varId }>
 */
export function buildScope(globalEnv, activeEnv, current = {}) {
  const scope = new Map()
  for (const env of [globalEnv, activeEnv]) {
    if (!env) continue
    for (const v of env.variables) {
      if (v.enabled !== false && v.key) {
        const cur = current[env.id]?.[v.id]
        const isCurrent = cur !== undefined && cur !== ''
        scope.set(v.key, { value: isCurrent ? cur : (v.value ?? ''), isSecret: !!v.isSecret, source: env.name, isCurrent, envId: env.id, varId: v.id })
      }
    }
  }
  return scope
}

export function isDefined(name, scope) {
  return name in DYNAMIC_VARS || scope.has(name)
}

/**
 * Replace {{vars}} in a string.
 * opts.maskSecrets: keep secret variables as {{name}} instead of their real value.
 * opts.keepDynamic: keep {{$uuid}} etc. as-is (used for docs).
 * Unknown variables are left as-is (like Postman).
 */
export function interpolate(str, scope, opts = {}) {
  if (typeof str !== 'string' || !str.includes('{{')) return str
  return str.replace(VAR_RE, (match, name) => {
    if (name in DYNAMIC_VARS) return opts.keepDynamic ? match : DYNAMIC_VARS[name]()
    const v = scope.get(name)
    if (!v) return match
    if (opts.maskSecrets && v.isSecret) return `{{${name}}}`
    return v.value
  })
}

/**
 * Read a value from a JSON object using a simple path:
 *   data.access_token, data.items[0].id, $.data.token, ['weird key'].x
 */
export function getByPath(obj, path) {
  if (!path) return undefined
  let p = path.trim().replace(/^\$\.?/, '')
  const tokens = []
  const re = /([^.[\]]+)|\[(\d+)\]|\[['"](.+?)['"]\]/g
  let m
  while ((m = re.exec(p))) tokens.push(m[1] ?? (m[2] !== undefined ? Number(m[2]) : m[3]))
  let cur = obj
  for (const t of tokens) {
    if (cur == null) return undefined
    cur = cur[t]
  }
  return cur
}
