// Activity log entries derived from the difference between two collection trees.
// Logging from diffs (instead of hooking every UI action) keeps the log faithful to
// what actually reached the cloud, and lets rapid edits collapse into one entry.

export const ACTIONS = {
  CREATE_COLLECTION: 'Created collection',
  IMPORT_COLLECTION: 'Imported collection',
  CREATE_REQUEST: 'Created request',
  UPDATE_REQUEST: 'Updated request',
  DELETE_REQUEST: 'Deleted request',
  CREATE_FOLDER: 'Created folder',
  RENAME_FOLDER: 'Renamed folder',
  DELETE_FOLDER: 'Deleted folder',
  ADD_MOCK_SAMPLE: 'Added mock sample',
  PUBLISH_DOCS: 'Published docs',
  UNPUBLISH_DOCS: 'Unpublished docs',
  ADD_MEMBER: 'Added member',
  REMOVE_MEMBER: 'Removed member',
}

function flatten(items, map = new Map(), path = []) {
  for (const n of items || []) {
    map.set(n.id, { node: n, path })
    if (n.type === 'folder') flatten(n.items, map, [...path, n.name])
  }
  return map
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const where = (path) => (path.length ? path.join(' / ') : '')

const SECTIONS = ['params', 'headers', 'auth', 'body', 'extract', 'description']

/** @returns {{ action, target_name, metadata }[]} */
export function diffTrees(oldItems, newItems) {
  const before = flatten(oldItems)
  const after = flatten(newItems)
  const out = []

  for (const [id, { node, path }] of after) {
    const prev = before.get(id)?.node
    if (node.type === 'folder') {
      if (!prev) out.push({ action: 'CREATE_FOLDER', target_name: node.name, metadata: { path: where(path) } })
      else if (prev.name !== node.name) out.push({ action: 'RENAME_FOLDER', target_name: node.name, metadata: { from: prev.name, to: node.name } })
      continue
    }
    if (!prev) {
      out.push({ action: 'CREATE_REQUEST', target_name: node.name, metadata: { method: node.method, url: node.url, path: where(path) } })
      for (const s of node.samples || []) out.push(sampleEntry(node, s))
      continue
    }
    const changes = []
    if (prev.name !== node.name) changes.push({ field: 'name', from: prev.name, to: node.name })
    if (prev.method !== node.method) changes.push({ field: 'method', from: prev.method, to: node.method })
    if (prev.url !== node.url) changes.push({ field: 'url', from: prev.url, to: node.url })
    for (const key of SECTIONS) if (!same(prev[key], node[key])) changes.push({ field: key })
    const prevSampleIds = new Set((prev.samples || []).map((s) => s.id))
    const newSamples = (node.samples || []).filter((s) => !prevSampleIds.has(s.id))
    // existing samples removed or edited (new ones get their own ADD_MOCK_SAMPLE entry)
    const kept = (node.samples || []).filter((s) => prevSampleIds.has(s.id))
    const samplesChanged = kept.length !== (prev.samples || []).length || kept.some((s) => !same(s, prev.samples.find((x) => x.id === s.id)))
    if (samplesChanged) changes.push({ field: 'samples' })
    if (changes.length) out.push({ action: 'UPDATE_REQUEST', target_name: node.name, metadata: { method: node.method, changes } })
    for (const s of newSamples) out.push(sampleEntry(node, s))
  }

  for (const [id, { node, path }] of before) {
    if (after.has(id)) continue
    // only log the top-most removed node (deleting a folder removes its children too)
    const parentRemoved = [...before.values()].some((b) => b.node.type === 'folder' && !after.has(b.node.id) && b.node.items.some((c) => c.id === id))
    if (parentRemoved) continue
    out.push(
      node.type === 'folder'
        ? { action: 'DELETE_FOLDER', target_name: node.name, metadata: { path: where(path), items: countRequests(node.items) } }
        : { action: 'DELETE_REQUEST', target_name: node.name, metadata: { method: node.method, url: node.url, path: where(path) } },
    )
  }
  return out
}

function sampleEntry(req, s) {
  return { action: 'ADD_MOCK_SAMPLE', target_name: s.name, metadata: { request: req.name, status: s.status } }
}

function countRequests(items) {
  return items.reduce((n, x) => n + (x.type === 'folder' ? countRequests(x.items) : 1), 0)
}

/** One-line human summary of a log row, used in the Activity tab. */
export function describeLog(log) {
  const m = log.metadata || {}
  switch (log.action) {
    case 'UPDATE_REQUEST': {
      const parts = (m.changes || []).map((c) => (c.from !== undefined ? `${c.field}: ${short(c.from)} → ${short(c.to)}` : c.field))
      return parts.join(' · ')
    }
    case 'RENAME_FOLDER':
      return `${m.from} → ${m.to}`
    case 'CREATE_REQUEST':
    case 'DELETE_REQUEST':
      return [m.method, short(m.url, 60)].filter(Boolean).join(' ') + (m.path ? ` (in ${m.path})` : '')
    case 'DELETE_FOLDER':
      return m.items ? `${m.items} request(s) inside` : ''
    case 'ADD_MOCK_SAMPLE':
      return `${m.status} on "${m.request}"`
    case 'IMPORT_COLLECTION':
    case 'CREATE_COLLECTION':
      return m.requests !== undefined ? `${m.requests} request(s)` : ''
    case 'PUBLISH_DOCS':
      return m.slug ? `/docs/${m.slug}` : ''
    case 'ADD_MEMBER':
      return m.role ? `as ${m.role}` : ''
    default:
      return ''
  }
}

const short = (s, n = 40) => {
  const str = String(s ?? '')
  return str.length > n ? str.slice(0, n) + '…' : str || '(empty)'
}

export { countRequests }
