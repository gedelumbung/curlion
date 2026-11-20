// Global app store: state, persistence (IndexedDB) and cloud sync (Supabase).
import { computed, reactive, toRaw, watch } from 'vue'
import { db, getMeta, migrateLegacyDb, setMeta } from './db/index.js'
import { clone, findNode, newCollection, newEnvironment, newFolder, newRequest, reId, uid } from './lib/model.js'
import { buildScope, getByPath } from './lib/variables.js'
import { resolveRequest } from './lib/resolve.js'
import { AGENT_DEFAULT_PORT, pingAgent, sendRequest } from './lib/http.js'
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
  envCurrent: {}, // this user's current values: envId -> varId -> value (browser only, never synced)
  activeEnvId: null,
  mode: 'direct', // direct | proxy | agent
  agent: { port: AGENT_DEFAULT_PORT, status: 'unknown', version: null }, // Beacon Agent on this computer
  active: null, // { collectionId, requestId }
  tabs: [], // open request tabs: { collectionId, requestId, preview }
  drafts: {}, // requestId -> working copy edited in its tab; saved into the collection on Save
  unsavedPrompt: null, // { name, index, total, showIgnoreAll, resolve } for the close-tab dialog
  expanded: {}, // folder/collection id -> bool
  search: '',
  responses: {}, // requestId -> response (kept per request for this session)
  pending: {}, // requestId -> true while that request is in flight
  errors: {}, // requestId -> error message of its last send
  history: [],
  user: null,
  authReady: !supabase, // true once the Supabase session (if any) has been checked
  sync: { status: supabase ? 'signed-out' : 'local', message: '', lastAt: null },
  toasts: [],
})

export const cloudEnabled = !!supabase

// dev-only handle for debugging in the browser console
if (import.meta.env?.DEV && typeof window !== "undefined") window.__beacon = { state }

// ---- Derived ------------------------------------------------------------

export const globalEnv = computed(() => state.environments.find((e) => e.isGlobal))
export const activeEnv = computed(() => state.environments.find((e) => e.id === state.activeEnvId && !e.isGlobal) || null)
export const scope = computed(() => buildScope(globalEnv.value, activeEnv.value, state.envCurrent))

export const activeCollection = computed(() => state.collections.find((c) => c.id === state.active?.collectionId) || null)
/** The request shown in the editor: its unsaved working copy (draft), else the saved node. */
export const activeRequest = computed(() => {
  const col = activeCollection.value
  if (!col) return null
  const hit = findNode(col.items, state.active.requestId)
  if (hit?.node.type !== 'request') return null
  return state.drafts[hit.node.id] || hit.node
})
export const activeResponse = computed(() => (activeRequest.value ? state.responses[activeRequest.value.id] || null : null))
export const activeLoading = computed(() => !!(activeRequest.value && state.pending[activeRequest.value.id]))
export const activeError = computed(() => (activeRequest.value ? state.errors[activeRequest.value.id] || null : null))

/** Open tabs resolved to their collection + request (tabs whose request no longer exists are skipped). */
export const openTabs = computed(() =>
  state.tabs.flatMap((tab) => {
    const col = state.collections.find((c) => c.id === tab.collectionId)
    const hit = col && findNode(col.items, tab.requestId)
    if (hit?.node.type !== 'request') return []
    const draft = state.drafts[hit.node.id]
    return [{ tab, col, req: draft || hit.node, dirty: !!draft && json(draft) !== json(hit.node) }]
  }),
)
export const isDirty = (requestId) => openTabs.value.some((t) => t.tab.requestId === requestId && t.dirty)

/**
 * Team workspace: every signed-in user can see and edit every collection.
 * 'owner' = created it (can delete it and publish its docs), 'editor' = anyone else.
 * Local-only and not-yet-synced collections count as owner.
 */
