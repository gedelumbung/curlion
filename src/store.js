// Global app store: state, persistence (IndexedDB) and cloud sync (Supabase).
import { computed, reactive, toRaw, watch } from 'vue'
import { db, getMeta, migrateLegacyDb, setMeta } from './db/index.js'
import { clone, findNode, kv, newCollection, newEnvironment, newFolder, newRequest, reId, uid } from './lib/model.js'
import { buildScope, getByPath } from './lib/variables.js'
import { resolveRequest } from './lib/resolve.js'
import { sendRequest } from './lib/http.js'
import { collectionToRow, environmentToRow, rowToCollection, rowToEnvironment, supabase } from './lib/supabase.js'
import { countRequests, diffTrees } from './lib/activity.js'
import { buildDocsSnapshot } from './lib/publish.js'

const SAVE_DELAY = 300 // IndexedDB write debounce
const SYNC_DELAY = 3000 // Supabase debounced auto-save (PRD §7.1)
const HISTORY_LIMIT = 100
const ACTIVITY_DELAY = 60_000 // collapse edits into one activity entry per minute

export const state = reactive({
  ready: false,
  collections: [],
  environments: [],
  activeEnvId: null,
  mode: 'direct', // direct | proxy
  active: null, // { collectionId, requestId }
  tabs: [], // open request tabs: { collectionId, requestId, preview }
  expanded: {}, // folder/collection id -> bool
  search: '',
  responses: {}, // requestId -> response (kept per request for this session)
  pending: {}, // requestId -> true while that request is in flight
  errors: {}, // requestId -> error message of its last send
  history: [],
  user: null,
  roles: {}, // collectionId -> 'editor' | 'viewer' for collections shared with me
  sync: { status: supabase ? 'signed-out' : 'local', message: '', lastAt: null },
  toasts: [],
})

export const cloudEnabled = !!supabase

// ---- Derived ------------------------------------------------------------

export const globalEnv = computed(() => state.environments.find((e) => e.isGlobal))
export const activeEnv = computed(() => state.environments.find((e) => e.id === state.activeEnvId && !e.isGlobal) || null)
export const scope = computed(() => buildScope(globalEnv.value, activeEnv.value))

export const activeCollection = computed(() => state.collections.find((c) => c.id === state.active?.collectionId) || null)
export const activeRequest = computed(() => {
  const col = activeCollection.value
  if (!col) return null
  const hit = findNode(col.items, state.active.requestId)
  return hit?.node.type === 'request' ? hit.node : null
})
export const activeResponse = computed(() => (activeRequest.value ? state.responses[activeRequest.value.id] || null : null))
export const activeLoading = computed(() => !!(activeRequest.value && state.pending[activeRequest.value.id]))
export const activeError = computed(() => (activeRequest.value ? state.errors[activeRequest.value.id] || null : null))

/** Open tabs resolved to their collection + request (tabs whose request no longer exists are skipped). */
export const openTabs = computed(() =>
  state.tabs.flatMap((tab) => {
    const col = state.collections.find((c) => c.id === tab.collectionId)
    const hit = col && findNode(col.items, tab.requestId)
    return hit?.node.type === 'request' ? [{ tab, col, req: hit.node }] : []
  }),
)

/** 'owner' | 'editor' | 'viewer' (local-only collections count as owner). */
export function roleOf(col) {
  if (!col) return 'owner'
  return state.roles[col.id] || 'owner'
}
export const canEdit = (col) => roleOf(col) !== 'viewer'

// ---- Toasts -------------------------------------------------------------

export function toast(message, type = 'info', ms = 3500) {
  const id = uid()
  state.toasts.push({ id, message, type })
  setTimeout(() => {
    const i = state.toasts.findIndex((t) => t.id === id)
    if (i !== -1) state.toasts.splice(i, 1)
  }, ms)
}

// ---- Persistence helpers -----------------------------------------------

const timers = new Map()
function debounce(key, ms, fn) {
  clearTimeout(timers.get(key))
  timers.set(key, setTimeout(() => {
    timers.delete(key)
    fn()
  }, ms))
}
async function flushTimers(prefix) {
  for (const [key, t] of [...timers]) {
    if (key.startsWith(prefix)) {
      clearTimeout(t)
      timers.delete(key)
    }
  }
}

