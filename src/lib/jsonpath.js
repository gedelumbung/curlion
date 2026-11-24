// JSONPath for filtering responses (RFC 9535 core plus common Goessner forms):
//   $  .name  ['name']  [0]  [-1]  [*]  .*  ..name  ..*  [a,b]  [start:end:step]
//   [?(@.price > 10 && @.tags)]  [?@.name =~ /^a/i]  [?(!@.deleted)]  [?(length(@.items) >= 2)]
// Comparisons: == != < <= > >= and =~ (regex). Paths inside filters start with @ (current
// item) or $ (root). `length` also works as a property of arrays and strings (@.items.length).
// A query without a leading $ is read as relative to the root ("data.items" = "$.data.items").

export class JsonPathError extends Error {}

// ---- parser ---------------------------------------------------------------------------------

/** @returns {{ segments, definite: boolean }} definite: selects at most one value (no wildcards, filters, slices, unions or ..) */
export function parseJsonPath(src) {
  const typed = String(src ?? '').trim()
  if (!typed) throw new JsonPathError('Empty query')
  const text = typed[0] === '$' ? typed : typed[0] === '[' || typed[0] === '.' ? `$${typed}` : `$.${typed}`
  const p = new Parser(text, text.length - typed.length) // error positions count what the user typed
  p.expect('$')
  const segments = p.segments()
  if (!p.done()) p.fail(`Unexpected "${p.rest().slice(0, 12)}"`)
  const definite = segments.every((s) => !s.descendant && s.selectors.length === 1 && ['name', 'index'].includes(s.selectors[0].type))
  return { segments, definite }
}

const NAME = /^[^\s.[\]()!=<>&|,'"@$~]+/

class Parser {
  constructor(s, offset = 0) {
    this.s = s
    this.i = 0
    this.offset = offset
  }
  done() {
    return this.i >= this.s.length
  }
  rest() {
    return this.s.slice(this.i)
  }
  peek(n = 0) {
    return this.s[this.i + n]
  }
  ws() {
    while (/\s/.test(this.s[this.i] || '')) this.i++
  }
  fail(msg) {
    throw new JsonPathError(`${msg} at position ${Math.max(1, this.i + 1 - this.offset)}`)
  }
  expect(str) {
    if (!this.s.startsWith(str, this.i)) this.fail(`Expected "${str}"`)
    this.i += str.length
  }
  eat(str) {
    if (this.s.startsWith(str, this.i)) {
      this.i += str.length
      return true
    }
    return false
  }

  /** Segments after $ or @; inFilter stops at the first character that cannot continue a path. */
  segments() {
    const out = []
    for (;;) {
      if (this.eat('..')) {
        if (this.peek() === '[') out.push({ descendant: true, selectors: this.bracket() })
        else out.push({ descendant: true, selectors: [this.dotSelector()] })
      } else if (this.eat('.')) out.push({ descendant: false, selectors: [this.dotSelector()] })
      else if (this.peek() === '[') out.push({ descendant: false, selectors: this.bracket() })
      else return out
    }
  }
  dotSelector() {
    if (this.eat('*')) return { type: 'wild' }
    const m = NAME.exec(this.rest())
    if (!m) this.fail('Expected a property name')
    this.i += m[0].length
    return { type: 'name', name: m[0] }
  }
  bracket() {
    this.expect('[')
    const sels = []
    do {
      this.ws()
      sels.push(this.selector())
      this.ws()
    } while (this.eat(','))
    this.expect(']')
    return sels
  }
  selector() {
    const c = this.peek()
    if (c === '*') {
      this.i++
      return { type: 'wild' }
    }
    if (c === "'" || c === '"') return { type: 'name', name: this.string() }
    if (c === '?') {
      this.i++
      this.ws()
      return { type: 'filter', expr: this.orExpr() }
    }
    // index or slice
    const num = () => {
      const m = /^-?\d+/.exec(this.rest())
      if (!m) return null
      this.i += m[0].length
      return Number(m[0])
    }
    const start = num()
    this.ws()
    if (this.peek() !== ':') {
      if (start === null) this.fail('Expected a name, index, slice, * or filter')
      return { type: 'index', index: start }
    }
    this.i++
    this.ws()
    const end = num()
    this.ws()
    let step = null
    if (this.eat(':')) {
      this.ws()
      step = num()
    }
    return { type: 'slice', start, end, step }
  }
  string() {
    const q = this.s[this.i++]
    let out = ''
    while (!this.done() && this.peek() !== q) {
      let c = this.s[this.i++]
      if (c === '\\') {
        const e = this.s[this.i++]
        c = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', "'": "'", '"': '"' }[e]
        if (e === 'u') {
          c = String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 4), 16))
          this.i += 4
        }
        if (c === undefined) this.fail('Bad escape in string')
      }
      out += c
    }
    this.expect(q)
    return out
  }

  // filter expressions
  orExpr() {
    let a = this.andExpr()
    for (;;) {
      this.ws()
      if (!this.eat('||')) return a
      a = { op: 'or', a, b: this.andExpr() }
    }
  }
  andExpr() {
    let a = this.notExpr()
    for (;;) {
      this.ws()
      if (!this.eat('&&')) return a
      a = { op: 'and', a, b: this.notExpr() }
    }
  }
  notExpr() {
    this.ws()
    if (this.peek() === '!' && this.peek(1) !== '=') {
      this.i++
      return { op: 'not', a: this.notExpr() }
    }
    return this.primary()
  }
  primary() {
    this.ws()
    if (this.eat('(')) {
      const e = this.orExpr()
      this.ws()
      this.expect(')')
      return e
    }
    const left = this.operand()
    this.ws()
    const op = ['==', '!=', '<=', '>=', '=~', '<', '>'].find((o) => this.s.startsWith(o, this.i))
    if (!op) return { op: 'test', a: left } // existence (paths) or truthiness
    this.i += op.length
    this.ws()
    const right = op === '=~' && this.peek() === '/' ? this.regex() : this.operand()
    return { op: 'cmp', cmp: op, a: left, b: right }
  }
  operand() {
    this.ws()
    const c = this.peek()
    if (c === '@' || c === '$') {
      this.i++
      return { kind: 'path', root: c, segments: this.segments() }
    }
    if (c === "'" || c === '"') return { kind: 'lit', value: this.string() }
    const num = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(this.rest())
    if (num) {
      this.i += num[0].length
      return { kind: 'lit', value: Number(num[0]) }
    }
    for (const [w, v] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ]) {
      if (this.s.startsWith(w, this.i) && !/[\w]/.test(this.s[this.i + w.length] || '')) {
        this.i += w.length
        return { kind: 'lit', value: v }
      }
    }
    const fn = /^(length|count|match|search|value)\s*\(/.exec(this.rest())
    if (fn) {
      this.i += fn[0].length
      const args = []
      this.ws()
      if (this.peek() !== ')') {
        do {
          args.push(this.peek() === '/' ? this.regex() : this.operand())
          this.ws()
        } while (this.eat(','))
      }
      this.expect(')')
      return { kind: 'fn', name: fn[1], args }
    }
    this.fail('Expected a value, @path or $path')
  }
  regex() {
    this.expect('/')
    let src = ''
    while (!this.done() && this.peek() !== '/') {
      if (this.peek() === '\\') src += this.s[this.i++]
      src += this.s[this.i++]
    }
    this.expect('/')
    const flags = /^[gimsuy]*/.exec(this.rest())[0]
    this.i += flags.length
    try {
      return { kind: 'lit', value: new RegExp(src, flags.replace('g', '')) }
    } catch (e) {
      this.fail(`Invalid regex: ${e.message}`)
    }
  }
}