export function roleOf(col) {
  if (!col || !col.ownerId || !state.user) return 'owner'
  return col.ownerId === state.user.id ? 'owner' : 'editor'
}
export const canEdit = (col) => !!col

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
/** Ctrl/⌘+S and the Save button: save the active request's edits, then store and sync everything. */
export async function saveNow() {
  if (state.active) saveRequest(state.active.requestId)
  const draftsTimer = timers.has('save:drafts')
  await flushTimers('save:')
  if (draftsTimer) persistDrafts() // re-arm: flushTimers only cancels
  await db.transaction('rw', db.collections, db.environments, async () => {
    await db.collections.bulkPut(state.collections.map(plain))
    await db.environments.bulkPut(state.environments.map(plain))
  })
  await setMeta('envCurrent', clone(toRaw(state.envCurrent)))
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
  state.envCurrent = (await getMeta('envCurrent', {})) || {}
  cols.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
  state.collections = cols
  state.environments = envs
  state.history = history
  state.activeEnvId = activeEnvId
  state.mode = mode
  state.expanded = expanded || {}
  state.agent.port = Number(await getMeta('agentPort', AGENT_DEFAULT_PORT)) || AGENT_DEFAULT_PORT
  if (mode === 'agent') watchAgent()

  await moveSecretsToCurrentValues()

  if (!state.environments.some((e) => e.isGlobal)) {
    const g = newEnvironment('Globals', true)
    state.environments.unshift(g)
    await db.environments.put(plain(g))
  }

  const exists = (t) => t && findNode(state.collections.find((c) => c.id === t.collectionId)?.items || [], t.requestId)
  if (!state.tabs.length) state.tabs = (savedTabs || []).filter(exists)
  if (!state.active && exists(active)) state.active = active
  if (state.active && !state.tabs.some((t) => t.requestId === state.active.requestId)) {
    state.tabs.push({ ...state.active, preview: false })
  }
  saveTabs()
  // restore unsaved edits, then give every open tab its working copy
  const savedDrafts = (await getMeta('drafts', {})) || {}
  for (const t of state.tabs) {
    const found = findRequest(t.requestId, t.collectionId)
    if (!found) continue
    draftBase.set(t.requestId, json(found.node))
    state.drafts[t.requestId] = savedDrafts[t.requestId] || clone(toRaw(found.node))
  }

  if (supabase) {
    // With Supabase configured the app is sign-in only: resolve the session before showing anything.
    const { data } = await supabase.auth.getSession()
    await setUser(data.session?.user || null)
    supabase.auth.onAuthStateChange((_event, session) => setUser(session?.user || null))
  }
  state.authReady = true
  state.ready = true
}

// ---- Settings -----------------------------------------------------------

export function setActiveEnv(id) {
  state.activeEnvId = id
  setMeta('activeEnvId', id)
}
export function setMode(mode) {
  state.mode = mode
  setMeta('mode', mode)
  if (mode === 'agent') watchAgent()
}

// ---- Beacon Agent ---------------------------------------------------------
// Polled while Agent mode is selected so the header can show whether it is running.

let agentTimer = null
export async function checkAgent() {
  const r = await pingAgent(state.agent.port)
  state.agent.status = r.ok ? 'online' : 'offline'
  state.agent.version = r.ok ? r.version : null
  return r.ok
}
function watchAgent() {
  checkAgent()
  clearInterval(agentTimer)
  agentTimer = setInterval(() => (state.mode === 'agent' ? checkAgent() : clearInterval(agentTimer)), 10_000)
}
export function setAgentPort(port) {
  state.agent.port = Number(port) || AGENT_DEFAULT_PORT
  setMeta('agentPort', state.agent.port)
  checkAgent()
}
/** Open a collection/folder in the sidebar and remember it across reloads. */
function expand(id) {
  if (state.expanded[id]) return
  state.expanded[id] = true
  setMeta('expanded', { ...state.expanded })
}
export function toggleExpanded(id, value) {
  state.expanded[id] = value ?? !state.expanded[id]
  setMeta('expanded', { ...state.expanded })
}
// ---- Drafts (unsaved request edits) ----------------------------------------
// Each open tab edits a working copy of its request. Edits stay local (and survive a
// reload) until the user saves; only then do they reach the collection, the cloud and
// the activity log. Structural changes (add/rename/move/delete) still apply right away.