const plain = (obj) => clone(toRaw(obj))

function persistCollection(col) {
  debounce('save:col:' + col.id, SAVE_DELAY, () => db.collections.put(plain(col)))
  if (canEdit(col)) scheduleSync('col', col.id)
}
function persistEnvironment(env) {
  debounce('save:env:' + env.id, SAVE_DELAY, () => db.environments.put(plain(env)))
  scheduleSync('env', env.id)
}

/** Call after any mutation inside a collection. */
export function touchCollection(colOrId) {
  const col = typeof colOrId === 'string' ? state.collections.find((c) => c.id === colOrId) : colOrId
  if (!col) return
  col.updatedAt = new Date().toISOString()
  persistCollection(col)
}

export function touchEnvironment(env) {
  env.updatedAt = new Date().toISOString()
  persistEnvironment(env)
}

/** Ctrl+S: write everything now and sync immediately. */
export async function saveNow() {
  await flushTimers('save:')
  await db.transaction('rw', db.collections, db.environments, async () => {
    await db.collections.bulkPut(state.collections.map(plain))
    await db.environments.bulkPut(state.environments.map(plain))
  })
  if (state.user) {
    await flushTimers('sync:')
    await syncAll()
    await flushAllActivity()
    toast('Saved & synced', 'success', 1500)
  } else {
    toast('Saved locally', 'success', 1500)
  }
}

// ---- Init ---------------------------------------------------------------

export async function init() {
  try {
    await migrateLegacyDb()
  } catch (err) {
    console.warn('Legacy data migration failed', err)
  }
  const [cols, envs, history, activeEnvId, mode, active, expanded] = await Promise.all([
    db.collections.toArray(),
    db.environments.toArray(),
    db.history.orderBy('ts').reverse().limit(HISTORY_LIMIT).toArray(),
    getMeta('activeEnvId'),
    getMeta('mode', 'direct'),
    getMeta('active'),
    getMeta('expanded', {}),
  ])
  const savedTabs = await getMeta('tabs', [])
  cols.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
  state.collections = cols
  state.environments = envs
  state.history = history
  state.activeEnvId = activeEnvId
  state.mode = mode
  state.expanded = expanded || {}

  if (!state.environments.some((e) => e.isGlobal)) {
    const g = newEnvironment('Globals', true)
    state.environments.unshift(g)
    await db.environments.put(plain(g))
  }

  if (!cols.length && !(await getMeta('seeded'))) {
    await seedGettingStarted()
    await setMeta('seeded', true)
  }

  const exists = (t) => t && findNode(state.collections.find((c) => c.id === t.collectionId)?.items || [], t.requestId)
  if (!state.tabs.length) state.tabs = (savedTabs || []).filter(exists)
  if (!state.active && exists(active)) state.active = active
  if (state.active && !state.tabs.some((t) => t.requestId === state.active.requestId)) {
    state.tabs.push({ ...state.active, preview: false })
  }
  saveTabs()

  state.ready = true

  if (supabase) {
    const { data } = await supabase.auth.getSession()
    setUser(data.session?.user || null)
    supabase.auth.onAuthStateChange((_event, session) => setUser(session?.user || null))
  }
}

