// Factories for PostLite's internal data model.
// Collection.items holds a tree of folders and requests; this tree is what
// gets stored in Supabase `collections.tree_data` (as { items }).

export const uid = () => crypto.randomUUID()

export const clone = (v) => JSON.parse(JSON.stringify(v))

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']

export function kv(key = '', value = '', extra = {}) {
  return { id: uid(), key, value, description: '', enabled: true, ...extra }
}

export function newRequest(name = 'New Request', patch = {}) {
  return {
    id: uid(),
    type: 'request',
    name,
    method: 'GET',
    url: '',
    description: '', // shown on the published docs page
    params: [],
    headers: [],
    auth: {
      type: 'none', // none | bearer | basic | apikey
      bearer: { token: '' },
      basic: { username: '', password: '' },
      apikey: { key: '', value: '', in: 'header' }, // header | query
    },
    body: {
      mode: 'none', // none | form-data | urlencoded | raw
      rawType: 'json', // json | text | xml | html
      raw: '',
      formData: [], // kv + { type: 'text' | 'file', fileName }
      urlencoded: [],
    },
    extract: [], // { id, path, variable, enabled }
    samples: [], // { id, name, status, headers: kv[], body }
    ...patch,
  }
}

export function newFolder(name = 'New Folder') {
  return { id: uid(), type: 'folder', name, items: [] }
}

export function newCollection(name = 'New Collection') {
  const now = new Date().toISOString()
  return {
    id: uid(),
    name,
    description: '',
    items: [],
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