// ---- evaluation -------------------------------------------------------------------------------

const IDENT = /^[A-Za-z_$][\w$]*$/
const childPath = (path, key) => (typeof key === 'number' ? `${path}[${key}]` : IDENT.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function children(node) {
  const v = node.value
  if (Array.isArray(v)) return v.map((x, i) => ({ value: x, path: childPath(node.path, i) }))
  if (isObj(v)) return Object.keys(v).map((k) => ({ value: v[k], path: childPath(node.path, k) }))
  return []
}
function descendants(node, out = []) {
  out.push(node)
  for (const c of children(node)) descendants(c, out)
  return out
}

function select(node, sel, root) {
  const v = node.value
  switch (sel.type) {
    case 'wild':
      return children(node)
    case 'name':
      if (isObj(v) && Object.prototype.hasOwnProperty.call(v, sel.name)) return [{ value: v[sel.name], path: childPath(node.path, sel.name) }]
      if (sel.name === 'length' && (Array.isArray(v) || typeof v === 'string')) return [{ value: v.length, path: `${node.path}.length` }]
      return []
    case 'index': {
      if (!Array.isArray(v)) return []
      const i = sel.index < 0 ? v.length + sel.index : sel.index
      return i >= 0 && i < v.length ? [{ value: v[i], path: childPath(node.path, i) }] : []
    }
    case 'slice': {
      if (!Array.isArray(v)) return []
      const n = v.length
      const step = sel.step ?? 1
      if (step === 0) return []
      const norm = (x, d) => (x === null ? d : x < 0 ? Math.max(n + x, step > 0 ? 0 : -1) : Math.min(x, step > 0 ? n : n - 1))
      const start = norm(sel.start, step > 0 ? 0 : n - 1)
      const end = norm(sel.end, step > 0 ? n : -1)
      const out = []
      for (let i = start; step > 0 ? i < end : i > end; i += step) out.push({ value: v[i], path: childPath(node.path, i) })
      return out
    }
    case 'filter':
      return children(node).filter((c) => truthy(evalExpr(sel.expr, c, root)))
  }
  return []
}

export function evaluate(segments, root, start = { value: root, path: '$' }) {
  let nodes = [start]
  for (const seg of segments) {
    const base = seg.descendant ? nodes.flatMap((n) => descendants(n)) : nodes
    nodes = base.flatMap((n) => seg.selectors.flatMap((s) => select(n, s, root)))
  }
  return nodes
}

const NOTHING = Symbol('nothing')
/** Value of an operand: a single value, or NOTHING (no node, or more than one). */
function operandValue(o, cur, root) {
  if (o.kind === 'lit') return o.value
  if (o.kind === 'fn') return callFn(o, cur, root)
  const nodes = evaluate(o.segments, root, o.root === '@' ? cur : { value: root, path: '$' })
  return nodes.length === 1 ? nodes[0].value : NOTHING
}
function callFn(o, cur, root) {
  const arg = (i) => (o.args[i] ? operandValue(o.args[i], cur, root) : NOTHING)
  switch (o.name) {
    case 'length': {
      const v = arg(0)
      return typeof v === 'string' || Array.isArray(v) ? v.length : isObj(v) ? Object.keys(v).length : NOTHING
    }
    case 'count':
      return o.args[0]?.kind === 'path' ? evaluate(o.args[0].segments, root, o.args[0].root === '@' ? cur : { value: root, path: '$' }).length : NOTHING
    case 'value':
      return arg(0)
    case 'match':
    case 'search': {
      const s = arg(0)
      let re = arg(1)
      if (typeof re === 'string') re = new RegExp(o.name === 'match' ? `^(?:${re})$` : re)
      return typeof s === 'string' && re instanceof RegExp ? re.test(s) : false
    }
  }
  return NOTHING
}

function equal(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => equal(a[k], b[k]))
}