async function seedGettingStarted() {
  // reuse an existing Development env that points at dummyjson, otherwise create one
  let dev = state.environments.find((e) => !e.isGlobal && e.variables.some((v) => v.key === 'baseUrl' && v.value === 'https://dummyjson.com'))
  const newEnv = !dev
  if (newEnv) {
    dev = newEnvironment('Development')
    dev.variables = [
      { id: uid(), key: 'baseUrl', value: 'https://dummyjson.com', enabled: true, isSecret: false },
      { id: uid(), key: 'token', value: '', enabled: true, isSecret: true },
    ]
  } else if (!dev.variables.some((v) => v.key === 'token')) {
    dev.variables.push({ id: uid(), key: 'token', value: '', enabled: true, isSecret: true })
    dev.updatedAt = new Date().toISOString()
  }

  const col = newCollection('Getting Started')
  col.description = 'Example requests. Run "Login" first: its Extract rule saves the token into {{token}}.'
  const auth = newFolder('Auth flow')
  const login = newRequest('Login', {
    method: 'POST',
    url: '{{baseUrl}}/auth/login',
    headers: [],
    extract: [{ id: uid(), path: 'accessToken', variable: 'token', enabled: true }],
  })
  login.body.mode = 'raw'
  login.body.rawType = 'json'
  login.body.raw = JSON.stringify({ username: 'emilys', password: 'emilyspass', expiresInMins: 30 }, null, 2)
  const me = newRequest('Current user (uses {{token}})', { url: '{{baseUrl}}/auth/me' })
  me.auth.type = 'bearer'
  me.auth.bearer.token = '{{token}}'
  auth.items.push(login, me)

  const products = newRequest('List products', {
    url: '{{baseUrl}}/products?limit=5&select=title,price',
    params: [kv('limit', '5'), kv('select', 'title,price')],
  })
  const create = newRequest('Create post (dynamic vars)', { method: 'POST', url: '{{baseUrl}}/posts/add' })
  create.body.mode = 'raw'
  create.body.raw = JSON.stringify({ title: 'Hello {{$randomInt}}', userId: 5, ref: '{{$uuid}}', at: '{{$isoTimestamp}}' }, null, 2)
  const image = newRequest('Download image (binary)', { url: 'https://dummyjson.com/image/200x100' })

  col.items.push(auth, products, create, image)
  state.collections.push(col)
  if (newEnv) state.environments.push(dev)
  state.activeEnvId = dev.id
  state.expanded[col.id] = true
  state.expanded[auth.id] = true
  state.active = { collectionId: col.id, requestId: login.id }
  await db.collections.put(plain(col))
  await db.environments.put(plain(dev))
  await setMeta('activeEnvId', dev.id)
  await setMeta('expanded', { ...state.expanded })
  await setMeta('active', { ...state.active })
}

// ---- Settings -----------------------------------------------------------

export function setActiveEnv(id) {
  state.activeEnvId = id
  setMeta('activeEnvId', id)
}
export function setMode(mode) {
  state.mode = mode
  setMeta('mode', mode)
}
export function toggleExpanded(id, value) {
  state.expanded[id] = value ?? !state.expanded[id]
  setMeta('expanded', { ...state.expanded })
}
// ---- Tabs ---------------------------------------------------------------
// Like Postman: a single click in the sidebar opens a *preview* tab (italic) that the
// next single click replaces. Editing, sending or double-clicking the tab keeps it.

function saveTabs() {
  setMeta('tabs', state.tabs.map((t) => ({ ...t })))
  setMeta('active', state.active ? { ...state.active } : null)
}

/**
 * Open a request in a tab and make it active.
 * opts.preview: open as a preview tab (replaces the current preview tab).
 */
export function openRequest(collectionId, requestId, { preview = false } = {}) {
  const existing = state.tabs.find((t) => t.requestId === requestId)
  if (existing) {
    existing.collectionId = collectionId
    if (!preview) existing.preview = false
  } else {
    const tab = { collectionId, requestId, preview }
    const prevIdx = preview ? state.tabs.findIndex((t) => t.preview) : -1
    if (prevIdx !== -1) state.tabs.splice(prevIdx, 1, tab)
    else {
      const activeIdx = state.tabs.findIndex((t) => t.requestId === state.active?.requestId)
      state.tabs.splice(activeIdx === -1 ? state.tabs.length : activeIdx + 1, 0, tab)
    }
  }
  state.active = { collectionId, requestId }
  saveTabs()
}

/** Turn a preview tab into a regular one (on edit, send or double-click). */
export function keepTab(requestId) {
  const tab = state.tabs.find((t) => t.requestId === requestId)
  if (tab?.preview) {
    tab.preview = false
    saveTabs()
  }
}

