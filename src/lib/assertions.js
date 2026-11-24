// Response tests without scripts: "status equals 200", "JSON data.id exists", "time below 500".
// A test is { id, enabled, source, property, op, expected }; runTests() checks them against a
// response from sendRequest().
import { uid } from './model.js'
import { getByPath } from './variables.js'

export const TEST_SOURCES = [
  { value: 'status', label: 'Status code' },
  { value: 'json', label: 'JSON body', property: 'JSON path, e.g. data.items[0].id (empty: whole body)' },
  { value: 'header', label: 'Header', property: 'Header name, e.g. Content-Type' },
  { value: 'time', label: 'Response time (ms)' },
  { value: 'body', label: 'Body text' },
]

export const TEST_OPS = [
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'does not equal' },
  { value: 'lt', label: 'is less than' },
  { value: 'lte', label: 'is at most' },
  { value: 'gt', label: 'is greater than' },
  { value: 'gte', label: 'is at least' },
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'matches', label: 'matches regex' },
  { value: 'exists', label: 'exists', noValue: true },
  { value: 'not_exists', label: 'does not exist', noValue: true },
  { value: 'type', label: 'is of type' }, // string | number | boolean | object | array | null
]
const OP = Object.fromEntries(TEST_OPS.map((o) => [o.value, o]))
const SOURCE = Object.fromEntries(TEST_SOURCES.map((s) => [s.value, s]))
export const opTakesValue = (op) => !OP[op]?.noValue
export const sourceHasProperty = (source) => !!SOURCE[source]?.property

export function newTest(patch = {}) {
  return { id: uid(), enabled: true, source: 'status', property: '', op: 'eq', expected: '200', ...patch }
}

/** "Status code equals 200", "JSON data.id exists" */
export function describeTest(t) {
  const src = t.source === 'json' ? `JSON ${t.property || 'body'}` : t.source === 'header' ? `Header ${t.property}` : SOURCE[t.source]?.label || t.source
  return `${src} ${OP[t.op]?.label || t.op}${opTakesValue(t.op) ? ` ${t.expected}` : ''}`
}

/** { found, value } of the part of the response a test looks at. */
export function actualValue(t, res) {
  switch (t.source) {
    case 'status':
      return { found: true, value: res.status }
    case 'time':
      return { found: true, value: res.time }
    case 'body':
      return { found: true, value: res.body ?? '' }
    case 'header': {
      const name = (t.property || '').trim().toLowerCase()
      const h = (res.headers || []).find((x) => x.key.toLowerCase() === name)
      return { found: !!h, value: h?.value }
    }
    case 'json': {
      // NDJSON / JSON Lines: the parsed lines as an array, e.g. [0].id or length
      const doc = res.json !== undefined ? res.json : res.lines
      if (doc === undefined) return { found: false, value: undefined, notJson: true }
      const v = t.property?.trim() ? getByPath(doc, t.property) : doc
      return { found: v !== undefined, value: v }
    }
    default:
      return { found: false, value: undefined }
  }
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
const show = (v) => {
  if (v === undefined) return 'nothing'
  const s = JSON.stringify(v) ?? String(v)
  return s.length > 120 ? s.slice(0, 120) + '…' : s
}

/** Expected text as a value of the same kind as `actual` where that makes sense. */
function parseExpected(expected, actual) {
  const e = String(expected ?? '')
  if (typeof actual === 'string') return e
  if (typeof actual === 'number') return e.trim() === '' ? NaN : Number(e)
  try {
    return JSON.parse(e)
  } catch {
    return e
  }
}

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => deepEqual(a[k], b[k]))
}

function toRegExp(src) {
  const m = /^\/(.*)\/([dgimsuy]*)$/s.exec(src)
  return m ? new RegExp(m[1], m[2]) : new RegExp(src)
}

/** @returns {{ ok: boolean, message: string }} */
export function checkTest(t, res, expected = t.expected) {
  const a = actualValue(t, res)
  if (a.notJson) return { ok: t.op === 'not_exists', message: 'Response is not JSON' }
  const v = a.value
  if (t.op === 'exists') return { ok: a.found, message: a.found ? `found ${show(v)}` : 'not found' }
  if (t.op === 'not_exists') return { ok: !a.found, message: a.found ? `found ${show(v)}` : 'not found' }
  if (!a.found) return { ok: false, message: t.source === 'header' ? `no "${t.property}" header` : `"${t.property}" not found` }

  const e = parseExpected(expected, v)
  switch (t.op) {
    case 'eq':
    case 'neq': {
      const same = typeof v === 'object' && v !== null ? deepEqual(v, e) : typeof v === 'number' ? v === e : String(v) === String(e)
      return { ok: t.op === 'eq' ? same : !same, message: `got ${show(v)}` }
    }
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const n = Number(v)
      const m = Number(expected)
      if (typeof v === 'boolean' || v === null || v === '' || Number.isNaN(n)) return { ok: false, message: `got ${show(v)}, not a number` }
      if (String(expected).trim() === '' || Number.isNaN(m)) return { ok: false, message: `"${expected}" is not a number` }
      const ok = { lt: n < m, lte: n <= m, gt: n > m, gte: n >= m }[t.op]
      return { ok, message: `got ${show(v)}` }
    }
    case 'contains':
    case 'not_contains': {
      let has
      if (Array.isArray(v)) has = v.some((x) => (typeof x === 'object' && x !== null ? deepEqual(x, parseExpected(expected, x)) : String(x) === String(expected)))
      else if (typeof v === 'object' && v !== null) has = Object.prototype.hasOwnProperty.call(v, String(expected)) || JSON.stringify(v).includes(String(expected))
      else has = String(v).includes(String(expected))
      return { ok: t.op === 'contains' ? has : !has, message: `got ${show(v)}` }
    }
    case 'matches': {
      let re
      try {
        re = toRegExp(String(expected))
      } catch (err) {
        return { ok: false, message: `invalid regex: ${err.message}` }
      }
      return { ok: re.test(typeof v === 'string' ? v : JSON.stringify(v)), message: `got ${show(v)}` }
    }
    case 'type': {
      const want = String(expected).trim().toLowerCase()
      return { ok: typeOf(v) === want, message: `got ${typeOf(v)}` }
    }
    default:
      return { ok: false, message: `unknown check "${t.op}"` }
  }
}

/**
 * Run the enabled tests of a request.
 * @param resolve turns {{variables}} in expected values into their values
 * @returns {{ id, name, ok, message }[]}
 */
export function runTests(tests, res, resolve = (s) => s) {
  return (tests || [])
    .filter((t) => t.enabled !== false && t.source && (!sourceHasProperty(t.source) || t.source === 'json' || t.property?.trim()))
    .map((t) => {
      const expected = resolve(t.expected ?? '')
      const r = checkTest(t, res, expected)
      return { id: t.id, name: describeTest({ ...t, expected }), ...r }
    })
}

export const summarize = (results = []) => ({ passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, total: results.length })