// read through the reactive proxy (not toRaw) so computed values such as `dirty` track edits
const json = (o) => JSON.stringify(o)
const draftBase = new Map() // requestId -> JSON of the saved request the draft started from

function findRequest(requestId, collectionId) {
  const cols = collectionId ? state.collections.filter((c) => c.id === collectionId) : state.collections
  for (const col of cols) {
    const hit = findNode(col.items, requestId)
    if (hit?.node.type === 'request') return { col, node: hit.node }
  }
  return null
}

function ensureDraft(requestId, collectionId) {
  if (state.drafts[requestId]) return
  const found = findRequest(requestId, collectionId)
  if (!found) return
  state.drafts[requestId] = clone(toRaw(found.node))
  draftBase.set(requestId, json(found.node))
}

/** Keep unsaved drafts in IndexedDB so they survive a reload (debounced). */
export function persistDrafts() {
  debounce('save:drafts', SAVE_DELAY, () => {
    const dirty = {}
    for (const t of openTabs.value) if (t.dirty) dirty[t.tab.requestId] = plain(state.drafts[t.tab.requestId])
    setMeta('drafts', dirty)
  })
}

/** Save a tab's draft into its collection (then it is stored, synced and logged). */
export function saveRequest(requestId = state.active?.requestId) {
  const draft = state.drafts[requestId]
  const found = draft && findRequest(requestId)
  if (!found) return false
  const copy = clone(toRaw(draft))
  for (const k of Object.keys(found.node)) if (!(k in copy)) delete found.node[k]
  Object.assign(found.node, copy)
  draftBase.set(requestId, json(found.node))
  touchCollection(found.col)
  keepTab(requestId)
  persistDrafts()
  return true
}

/** "Save as Sample" from a response: saved right away, without saving other draft edits. */
export function addSampleNow(requestId, sample) {
  const found = findRequest(requestId)
  if (!found) return
  const draft = state.drafts[requestId]
  const wasClean = draft && json(draft) === json(found.node)
  found.node.samples.push(clone(sample))
  if (draft) {
    draft.samples.push(clone(sample))
    if (wasClean) draftBase.set(requestId, json(found.node))
  }
  touchCollection(found.col)
  persistDrafts()
}

/** Throw away a tab's unsaved edits. */
function discardDraft(requestId) {
  delete state.drafts[requestId]
  draftBase.delete(requestId)
}

/** After sync brought newer versions, refresh drafts the user has not edited. */
function refreshCleanDrafts() {
  for (const id of Object.keys(state.drafts)) {
    const found = findRequest(id)
    if (!found) continue
    const saved = json(found.node)
    if (json(state.drafts[id]) === draftBase.get(id) && saved !== draftBase.get(id)) {
      state.drafts[id] = clone(toRaw(found.node))
      draftBase.set(id, saved)
    }
  }
}

/** Ask what to do with unsaved changes (rendered by UnsavedDialog.vue). */
function askUnsaved(prompt) {
  return new Promise((resolve) => (state.unsavedPrompt = { ...prompt, resolve }))
}
export function answerUnsaved(choice) {
  const p = state.unsavedPrompt
  state.unsavedPrompt = null
  p?.resolve(choice)
}

const IGNORE_ALL_AFTER = 3 // warnings shown one by one before "Ignore all" is offered

/**
 * Close tabs the way the user asked (× button, middle-click, tab menu): unsaved tabs
 * are confirmed one by one; after IGNORE_ALL_AFTER warnings an "Ignore all" button
 * discards the rest. Cancel keeps every tab open. Returns false when cancelled.
 */