/** Close the tabs matching `pred`; if the active one closes, activate its neighbour. */
export function closeTabs(pred) {
  const activeIdx = state.tabs.findIndex((t) => t.requestId === state.active?.requestId)
  const activeClosed = activeIdx !== -1 && pred(state.tabs[activeIdx], activeIdx)
  const kept = state.tabs.filter((t, i) => !pred(t, i))
  for (const t of state.tabs) if (!kept.includes(t) && state.pending[t.requestId]) cancel(t.requestId)
  if (activeClosed || !state.active) {
    // nearest surviving tab to the right of the old position, else to the left
    const after = state.tabs.slice(activeIdx + 1).find((t) => kept.includes(t))
    const before = state.tabs.slice(0, Math.max(activeIdx, 0)).reverse().find((t) => kept.includes(t))
    const next = after || before
    state.active = next ? { collectionId: next.collectionId, requestId: next.requestId } : null
  }
  state.tabs = kept
  saveTabs()
}
export const closeTab = (requestId) => closeTabs((t) => t.requestId === requestId)

// Requests can also disappear through sync (deleted on another device): drop their tabs.
watch(openTabs, (list) => {
  if (state.ready && list.length !== state.tabs.length) closeTabs((t) => !list.some((x) => x.tab === t))
})

export function moveTab(from, to) {
  if (from === to || from < 0 || to < 0) return
  const [tab] = state.tabs.splice(from, 1)
  state.tabs.splice(to, 0, tab)
  saveTabs()
}

// ---- Collection CRUD ----------------------------------------------------

export function createCollection(name = 'New Collection') {
  const col = newCollection(name)
  state.collections.push(col)
  state.expanded[col.id] = true
  persistCollection(col)
  return col
}

export function addCollection(col) {
  state.collections.push(col)
  state.expanded[col.id] = true
  persistCollection(col)
  return col
}

export async function deleteCollection(id) {
  const i = state.collections.findIndex((c) => c.id === id)
  if (i === -1) return
  const [col] = state.collections.splice(i, 1)
  closeTabs((t) => t.collectionId === id)
  await db.collections.delete(id)
  if (state.roles[id]) {
    // shared with me: "delete" means leave the collection
    delete state.roles[id]
    if (supabase && state.user) await supabase.from('collection_members').delete().eq('collection_id', id).eq('user_id', state.user.id)
    return
  }
  if (col.syncedAt) await db.tombstones.put({ id, table: 'collections' })
  scheduleSync('tombstones', 'all')
}

/** Container (collection or folder) id -> its items array */
function containerItems(col, parentId) {
  if (!parentId || parentId === col.id) return col.items
  const hit = findNode(col.items, parentId)
  return hit?.node.type === 'folder' ? hit.node.items : col.items
}

export function addFolder(col, parentId, name = 'New Folder') {
  const f = newFolder(name)
  containerItems(col, parentId).push(f)
  state.expanded[parentId || col.id] = true
  state.expanded[f.id] = true
  touchCollection(col)
  return f
}

/** "New request" button: add to the active collection (if editable), else the first editable one, else a new one. */
export function addNewRequest() {
  const active = state.collections.find((c) => c.id === state.active?.collectionId)
  const col = (active && canEdit(active) ? active : state.collections.find(canEdit)) || createCollection('My Collection')
  return addRequest(col, null)
}

export function addRequest(col, parentId, req = newRequest()) {
  containerItems(col, parentId).push(req)
  state.expanded[parentId || col.id] = true
  touchCollection(col)
  openRequest(col.id, req.id)
  return req
}

export function renameNode(col, id, name) {
  if (id === col.id) col.name = name
  else {
    const hit = findNode(col.items, id)
    if (hit) hit.node.name = name
  }
  touchCollection(col)
}

export function duplicateNode(col, id) {
  const hit = findNode(col.items, id)
  if (!hit) return
  const list = hit.parent ? hit.parent.items : col.items
  const copy = reId(hit.node)
  copy.name = hit.node.name + ' Copy'
  list.splice(list.indexOf(hit.node) + 1, 0, copy)
  touchCollection(col)
  if (copy.type === 'request') openRequest(col.id, copy.id)
}

