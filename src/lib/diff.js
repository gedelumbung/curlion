// Comparing two responses: a line diff (Myers' O(ND) algorithm), a side-by-side layout with
// collapsed unchanged runs, and a structural JSON diff (which paths were added, removed or
// changed).

/**
 * Line diff.
 * @returns {{ ops: { type: 'equal'|'del'|'add', text, a?: number, b?: number }[], truncated: boolean }}
 *   a / b: 0-based line numbers in the old / new text. truncated: the texts were too different
 *   to diff in reasonable time, so everything is shown as removed + added.
 */
export function diffLines(oldText, newText, { maxEdits = 4000 } = {}) {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  // common prefix / suffix are cheap and usually most of a response
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const head = a.slice(0, start).map((text, i) => ({ type: 'equal', text, a: i, b: i }))
  const tail = a.slice(endA).map((text, i) => ({ type: 'equal', text, a: endA + i, b: endB + i }))
  const mid = myers(a.slice(start, endA), b.slice(start, endB), maxEdits)
  if (!mid) {
    const ops = [...head, ...a.slice(start, endA).map((text, i) => ({ type: 'del', text, a: start + i })), ...b.slice(start, endB).map((text, i) => ({ type: 'add', text, b: start + i })), ...tail]
    return { ops, truncated: true }
  }
  for (const op of mid) {
    if (op.a !== undefined) op.a += start
    if (op.b !== undefined) op.b += start
  }
  return { ops: [...head, ...mid, ...tail], truncated: false }
}

const splitLines = (t) => (t === '' || t == null ? [] : String(t).replace(/\r\n?/g, '\n').split('\n'))

/** Shortest edit script between two line arrays; null when it needs more than maxEdits edits. */
function myers(a, b, maxEdits) {
  const n = a.length
  const m = b.length
  if (!n) return b.map((text, j) => ({ type: 'add', text, b: j }))
  if (!m) return a.map((text, i) => ({ type: 'del', text, a: i }))
  const max = Math.min(n + m, maxEdits)
  const offset = max + 1
  let v = new Int32Array(2 * max + 3)
  const trace = []
  let found = -1
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
  }
  if (found < 0) return null
  // walk back through the saved V arrays
  const ops = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const prev = trace[d]
    const k = x - y
    const prevK = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]) ? k + 1 : k - 1
    const prevX = prev[offset + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) ops.push({ type: 'equal', text: a[--x], a: x, b: --y })
    if (x === prevX) ops.push({ type: 'add', text: b[--y], b: y })
    else ops.push({ type: 'del', text: a[--x], a: x })
  }
  while (x > 0 && y > 0) ops.push({ type: 'equal', text: a[--x], a: x, b: --y })
  return ops.reverse()
}

/** { added, removed } line counts. */
export const diffStats = (ops) => ({ added: ops.filter((o) => o.type === 'add').length, removed: ops.filter((o) => o.type === 'del').length })

/**
 * Rows for a side-by-side view: removed and added lines that follow each other are paired.
 * With `context` set, unchanged runs longer than 2 × context are collapsed into
 * { gap: count } rows.
 * @returns {({ left: {n,text,type}|null, right: {n,text,type}|null } | { gap: number })[]}
 */
export function sideBySide(ops, { context = null } = {}) {
  const rows = []
  for (let i = 0; i < ops.length; ) {
    const op = ops[i]
    if (op.type === 'equal') {
      rows.push({ left: { n: op.a + 1, text: op.text, type: 'equal' }, right: { n: op.b + 1, text: op.text, type: 'equal' } })
      i++
      continue
    }
    const dels = []
    const adds = []
    while (i < ops.length && ops[i].type !== 'equal') (ops[i].type === 'del' ? dels : adds).push(ops[i++])
    for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
      const d = dels[j]
      const a = adds[j]
      rows.push({ left: d ? { n: d.a + 1, text: d.text, type: 'del' } : null, right: a ? { n: a.b + 1, text: a.text, type: 'add' } : null })
    }
  }
  if (context === null) return rows
  const changed = rows.map((r) => r.left?.type !== 'equal' || r.right?.type !== 'equal')
  const keep = changed.map((c, i) => c || changed.slice(Math.max(0, i - context), i + context + 1).some(Boolean))
  const out = []
  for (let i = 0; i < rows.length; ) {
    if (keep[i]) {
      out.push(rows[i++])
      continue
    }
    let j = i
    while (j < rows.length && !keep[j]) j++
    out.push({ gap: j - i })
    i = j
  }
  return out
}

/**
 * Which parts of a line changed, for highlighting inside a paired removed / added line:
 * the common prefix and suffix are left plain.
 * @returns {{ pre, mid, post }}
 */
export function inlineChange(oldLine, newLine, side) {
  let p = 0
  while (p < oldLine.length && p < newLine.length && oldLine[p] === newLine[p]) p++
  let s = 0
  while (s < oldLine.length - p && s < newLine.length - p && oldLine[oldLine.length - 1 - s] === newLine[newLine.length - 1 - s]) s++
  const t = side === 'left' ? oldLine : newLine
  return { pre: t.slice(0, p), mid: t.slice(p, t.length - s), post: t.slice(t.length - s) }
}

// ---- JSON --------------------------------------------------------------------------------------

/** Copy of a JSON value with object keys sorted (so key order does not show up as a change). */
export function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeysDeep(v[k])]))
  return v
}

const IDENT = /^[A-Za-z_$][\w$]*$/
const child = (path, key) => (typeof key === 'number' ? `${path}[${key}]` : IDENT.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`)
const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

/**
 * Structural differences between two JSON values, as paths (`$.data.items[0].id`).
 * Arrays are compared by index.
 * @returns {{ path, type: 'added'|'removed'|'changed', from?, to? }[]}
 */
export function jsonChanges(a, b, { limit = 1000 } = {}) {
  const out = []
  const walk = (x, y, path) => {
    if (out.length >= limit) return
    const kx = kind(x)
    const ky = kind(y)
    if (kx === 'object' && ky === 'object') {
      for (const k of Object.keys(x)) {
        if (!(k in y)) out.push({ path: child(path, k), type: 'removed', from: x[k] })
        else walk(x[k], y[k], child(path, k))
      }
      for (const k of Object.keys(y)) if (!(k in x)) out.push({ path: child(path, k), type: 'added', to: y[k] })
    } else if (kx === 'array' && ky === 'array') {
      const n = Math.max(x.length, y.length)
      for (let i = 0; i < n; i++) {
        if (i >= y.length) out.push({ path: child(path, i), type: 'removed', from: x[i] })
        else if (i >= x.length) out.push({ path: child(path, i), type: 'added', to: y[i] })
        else walk(x[i], y[i], child(path, i))
      }
    } else if (kx !== ky || x !== y) {
      out.push({ path, type: 'changed', from: x, to: y })
    }
  }
  walk(a, b, '$')
  return out
}