export async function requestCloseTabs(requestIds) {
  const dirty = requestIds.filter(isDirty)
  const save = []
  for (let i = 0; i < dirty.length; i++) {
    const id = dirty[i]
    const tab = openTabs.value.find((t) => t.tab.requestId === id)
    const choice = await askUnsaved({ name: tab?.req.name || 'this request', index: i + 1, total: dirty.length, showIgnoreAll: i >= IGNORE_ALL_AFTER })
    if (choice === 'cancel') return false
    if (choice === 'ignoreAll') break
    if (choice === 'save') save.push(id)
  }
  for (const id of save) saveRequest(id)
  closeTabs((t) => requestIds.includes(t.requestId))
  return true
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
  ensureDraft(requestId, collectionId)
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
  for (const t of state.tabs) {
    if (kept.includes(t)) continue
    if (state.pending[t.requestId]) cancel(t.requestId)
    discardDraft(t.requestId) // unsaved edits of closed tabs are dropped (callers save first)
  }
  if (activeClosed || !state.active) {
    // nearest surviving tab to the right of the old position, else to the left
    const after = state.tabs.slice(activeIdx + 1).find((t) => kept.includes(t))
    const before = state.tabs.slice(0, Math.max(activeIdx, 0)).reverse().find((t) => kept.includes(t))
    const next = after || before
    state.active = next ? { collectionId: next.collectionId, requestId: next.requestId } : null
  }
  state.tabs = kept
  saveTabs()
  persistDrafts()
}

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
  expand(col.id)
  persistCollection(col)
  return col
}

export function addCollection(col) {
  state.collections.push(col)
  expand(col.id)
  persistCollection(col)
  return col
}

export async function deleteCollection(id) {
  const i = state.collections.findIndex((c) => c.id === id)
  if (i === -1) return
  if (roleOf(state.collections[i]) !== 'owner') return // only the creator can delete a collection
  const [col] = state.collections.splice(i, 1)
  closeTabs((t) => t.collectionId === id)
  await db.collections.delete(id)
  if (col.syncedAt) {
    await logEvent('DELETE_COLLECTION', { collectionId: id, collectionName: col.name, targetName: col.name, metadata: { requests: countRequests(col.items) } })
    await db.tombstones.put({ id, table: 'collections' })
  }
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
  expand(parentId || col.id)
  expand(f.id)
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
  expand(parentId || col.id)
  touchCollection(col)
  openRequest(col.id, req.id)
  return req
}