export function deleteNode(col, id) {
  const hit = findNode(col.items, id)
  if (!hit) return
  const list = hit.parent ? hit.parent.items : col.items
  list.splice(list.indexOf(hit.node), 1)
  // close the tab of the deleted request, or of every request inside a deleted folder
  closeTabs((t) => t.collectionId === col.id && !findNode(col.items, t.requestId))
  touchCollection(col)
}

/** Move a node to another container (drag & drop). */
export function moveNode(col, id, targetParentId, beforeId = null) {
  const hit = findNode(col.items, id)
  if (!hit) return
  if (hit.node.type === 'folder' && (targetParentId === id || findNode(hit.node.items, targetParentId))) return // no moving into itself
  const from = hit.parent ? hit.parent.items : col.items
  from.splice(from.indexOf(hit.node), 1)
  const to = containerItems(col, targetParentId)
  const idx = beforeId ? to.findIndex((n) => n.id === beforeId) : -1
  if (idx === -1) to.push(hit.node)
  else to.splice(idx, 0, hit.node)
  touchCollection(col)
}

// ---- Environments -------------------------------------------------------

export function createEnvironment(name) {
  const env = newEnvironment(name)
  state.environments.push(env)
  persistEnvironment(env)
  return env
}

export function addEnvironment(env) {
  state.environments.push(env)
  persistEnvironment(env)
}

export async function deleteEnvironment(id) {
  const i = state.environments.findIndex((e) => e.id === id)
  if (i === -1 || state.environments[i].isGlobal) return
  const [env] = state.environments.splice(i, 1)
  if (state.activeEnvId === id) setActiveEnv(null)
  await db.environments.delete(id)
  if (env.syncedAt) await db.tombstones.put({ id, table: 'environments' })
  scheduleSync('tombstones', 'all')
}

/** Set a variable in the active environment (or Globals when none is active). */
export function setVariable(key, value) {
  const env = activeEnv.value || globalEnv.value
  let v = env.variables.find((x) => x.key === key)
  if (v) v.value = value
  else env.variables.push((v = { id: uid(), key, value, enabled: true, isSecret: /token|secret|password|key/i.test(key) }))
  touchEnvironment(env)
  return env
}

// ---- Sending ------------------------------------------------------------

// One in-flight request per tab; tabs can send concurrently.
const controllers = new Map() // requestId -> AbortController

export async function send({ download = false } = {}) {
  const req = activeRequest.value
  if (!req) return
  const id = req.id
  keepTab(id)
  if (!req.url.trim()) {
    state.errors[id] = 'Enter a request URL first.'
    return
  }
  controllers.get(id)?.abort()
  const controller = new AbortController()
  controllers.set(id, controller)
  state.pending[id] = true
  delete state.errors[id]
  const resolved = resolveRequest(req, scope.value)
  try {
    if (state.mode === 'proxy' && /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(resolved.url)) {
      throw new Error('localhost cannot be reached through the cloud proxy. Switch to Direct mode and enable CORS on your local server.')
    }
    const res = await sendRequest(resolved, { mode: state.mode, download, signal: controller.signal })
    res.at = Date.now()
    res.extracted = runExtract(req, res)
    state.responses[id] = res
    addHistory(req, resolved, res)
  } catch (err) {
    if (err.name !== 'AbortError') {
      state.errors[id] = err.message
      delete state.responses[id]
    }
  } finally {
    // a newer send of the same request may have replaced this one
    if (controllers.get(id) === controller) {
      controllers.delete(id)
      delete state.pending[id]
    }
  }
}

export function cancel(id = activeRequest.value?.id) {
  controllers.get(id)?.abort()
  controllers.delete(id)
  delete state.pending[id]
}

/** Post-response extraction: JSON path -> environment variable. */
function runExtract(req, res) {
  const results = []
  for (const rule of req.extract || []) {
    if (rule.enabled === false || !rule.path || !rule.variable) continue
    if (res.json === undefined) {
      results.push({ variable: rule.variable, ok: false, message: 'Response is not JSON' })
      continue
    }
    const value = getByPath(res.json, rule.path)
    if (value === undefined) {
      results.push({ variable: rule.variable, ok: false, message: `Path "${rule.path}" not found` })
      continue
    }
    const str = typeof value === 'string' ? value : JSON.stringify(value)
    const env = setVariable(rule.variable.replace(/^\{\{|\}\}$/g, '').trim(), str)
    results.push({ variable: rule.variable, ok: true, env: env.name })
  }
  return results
}