const truthy = (v) => v === true

function evalExpr(e, cur, root) {
  switch (e.op) {
    case 'or':
      return truthy(evalExpr(e.a, cur, root)) || truthy(evalExpr(e.b, cur, root))
    case 'and':
      return truthy(evalExpr(e.a, cur, root)) && truthy(evalExpr(e.b, cur, root))
    case 'not':
      return !truthy(evalExpr(e.a, cur, root))
    case 'test': {
      // a path tests for existence; a function result or literal for truthiness
      if (e.a.kind === 'path') return evaluate(e.a.segments, root, e.a.root === '@' ? cur : { value: root, path: '$' }).length > 0
      const v = operandValue(e.a, cur, root)
      return v !== NOTHING && v !== false && v !== null && v !== 0 && v !== ''
    }
    case 'cmp': {
      const a = operandValue(e.a, cur, root)
      const b = operandValue(e.b, cur, root)
      switch (e.cmp) {
        case '==':
          return a === NOTHING || b === NOTHING ? a === b : equal(a, b)
        case '!=':
          return a === NOTHING || b === NOTHING ? a !== b : !equal(a, b)
        case '=~': {
          let re = b
          if (typeof b === 'string') {
            try {
              re = new RegExp(b)
            } catch {
              return false
            }
          }
          return typeof a === 'string' && re instanceof RegExp && re.test(a)
        }
        default: {
          const comparable = (typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string')
          if (!comparable) return false
          return { '<': a < b, '<=': a <= b, '>': a > b, '>=': a >= b }[e.cmp]
        }
      }
    }
  }
  return false
}

/**
 * Run a JSONPath query.
 * @returns {{ nodes: { path, value }[], definite: boolean }}
 * @throws JsonPathError for invalid queries
 */
export function queryJsonPath(doc, query) {
  const { segments, definite } = parseJsonPath(query)
  return { nodes: evaluate(segments, doc), definite }
}

/**
 * Lines of `text` that contain `query` (case-insensitive), or match it when written as /regex/flags.
 * @returns {{ lines: string[], total: number }}
 */
export function filterLines(text, query) {
  const all = String(text ?? '').split(/\r?\n/)
  const m = /^\/(.+)\/([a-z]*)$/s.exec(query.trim())
  let test
  if (m) {
    let re
    try {
      re = new RegExp(m[1], m[2].replace('g', ''))
    } catch (e) {
      throw new JsonPathError(`Invalid regex: ${e.message}`)
    }
    test = (l) => re.test(l)
  } else {
    const q = query.toLowerCase()
    test = (l) => l.toLowerCase().includes(q)
  }
  return { lines: all.filter(test), total: all.length }
}
