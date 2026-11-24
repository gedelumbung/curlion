// Turn a stored request + variable scope into a concrete, ready-to-send request.
// Shared by the HTTP engine and the code snippet generator.
import { interpolate } from './variables.js'
import { appendQuery } from './url.js'
import { contentTypeFor } from './model.js'

/** Files picked for form-data rows live only in memory (they cannot be synced). */
export const fileStore = new Map() // rowId -> File

const enabled = (list) => (list || []).filter((r) => r.enabled !== false && r.key !== '')

function hasHeader(headers, name) {
  return headers.some((h) => h.key.toLowerCase() === name.toLowerCase())
}

// ---- Inheritance (collection -> folders -> request) --------------------------------

/**
 * The auth a request actually uses. 'inherit' walks up to the nearest folder, then the
 * collection, that sets one; nothing set anywhere means no auth.
 * @param ancestors [collection, ...folders], outermost first
 * @returns {{ auth, source: object|null }} source: the folder / collection the auth comes from
 */
export function effectiveAuth(auth, ancestors = []) {
  if (auth && auth.type && auth.type !== 'inherit') return { auth, source: null }
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i].auth
    if (a && a.type && a.type !== 'inherit') return { auth: a, source: ancestors[i] }
  }
  return { auth: { type: 'none' }, source: null }
}

/** Enabled collection / folder headers, outermost first; an inner header replaces an outer one with the same name. */
export function inheritedHeaders(ancestors = []) {
  const out = []
  for (const node of ancestors) {
    for (const h of enabled(node.headers)) {
      const i = out.findIndex((x) => x.key.toLowerCase() === h.key.toLowerCase())
      if (i !== -1) out.splice(i, 1)
      out.push({ ...h, source: node.name, sourceId: node.id })
    }
  }
  return out
}

/**
 * The request as it is sent: inherited auth filled in and the collection / folder headers
 * added in front of its own (its own header wins when both set the same name).
 * Returns a shallow copy; the stored request is not changed.
 */
export function applyInheritance(req, ancestors = []) {
  const { auth, source } = effectiveAuth(req.auth, ancestors)
  const own = new Set(enabled(req.headers).map((h) => h.key.toLowerCase()))
  const parent = inheritedHeaders(ancestors).filter((h) => !own.has(h.key.toLowerCase()))
  return { ...req, auth, authSourceId: source?.id || null, headers: [...parent, ...(req.headers || [])] }
}

/**
 * @returns {{ method, url, headers: {key,value}[], body: null | {mode, raw?, contentType?, fields?} }}
 */
export function resolveRequest(req, scope, opts = {}) {
  const I = (s) => interpolate(s ?? '', scope, opts)

  const protocol = req.protocol || 'http'
  let url = I(req.url).trim()
  // default scheme like Postman (ws:// for WebSocket; gRPC targets are host:port), unless
  // the URL still starts with an unresolved {{var}}
  if (url && protocol !== 'grpc' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith('{{')) url = (protocol === 'ws' ? 'ws://' : 'http://') + url

  const headers = enabled(req.headers).map((h) => ({ key: I(h.key), value: I(h.value) }))

  // Auth
  const a = req.auth || { type: 'none' }
  if (a.type === 'bearer' && a.bearer?.token) {
    if (!hasHeader(headers, 'authorization')) headers.push({ key: 'Authorization', value: `Bearer ${I(a.bearer.token)}` })
  } else if (a.type === 'basic') {
    const raw = `${I(a.basic?.username)}:${I(a.basic?.password)}`
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(raw)))
    if (!hasHeader(headers, 'authorization')) headers.push({ key: 'Authorization', value: `Basic ${b64}` })
  } else if (a.type === 'apikey' && a.apikey?.key) {
    if (a.apikey.in === 'query') url = appendQuery(url, I(a.apikey.key), I(a.apikey.value))
    else headers.push({ key: I(a.apikey.key), value: I(a.apikey.value) })
  }

  // GraphQL: always a JSON POST of { query, variables }. Variables are spliced in as text
  // so {{vars}} inside them still produce valid JSON once resolved.
  if (protocol === 'graphql') {
    const g = req.graphql || {}
    const vars = I(g.variables || '').trim()
    const raw = `{"query":${JSON.stringify(I(g.query || ''))}${vars ? `,"variables":${vars}` : ''}}`
    if (!hasHeader(headers, 'content-type')) headers.push({ key: 'Content-Type', value: 'application/json' })
    return { method: 'POST', url, headers, body: { mode: 'raw', raw, contentType: 'application/json' }, protocol }
  }

  // Body (GET/HEAD cannot carry one in fetch)
  let body = null
  const b = req.body || { mode: 'none' }
  if (!['GET', 'HEAD'].includes(req.method) && b.mode !== 'none') {
    if (b.mode === 'raw') {
      body = { mode: 'raw', raw: I(b.raw), contentType: contentTypeFor[b.rawType] || 'text/plain' }
      if (!hasHeader(headers, 'content-type')) headers.push({ key: 'Content-Type', value: body.contentType })
    } else if (b.mode === 'urlencoded') {
      body = { mode: 'urlencoded', fields: enabled(b.urlencoded).map((f) => ({ key: I(f.key), value: I(f.value) })) }
      if (!hasHeader(headers, 'content-type')) headers.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded' })
    } else if (b.mode === 'form-data') {
      body = {
        mode: 'form-data',
        fields: enabled(b.formData).map((f) => ({
          key: I(f.key),
          value: f.type === 'file' ? '' : I(f.value),
          type: f.type || 'text',
          file: f.type === 'file' ? fileStore.get(f.id) : undefined,
          fileName: f.type === 'file' ? fileStore.get(f.id)?.name || f.fileName || 'file' : undefined,
        })),
      }
      // Content-Type (with boundary) is set by the browser for FormData
    }
  }

  return { method: req.method, url, headers, body, protocol }
}

export function urlencode(fields) {
  return fields.map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`).join('&')
}