async function addHistory(req, resolved, res) {
  const entry = {
    ts: Date.now(),
    requestId: req.id,
    collectionId: state.active?.collectionId,
    name: req.name,
    method: resolved.method,
    url: resolved.url,
    status: res.status,
    time: res.time,
  }
  const id = await db.history.add(entry)
  state.history.unshift({ ...entry, id })
  if (state.history.length > HISTORY_LIMIT) {
    const extra = state.history.splice(HISTORY_LIMIT)
    db.history.bulkDelete(extra.map((e) => e.id))
  }
}

export async function clearHistory() {
  state.history = []
  await db.history.clear()
}

// ---- Cloud sync (Supabase) ---------------------------------------------

function setUser(user) {
  const prev = state.user?.id
  state.user = user ? { id: user.id, email: user.email } : null
  if (!user) {
    state.sync.status = 'signed-out'
    return
  }
  if (prev !== user.id) syncAll()
}

function scheduleSync(kind, id) {
  if (!supabase || !state.user) return
  debounce(`sync:${kind}:${id}`, SYNC_DELAY, () => syncOne(kind, id))
}

async function syncOne(kind, id) {
  try {
    state.sync.status = 'syncing'
    if (kind === 'col') {
      const col = state.collections.find((c) => c.id === id)
      if (col) await pushCollection(col)
    } else if (kind === 'env') {
      const env = state.environments.find((e) => e.id === id)
      if (env) await pushEnvironment(env)
    } else if (kind === 'tombstones') {
      await pushTombstones()
    }
    syncOk()
  } catch (err) {
    syncFail(err)
  }
}

async function pushCollection(col) {
  const row = collectionToRow(plain(col), state.user.id)
  // Editors of someone else's collection may update but not insert (RLS).
  const { error } =
    col.ownerId && col.ownerId !== state.user.id
      ? await supabase.from('collections').update(row).eq('id', col.id)
      : await supabase.from('collections').upsert(row)
  if (error) throw error
  const isNew = !col.syncedAt && !activityBase.has(col.id)
  col.ownerId ||= state.user.id
  col.syncedAt = col.updatedAt
  await db.collections.put(plain(col))
  if (isNew) {
    queueLogs(col.id, [
      {
        action: col.importedFrom ? 'IMPORT_COLLECTION' : 'CREATE_COLLECTION',
        target_name: col.name,
        metadata: { requests: countRequests(col.items), ...(col.importedFrom ? { source: col.importedFrom } : {}) },
      },
    ])
    activityBase.set(col.id, clone(col.items))
  } else {
    scheduleActivity(col.id)
  }
}

async function pushEnvironment(env) {
  const { error } = await supabase.from('environments').upsert(environmentToRow(plain(env), state.user.id))
  if (error) throw error
  env.syncedAt = env.updatedAt
  await db.environments.put(plain(env))
}

async function pushTombstones() {
  const rows = await db.tombstones.toArray()
  for (const t of rows) {
    const { error } = await supabase.from(t.table).delete().eq('id', t.id)
    if (error) throw error
    await db.tombstones.delete(t.id)
  }
}

const syncOk = () => {
  state.sync.status = 'synced'
  state.sync.message = ''
  state.sync.lastAt = Date.now()
}
const syncFail = (err) => {
  state.sync.status = 'error'
  state.sync.message = err.message || String(err)
}

