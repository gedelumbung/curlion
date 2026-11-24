// Factories for Curlion's internal data model.
// Collection.items holds a tree of folders and requests; this tree is what
// gets stored in Supabase `collections.tree_data` (as { items }).

/**
 * Random UUID v4. crypto.randomUUID only exists in secure contexts (https / localhost),
 * so fall back to getRandomValues when Curlion is served over plain http on a LAN host.
 */
export function uid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export const clone = (v) => JSON.parse(JSON.stringify(v))

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']

export function kv(key = '', value = '', extra = {}) {
  return { id: uid(), key, value, description: '', enabled: true, ...extra }
}

/** Request protocols. Requests saved before protocols existed are HTTP. */
export const PROTOCOLS = [
  { id: 'http', label: 'HTTP' },
  { id: 'graphql', label: 'GraphQL' },
  { id: 'ws', label: 'WebSocket' },
  { id: 'socketio', label: 'Socket.IO' },
  { id: 'sse', label: 'SSE' },
  { id: 'grpc', label: 'gRPC' },
]
export const protocolOf = (req) => req?.protocol || 'http'

/** Default per-protocol settings; filled in lazily so older requests keep working. */
export const PROTOCOL_DEFAULTS = {
  graphql: () => ({ query: '', variables: '' }),
  ws: () => ({ message: '', format: 'text', protocols: '', saved: [] }), // saved: { id, name, body }
  socketio: () => ({ path: '/socket.io', event: 'message', args: '', ack: false, auth: '', listen: ['message'], transports: 'websocket', saved: [] }),
  grpc: () => ({ proto: '', protoName: '', service: '', method: '', message: '{}', tls: false }),
  sse: () => ({ reconnect: false, lastEventId: '' }), // reconnect like EventSource when the stream ends
}

/** Make sure a request has the settings object for its protocol (mutates, returns it). */
export function ensureProtocol(req) {
  const p = protocolOf(req)
  if (PROTOCOL_DEFAULTS[p]) req[p] = { ...PROTOCOL_DEFAULTS[p](), ...(req[p] || {}) }
  return req
}

/**
 * Auth settings, shared by requests, folders and collections.
 * 'inherit' (requests and folders) uses the nearest folder or the collection that sets one.
 */
export const AUTH_DEFAULTS = {
  bearer: () => ({ token: '' }),
  basic: () => ({ username: '', password: '' }),
  apikey: () => ({ key: '', value: '', in: 'header' }), // header | query
  oauth2: () => ({
    grantType: 'authorization_code', // authorization_code | client_credentials
    authUrl: '',
    tokenUrl: '',
    clientId: '',
    clientSecret: '',
    scope: '',
    audience: '',
    redirectUri: '', // empty: Curlion's own callback page
    pkce: true,
    clientAuth: 'basic', // basic (Authorization header) | body (client_id / client_secret fields)
    headerPrefix: 'Bearer',
    autoRefresh: true,
  }),
}

export function newAuth(type = 'inherit') {
  const a = { type }
  for (const [k, make] of Object.entries(AUTH_DEFAULTS)) a[k] = make()
  return a
}

export function newRequest(name = 'New Request', patch = {}) {
  return {
    id: uid(),
    type: 'request',
    name,
    protocol: 'http', // http | graphql | ws | socketio | grpc | sse
    method: 'GET',
    url: '',
    description: '', // shown on the published docs page
    params: [],
    headers: [],
    auth: newAuth('inherit'), // inherit | none | bearer | basic | apikey | oauth2
    body: {
      mode: 'none', // none | form-data | urlencoded | raw
      rawType: 'json', // json | text | xml | html
      raw: '',
      formData: [], // kv + { type: 'text' | 'file', fileName }
      urlencoded: [],
    },
    extract: [], // { id, path, variable, enabled }
    tests: [], // { id, enabled, source, property, op, expected } see lib/assertions.js
    samples: [], // { id, name, status, headers: kv[], body }
    ...patch,
  }
}

export function newFolder(name = 'New Folder') {
  // auth / headers apply to every request inside (see applyInheritance in resolve.js)
  return { id: uid(), type: 'folder', name, items: [], auth: newAuth('inherit'), headers: [] }
}

export function newCollection(name = 'New Collection') {
  const now = new Date().toISOString()
  return {
    id: uid(),
    name,
    description: '',
    items: [],
    auth: newAuth('none'), // default auth for requests set to "inherit"
    headers: [], // sent with every request in the collection
    isPublic: false,
    publicSlug: null,
    createdAt: now,
    updatedAt: now,
    syncedAt: null,
  }
}

export function newEnvironment(name = 'New Environment', isGlobal = false) {
  return {
    id: uid(),
    name,
    isGlobal,
    variables: [], // { id, key, value, enabled, isSecret }
    updatedAt: new Date().toISOString(),
    syncedAt: null,
  }
}

export function newSample(name = 'Sample', patch = {}) {
  return {
    id: uid(),
    name,
    status: 200,
    headers: [kv('Content-Type', 'application/json')],
    body: '{\n  \n}',
    ...patch,
  }
}

// ---- Tree helpers -------------------------------------------------------

export function walk(items, fn, parent = null) {
  for (const item of items) {
    if (fn(item, parent) === false) return false
    if (item.type === 'folder' && walk(item.items, fn, item) === false) return false
  }
}

export function findNode(items, id) {
  let found = null
  walk(items, (item, parent) => {
    if (item.id === id) {
      found = { node: item, parent }
      return false
    }
  })
  return found
}

/** Folders that contain the node with this id, outermost first: [] at the top level, null when not found. */
export function folderPath(items, id) {
  for (const n of items) {
    if (n.id === id) return []
    if (n.type === 'folder') {
      const inner = folderPath(n.items, id)
      if (inner) return [n, ...inner]
    }
  }
  return null
}

/** Deep copy a node, assigning fresh ids to it and all descendants. */
export function reId(node) {
  const copy = clone(node)
  const fix = (n) => {
    n.id = uid()
    if (n.type === 'folder') n.items.forEach(fix)
    if (n.type === 'request') n.samples?.forEach((s) => (s.id = uid()))
  }
  fix(copy)
  return copy
}

export const contentTypeFor = {
  json: 'application/json',
  text: 'text/plain',
  xml: 'application/xml',
  html: 'text/html',
}