export function renameNode(col, id, name) {
  if (id === col.id) {
    if (col.name !== name && col.syncedAt) queueLogs(col.id, [{ action: 'RENAME_COLLECTION', target_name: name, metadata: { from: col.name, to: name } }])
    col.name = name
  } else {
    const hit = findNode(col.items, id)
    if (hit) {
      const draft = state.drafts[id]
      const wasClean = draft && json(draft) === json(hit.node)
      hit.node.name = name
      if (draft) {
        draft.name = name // keep the tab title in step
        if (wasClean) draftBase.set(id, json(hit.node))
      }
    }
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

// ---- Current values (per user, this browser only) -----------------------

function saveEnvCurrent() {
  debounce('save:envCurrent', SAVE_DELAY, () => setMeta('envCurrent', clone(toRaw(state.envCurrent))))
}

/** Set this user's current value of a variable (empty string clears it). */
export function setCurrentValue(envId, varId, value) {
  const map = (state.envCurrent[envId] ||= {})
  if (value === '' || value === undefined) delete map[varId]
  else map[varId] = value
  saveEnvCurrent()
}

/**
 * Environments used to be private, so secret values were stored as the synced value.
 * Now that environments are shared, move those values into this browser's current
 * values (once) so they are never uploaded for everyone to see.
 */
async function moveSecretsToCurrentValues() {
  if (await getMeta('secretsMovedToCurrent')) return
  const now = new Date().toISOString()
  for (const env of state.environments) {
    if (env.isGlobal) continue
    let moved = false
    for (const v of env.variables) {
      if (v.isSecret && v.value) {
        ;(state.envCurrent[env.id] ||= {})[v.id] = v.value
        v.value = ''
        moved = true
      }
    }
    if (moved) {
      env.updatedAt = now
      await db.environments.put(plain(env))
    }
  }
  await setMeta('envCurrent', clone(toRaw(state.envCurrent)))
  await setMeta('secretsMovedToCurrent', true)
}

/** Environments are shared; only their creator (or anyone, before first sync) can delete them. */
export const canDeleteEnv = (env) => !!env && !env.isGlobal && (!env.ownerId || !state.user || env.ownerId === state.user.id)

export function addEnvironment(env) {
  state.environments.push(env)
  persistEnvironment(env)
}

export async function deleteEnvironment(id) {
  const i = state.environments.findIndex((e) => e.id === id)
  if (i === -1 || !canDeleteEnv(state.environments[i])) return
  const [env] = state.environments.splice(i, 1)
  delete state.envCurrent[id]
  saveEnvCurrent()
  if (state.activeEnvId === id) setActiveEnv(null)
  await db.environments.delete(id)
  if (env.syncedAt) await db.tombstones.put({ id, table: 'environments' })
  scheduleSync('tombstones', 'all')
}

/**
 * Post-response extraction: store the value as this user's *current value* of the variable
 * in the active environment (or Globals). Values never go into the shared environment;
 * a missing variable is added to it with an empty initial value so teammates see its name.
 */
export function setVariable(key, value) {
  const env = activeEnv.value || globalEnv.value
  let v = env.variables.find((x) => x.key === key)
  if (!v) {
    env.variables.push((v = { id: uid(), key, value: '', enabled: true, isSecret: /token|secret|password|key/i.test(key) }))
    touchEnvironment(env)
  }
  setCurrentValue(env.id, v.id, value)
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
      throw new Error('localhost cannot be reached through the cloud proxy. Use Agent mode (runs requests from your computer), or Direct mode with CORS enabled on your local server.')
    }
    const res = await sendRequest(resolved, { mode: state.mode, agentPort: state.agent.port, download, signal: controller.signal })
    if (state.mode === 'agent') state.agent.status = 'online'
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

async function setUser(user) {
  const prev = state.user?.id
  if (!user) {
    state.user = null
    state.sync.status = 'signed-out'
    return
  }
  if (prev === user.id) {
    state.user = { id: user.id, email: user.email }
    return
  }
  // Local data belongs to one account. If a different account signs in on this
  // browser (e.g. the previous session expired), start from a clean slate.
  const lastUserId = await getMeta('lastUserId')
  if (lastUserId && lastUserId !== user.id) await clearLocalData()
  await setMeta('lastUserId', user.id)
  state.user = { id: user.id, email: user.email }
  syncAll()
}

/** Remove the signed-in account's data from this browser (on sign-out / account switch). */
async function clearLocalData() {
  for (const id of [...controllers.keys()]) cancel(id)
  await flushTimers('') // drop pending debounced saves/syncs of the old data
  await db.transaction('rw', db.collections, db.environments, db.history, db.tombstones, async () => {
    await Promise.all([db.collections.clear(), db.environments.clear(), db.history.clear(), db.tombstones.clear()])
  })
  await Promise.all(['tabs', 'active', 'activeEnvId', 'lastUserId', 'envCurrent', 'drafts'].map((k) => db.meta.delete(k)))
  draftBase.clear()
  activityBase.clear()
  pendingLogs.clear()
  const globals = newEnvironment('Globals', true)
  await db.environments.put(plain(globals))
  Object.assign(state, {
    collections: [],
    environments: [globals],
    envCurrent: {},
    drafts: {},
    unsavedPrompt: null,
    history: [],
    tabs: [],
    active: null,
    activeEnvId: null,
    responses: {},
    pending: {},
    errors: {},
  })
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
  const row = environmentToRow(plain(env), env.ownerId || state.user.id)
  // Other people's (shared) environments may be updated but not inserted (RLS).
  const { error } =
    env.ownerId && env.ownerId !== state.user.id
      ? await supabase.from('environments').update(row).eq('id', env.id)
      : await supabase.from('environments').upsert(row)
  if (error) throw error
  env.ownerId ||= state.user.id
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
    refreshCleanDrafts()
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
      else await drop() // someone else's collection that was deleted by its creator
    } else if ((remote.updatedAt || '') > (local.updatedAt || '')) {
      Object.assign(local, remote)
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

/** Upload pending changes, sign out, then remove this account's data from the browser. */
export async function signOut() {
  if (state.user) {
    try {
      await db.transaction('rw', db.collections, db.environments, async () => {
        await db.collections.bulkPut(state.collections.map(plain))
        await db.environments.bulkPut(state.environments.map(plain))
      })
      await syncAll()
      await flushAllActivity()
    } catch (err) {
      console.warn('Final sync before sign-out failed', err)
    }
  }
  const unsaved = openTabs.value.filter((t) => t.dirty).length
  if (unsaved && !confirm(`${unsaved} request(s) have unsaved changes. Sign out and discard them?`)) return
  if (state.sync.status === 'error' && !confirm(`Some changes could not be synced (${state.sync.message}). Sign out anyway? They will be lost.`)) return
  await logEvent('SIGN_OUT')
  // 'local' drops this device's session even when offline (the refresh token is still revoked server-side)
  await supabase?.auth.signOut({ scope: 'local' })
  await clearLocalData()
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
  const rows = [...extra, ...diff].map((e) => ({ ...e, collection_id: colId, collection_name: col.name, actor_id: state.user.id, actor_email: state.user.email }))
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

/** Write one activity entry right away (account events, collection deletion). */
async function logEvent(action, { user = state.user, collectionId = null, collectionName = null, targetName, metadata = {} } = {}) {
  if (!supabase || !user) return
  const { error } = await supabase.from('activity_logs').insert({
    action,
    target_name: targetName ?? user.email,
    collection_id: collectionId,
    collection_name: collectionName,
    actor_id: user.id,
    actor_email: user.email,
    metadata,
  })
  if (error) console.warn('activity log failed', error)
}

/** Called by the login form after a successful email/password sign-in. */
export const logSignIn = (user) => logEvent('SIGN_IN', { user })

/**
 * Activity across the whole workspace, newest first (activity dashboard).
 * filters: { actorId, collectionId, action, since (ISO), search, before (ISO, for paging) }
 */
export async function fetchAllActivity(filters = {}, limit = 200) {
  await flushAllActivity()
  let q = supabase.from('activity_logs').select('*').order('created_at', { ascending: false }).limit(limit)
  if (filters.actorId) q = q.eq('actor_id', filters.actorId)
  if (filters.collectionId === '__account__') q = q.is('collection_id', null).in('action', ['SIGN_IN', 'SIGN_OUT'])
  else if (filters.collectionId) q = q.eq('collection_id', filters.collectionId)
  if (filters.action) q = q.eq('action', filters.action)
  if (filters.since) q = q.gte('created_at', filters.since)
  if (filters.before) q = q.lt('created_at', filters.before)
  if (filters.search?.trim()) {
    const term = filters.search.trim().replace(/[%,()]/g, ' ')
    q = q.or(`target_name.ilike.%${term}%,collection_name.ilike.%${term}%,actor_email.ilike.%${term}%`)
  }
  const { data, error } = await q
  if (error) throw error
  return data
}

export async function fetchActivity(colId, limit = 100) {
  await flushActivity(colId)
  const { data, error } = await supabase.from('activity_logs').select('*').eq('collection_id', colId).order('created_at', { ascending: false }).limit(limit)
  if (error) throw error
  return data
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