/** Full two-way merge, last-write-wins on updatedAt. */
export async function syncAll() {
  if (!supabase || !state.user) return
  state.sync.status = 'syncing'
  try {
    await pushTombstones()

    const [{ data: rCols, error: e1 }, { data: rEnvs, error: e2 }] = await Promise.all([
      supabase.from('collections').select('*'),
      supabase.from('environments').select('*'),
    ])
    if (e1) throw e1
    if (e2) throw e2

    // Which of these collections are shared with me, and with what role?
    const { data: memberships, error: e3 } = await supabase.from('collection_members').select('collection_id, role').eq('user_id', state.user.id)
    if (e3) throw e3
    state.roles = Object.fromEntries(memberships.map((m) => [m.collection_id, m.role]))

    const remoteCols = rCols.map(rowToCollection)
    // activity baseline = what the cloud had before this sync
    for (const r of remoteCols) if (!activityBase.has(r.id)) activityBase.set(r.id, clone(r.items))
    await mergeList(state.collections, remoteCols, 'collections', pushCollection)

    // Only one Globals env per user: if the cloud already has one, adopt it.
    const remoteEnvs = rEnvs.map(rowToEnvironment)
    const remoteGlobal = remoteEnvs.find((e) => e.isGlobal)
    const localGlobal = state.environments.find((e) => e.isGlobal)
    if (remoteGlobal && localGlobal && remoteGlobal.id !== localGlobal.id) {
      // merge local global vars that don't exist remotely, then drop the local one
      for (const v of localGlobal.variables) if (!remoteGlobal.variables.some((r) => r.key === v.key)) remoteGlobal.variables.push(v)
      remoteGlobal.updatedAt = new Date().toISOString()
      state.environments.splice(state.environments.indexOf(localGlobal), 1)
      await db.environments.delete(localGlobal.id)
    }
    await mergeList(state.environments, remoteEnvs, 'environments', pushEnvironment)
    syncOk()
  } catch (err) {
    syncFail(err)
    toast('Sync failed: ' + state.sync.message, 'error')
  }
}

async function mergeList(localList, remoteList, table, push) {
  const remoteById = new Map(remoteList.map((r) => [r.id, r]))
  // local items
  for (const local of [...localList]) {
    const remote = remoteById.get(local.id)
    const mine = !local.ownerId || local.ownerId === state.user.id
    const drop = async () => {
      localList.splice(localList.indexOf(local), 1)
      await db[table].delete(local.id)
    }
    if (!remote) {
      if (mine && local.syncedAt) await drop() // deleted on another device
      else if (mine) await push(local) // never synced: upload
      else if (local.syncedBy === state.user.id) await drop() // shared with me, access revoked
      // else: data of another account that used this browser earlier, leave it alone
    } else if (state.roles[local.id] === 'viewer' || (remote.updatedAt || '') > (local.updatedAt || '')) {
      Object.assign(local, remote) // viewers always take the cloud version
      await db[table].put(plain(local))
    } else if ((local.updatedAt || '') > (remote.updatedAt || '')) {
      await push(local)
    }
    if (remote && table === 'collections' && local.syncedBy !== state.user.id) {
      local.syncedBy = state.user.id
      await db[table].put(plain(local))
    }
    remoteById.delete(local.id)
  }
  // remote-only items
  for (const remote of remoteById.values()) {
    if (remote.isGlobal && remote.updatedAt) {
      // adopted global (possibly modified above) -> push the merged version
      localList.unshift(remote)
      await push(remote)
      continue
    }
    if (table === 'collections') remote.syncedBy = state.user.id
    localList.push(remote)
    await db[table].put(plain(remote))
  }
}

export async function signOut() {
  await flushAllActivity()
  await supabase?.auth.signOut()
  state.roles = {}
}

// ---- Activity log -------------------------------------------------------
// Entries are computed by diffing the last logged tree against what was just
// pushed, at most once per ACTIVITY_DELAY per collection (and on Ctrl+S / tab hide).

const activityBase = new Map() // collectionId -> items at last log flush
const pendingLogs = new Map() // collectionId -> extra entries (create/import/publish/members)

function queueLogs(colId, entries) {
  if (!entries.length) return
  pendingLogs.set(colId, [...(pendingLogs.get(colId) || []), ...entries])
  scheduleActivity(colId)
}

function scheduleActivity(colId) {
  if (!supabase || !state.user) return
  debounce('activity:' + colId, ACTIVITY_DELAY, () => flushActivity(colId))
}

async function flushActivity(colId) {
  clearTimeout(timers.get('activity:' + colId))
  timers.delete('activity:' + colId)
  const col = state.collections.find((c) => c.id === colId)
  if (!col || !state.user || !col.syncedAt || !canEdit(col)) return
  const extra = pendingLogs.get(colId) || []
  const base = activityBase.get(colId)
  const diff = base ? diffTrees(base, col.items) : []
  const rows = [...extra, ...diff].map((e) => ({ ...e, collection_id: colId, actor_id: state.user.id, actor_email: state.user.email }))
  if (!rows.length) return
  const { error } = await supabase.from('activity_logs').insert(rows)
  if (error) {
    console.warn('activity log failed', error)
    return
  }
  pendingLogs.delete(colId)
  activityBase.set(colId, clone(col.items))
}

export async function flushAllActivity() {
  if (!supabase || !state.user) return
  const ids = [...timers.keys()].filter((k) => k.startsWith('activity:')).map((k) => k.slice(9))
  await Promise.all(ids.map(flushActivity))
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushAllActivity())
}

export async function fetchActivity(colId, limit = 100) {
  await flushActivity(colId)
  const { data, error } = await supabase.from('activity_logs').select('*').eq('collection_id', colId).order('created_at', { ascending: false }).limit(limit)
  if (error) throw error
  return data
}

// ---- Collaboration ------------------------------------------------------

export async function listMembers(colId) {
  const { data, error } = await supabase.rpc('list_collection_members', { p_collection_id: colId })
  if (error) throw error
  return data
}

/** Invite by email, or change an existing member's role. */
export async function inviteMember(col, email, role) {
  await ensureSynced(col)
  const { error } = await supabase.rpc('invite_collection_member', { p_collection_id: col.id, p_email: email, p_role: role })
  if (error) throw error
  queueLogs(col.id, [{ action: 'ADD_MEMBER', target_name: email, metadata: { role } }])
}

export async function removeMember(col, member) {
  const { error } = await supabase.from('collection_members').delete().eq('collection_id', col.id).eq('user_id', member.user_id)
  if (error) throw error
  queueLogs(col.id, [{ action: 'REMOVE_MEMBER', target_name: member.email, metadata: {} }])
}

async function ensureSynced(col) {
  if (!supabase || !state.user) throw new Error('Sign in first')
  if (!col.syncedAt || col.updatedAt > col.syncedAt) {
    await flushTimers('sync:col:' + col.id)
    await pushCollection(col)
  }
}

// ---- Publish docs -------------------------------------------------------

export async function getPublished(colId) {
  const { data, error } = await supabase.from('published_docs').select('slug, published_at').eq('collection_id', colId).maybeSingle()
  if (error) throw error
  return data
}

export async function publishDocs(col, slug) {
  await ensureSynced(col)
  const snap = buildDocsSnapshot(col)
  const { error } = await supabase.from('published_docs').upsert({
    collection_id: col.id,
    owner_id: state.user.id,
    slug,
    name: snap.name,
    description: snap.description,
    data: { items: snap.items },
    published_at: new Date().toISOString(),
  })
  if (error) {
    if (error.code === '23505') throw new Error(`The address /docs/${slug} is already taken. Choose another slug.`)
    throw error
  }
  col.isPublic = true
  col.publicSlug = slug
  touchCollection(col)
  queueLogs(col.id, [{ action: 'PUBLISH_DOCS', target_name: col.name, metadata: { slug } }])
}

export async function unpublishDocs(col) {
  const { error } = await supabase.from('published_docs').delete().eq('collection_id', col.id)
  if (error) throw error
  col.isPublic = false
  touchCollection(col)
  queueLogs(col.id, [{ action: 'UNPUBLISH_DOCS', target_name: col.name, metadata: {} }])
}

export const docsUrl = (slug) => `${location.origin}/docs/${slug}`
export const docsPreviewUrl = (colId) => `${location.origin}/docs/preview/${colId}`

// ---- Mock URL -----------------------------------------------------------

export function mockUrl(collectionId, sampleId) {
  return `${location.origin}/mock/${collectionId}/${sampleId}`
}
