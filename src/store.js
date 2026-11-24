// Global app store: state, persistence (IndexedDB) and cloud sync (Supabase).
import { computed, reactive, toRaw, watch } from 'vue'
import { db, getMeta, migrateLegacyDb, setMeta } from './db/index.js'
import { clone, ensureProtocol, findNode, folderPath, newCollection, newEnvironment, newFolder, newRequest, protocolOf, reId, uid } from './lib/model.js'
import { buildScope, getByPath, interpolate } from './lib/variables.js'
import { paramsFromUrl } from './lib/url.js'
import { applyInheritance, resolveRequest } from './lib/resolve.js'
import {
  OAUTH_CHANNEL,
  authorizationCodeParams,
  authorizeUrl,
  clientCredentialsParams,
  defaultRedirectUri,
  isExpired,
  parseRedirect,
  parseTokenResponse,
  pkcePair,
  randomString,
  refreshParams,
  tokenRequest,
} from './lib/oauth.js'
import { AGENT_DEFAULT_PORT, agentBase, pingAgent, sendRequest } from './lib/http.js'
import { connectSocketIo, connectWsAgent, connectWsDirect } from './lib/realtime.js'
import { GRPC_STATUS, decodeMessage, encodeMessage, findMethod, parseProto } from './lib/grpc.js'
import { indentString } from './lib/settings.js'
import { collectionToRow, environmentToRow, rowToCollection, rowToEnvironment, rowToWorkspace, supabase } from './lib/supabase.js'
import { countRequests, diffTrees } from './lib/activity.js'
import { buildDocsSnapshot } from './lib/publish.js'

const SAVE_DELAY = 300 // IndexedDB write debounce
const SYNC_DELAY = 3000 // Supabase debounced auto-save (PRD §7.1)
const HISTORY_LIMIT = 100 // per workspace
const ACTIVITY_DELAY = 60_000 // collapse edits into one activity entry per minute

/** The "Team" workspace created by migration 008: holds everything shared before workspaces existed. */
export const TEAM_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'

export const state = reactive({
  ready: false,
  workspaces: [], // { id, name, isPersonal, ownerId }
  workspaceId: null, // current workspace: the sidebar, environments, history and activity show only its items
  collections: [],
  environments: [],
  envCurrent: {}, // this user's current values: envId -> varId -> value (browser only, never synced)
  oauthTokens: {}, // OAuth 2.0 tokens: id of the request / folder / collection whose auth got them -> token (browser only, never synced)
  oauthPending: null, // { key, startedAt } while an authorization code sign-in is open in a popup
  activeEnvId: null,
  mode: 'direct', // direct | proxy | agent
  agent: { port: AGENT_DEFAULT_PORT, status: 'unknown', version: null }, // Curlion Agent on this computer
  active: null, // { collectionId, requestId }
  tabs: [], // open tabs: { collectionId, requestId, preview, kind? } (kind 'collection' = overview, requestId 'col:<id>')
  drafts: {}, // requestId -> working copy edited in its tab; saved into the collection on Save
  unsavedPrompt: null, // { name, index, total, showIgnoreAll, resolve } for the close-tab dialog
  varPopover: null, // { name, rect } inline {{variable}} editor opened by clicking a variable
  savePrompt: null, // { requestId, name, resolve } "Save to collection" dialog for history tabs
  expanded: {}, // folder/collection id -> bool
  search: '',
  responses: {}, // requestId -> response (kept per request for this session)
  conns: {}, // requestId -> WebSocket / Socket.IO connection state and message log
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
if (import.meta.env?.DEV && typeof window !== "undefined") window.__curlion = { state }

// ---- Derived ------------------------------------------------------------

const inWorkspace = (x) => x.workspaceId === state.workspaceId
export const currentWorkspace = computed(() => state.workspaces.find((w) => w.id === state.workspaceId) || null)
/** Collections of the current workspace. */
export const wsCollections = computed(() => state.collections.filter(inWorkspace))
/** Environments of the current workspace (Globals not included: they apply in every workspace). */
export const wsEnvironments = computed(() => state.environments.filter((e) => !e.isGlobal && inWorkspace(e)))
/** History of the current workspace (entries from before workspaces existed show everywhere). */
export const wsHistory = computed(() => state.history.filter((h) => !h.workspaceId || inWorkspace(h)))

export const globalEnv = computed(() => state.environments.find((e) => e.isGlobal))
export const activeEnv = computed(() => state.environments.find((e) => e.id === state.activeEnvId && !e.isGlobal && inWorkspace(e)) || null)
export const scope = computed(() => buildScope(globalEnv.value, activeEnv.value, state.envCurrent))

export const activeCollection = computed(() => state.collections.find((c) => c.id === state.active?.collectionId) || null)
/** The request shown in the editor: its unsaved working copy (draft), else the saved node. */
export const activeRequest = computed(() => {
  if (isHistoryId(state.active?.requestId)) return state.drafts[state.active.requestId] || null
  const col = activeCollection.value
  if (!col) return null
  const hit = findNode(col.items, state.active.requestId)
  if (hit?.node.type !== 'request') return null
  return state.drafts[hit.node.id] || hit.node
})
export const activeResponse = computed(() => (activeRequest.value ? state.responses[activeRequest.value.id] || null : null))
export const activeLoading = computed(() => !!(activeRequest.value && state.pending[activeRequest.value.id]))
export const activeError = computed(() => (activeRequest.value ? state.errors[activeRequest.value.id] || null : null))

/** Collection overview tabs reuse the tab list with a synthetic id. */
export const collectionTabId = (collectionId) => `col:${collectionId}`
export const isCollectionTab = (t) => t?.kind === 'collection'
/** The collection whose overview tab is active, if any. */
export const activeOverview = computed(() =>
  state.active?.requestId === collectionTabId(state.active?.collectionId) ? activeCollection.value : null,
)

/**
 * History tabs (like Postman): a request opened from History is a copy of what was sent,
 * not part of any collection until saved. id 'hist:<history entry id>'.
 */
export const isHistoryId = (id) => typeof id === 'string' && id.startsWith('hist:')
export const isHistoryTab = (t) => t?.kind === 'history'

/** Open tabs resolved to their collection + request (tabs whose request no longer exists are skipped). */
export const openTabs = computed(() =>
  state.tabs.flatMap((tab) => {
    if (isHistoryTab(tab)) {
      const draft = state.drafts[tab.requestId]
      return draft ? [{ tab, col: null, req: draft, dirty: json(draft) !== draftBase.get(tab.requestId) }] : []
    }
    const col = state.collections.find((c) => c.id === tab.collectionId)
    if (isCollectionTab(tab)) return col ? [{ tab, col, req: null, dirty: false }] : []
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
  if (isHistoryId(state.active?.requestId)) return saveHistoryTab(state.active.requestId)
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
  const [workspaces, workspaceId, cols, envs, history, activeEnvId, mode, active, expanded] = await Promise.all([
    db.workspaces.toArray(),
    getMeta('workspaceId'),
    db.collections.toArray(),
    db.environments.toArray(),
    db.history.orderBy('ts').reverse().toArray(),
    getMeta('activeEnvId'),
    getMeta('mode', 'direct'),
    getMeta('active'),
    getMeta('expanded', {}),
  ])
  const savedTabs = await getMeta('tabs', [])
  state.envCurrent = (await getMeta('envCurrent', {})) || {}
  state.oauthTokens = (await getMeta('oauthTokens', {})) || {}
  cols.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
  state.collections = cols
  state.environments = envs
  state.history = history
  state.workspaces = sortWorkspaces(workspaces)
  state.workspaceId = workspaceId
  if (!supabase) await ensureLocalPersonalWorkspace()
  await placeUnassigned(supabase ? TEAM_WORKSPACE_ID : state.workspaces.find((w) => w.isPersonal)?.id)
  if (!state.workspaces.some((w) => w.id === state.workspaceId)) state.workspaceId = defaultWorkspaceId()
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

  const exists = (t) => {
    if (t && isHistoryId(t.requestId)) return true // resolved below from its history entry or saved draft
    const col = t && state.collections.find((c) => c.id === t.collectionId)
    if (!col) return false
    return t.requestId === collectionTabId(col.id) || !!findNode(col.items, t.requestId)
  }
  if (!state.tabs.length) state.tabs = (savedTabs || []).filter(exists)
  if (!state.active && exists(active)) state.active = active
  if (state.active && !state.tabs.some((t) => t.requestId === state.active.requestId)) {
    state.tabs.push({ ...state.active, preview: false })
  }
  saveTabs()
  // restore unsaved edits, then give every open tab its working copy
  const savedDrafts = (await getMeta('drafts', {})) || {}
  for (const t of state.tabs) {
    if (isHistoryTab(t)) {
      const h = state.history.find((x) => `hist:${x.id}` === t.requestId)
      const original = h ? requestFromHistory(h) : null
      const draft = savedDrafts[t.requestId] || original
      if (!draft) continue // history entry gone and nothing edited: tab is dropped
      state.drafts[t.requestId] = draft
      draftBase.set(t.requestId, json(original || draft))
      continue
    }
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

// ---- Workspaces -----------------------------------------------------------
// Like Postman: collections, environments, history and the activity log belong to a
// workspace. Team workspaces are visible to every signed-in user; each user also has a
// personal "My Workspace" that only they can see. Globals apply in every workspace.

const sortWorkspaces = (list) =>
  [...list].sort((a, b) => (b.isPersonal ? 1 : 0) - (a.isPersonal ? 1 : 0) || (a.id === TEAM_WORKSPACE_ID ? -1 : b.id === TEAM_WORKSPACE_ID ? 1 : 0) || a.name.localeCompare(b.name))

function defaultWorkspaceId() {
  const list = state.workspaces
  return list.find((w) => w.id === TEAM_WORKSPACE_ID)?.id || list.find((w) => w.isPersonal)?.id || list[0]?.id || (supabase ? TEAM_WORKSPACE_ID : null)
}

/** Local-only mode: the browser keeps its own workspaces, starting with "My Workspace". */
async function ensureLocalPersonalWorkspace() {
  if (state.workspaces.some((w) => w.isPersonal)) return
  const ws = { id: uid(), name: 'My Workspace', isPersonal: true, ownerId: null, createdAt: new Date().toISOString() }
  state.workspaces = sortWorkspaces([...state.workspaces, ws])
  await db.workspaces.put(plain(ws))
}

/** Data saved before workspaces existed goes into the given workspace. */
async function placeUnassigned(workspaceId) {
  if (!workspaceId) return
  for (const col of state.collections) {
    if (col.workspaceId) continue
    col.workspaceId = workspaceId
    await db.collections.put(plain(col))
  }
  for (const env of state.environments) {
    if (env.isGlobal || env.workspaceId) continue
    env.workspaceId = workspaceId
    await db.environments.put(plain(env))
  }
}

/** Fetch the workspaces this user can see; create their personal one on first sign-in. */
async function syncWorkspaces() {
  const fetchAll = async () => {
    const { data, error } = await supabase.from('workspaces').select('*')
    if (error) throw error
    return data.map(rowToWorkspace)
  }
  let list = await fetchAll()
  if (!list.some((w) => w.isPersonal && w.ownerId === state.user.id)) {
    const { error } = await supabase.from('workspaces').insert({ name: 'My Workspace', is_personal: true, owner_id: state.user.id })
    if (error && error.code !== '23505') throw error // 23505: another tab created it first
    list = await fetchAll()
  }
  await setWorkspaces(list)
}

async function setWorkspaces(list) {
  state.workspaces = sortWorkspaces(list)
  await db.transaction('rw', db.workspaces, async () => {
    await db.workspaces.clear()
    await db.workspaces.bulkPut(state.workspaces.map(plain))
  })
  if (!state.workspaces.some((w) => w.id === state.workspaceId)) {
    // the current workspace was deleted by its creator (or is not visible any more)
    closeTabs(() => true)
    await enterWorkspace(defaultWorkspaceId())
  }
}

async function enterWorkspace(id) {
  state.workspaceId = id
  await setMeta('workspaceId', id)
  const envId = ((await getMeta('envByWorkspace', {})) || {})[id] || null
  state.activeEnvId = state.environments.some((e) => e.id === envId && !e.isGlobal && e.workspaceId === id) ? envId : null
  await setMeta('activeEnvId', state.activeEnvId)
}

/**
 * Switch to another workspace. Its tabs are closed first (unsaved changes are confirmed
 * like closing tabs). Returns false when the user cancels.
 */
export async function switchWorkspace(id) {
  if (id === state.workspaceId) return true
  if (!state.workspaces.some((w) => w.id === id)) return false
  if (!(await requestCloseTabs(state.tabs.map((t) => t.requestId)))) return false
  await enterWorkspace(id)
  return true
}

/** Every user can create team workspaces; the new one becomes the current workspace. */
export async function createWorkspace(name) {
  name = name.trim() || 'New Workspace'
  let ws
  if (supabase && state.user) {
    const { data, error } = await supabase.from('workspaces').insert({ name, owner_id: state.user.id }).select().single()
    if (error) throw error
    ws = rowToWorkspace(data)
    logEvent('CREATE_WORKSPACE', { targetName: name })
  } else {
    ws = { id: uid(), name, isPersonal: false, ownerId: null, createdAt: new Date().toISOString() }
  }
  state.workspaces = sortWorkspaces([...state.workspaces, ws])
  await db.workspaces.put(plain(ws))
  await switchWorkspace(ws.id)
  return ws
}

export async function renameWorkspace(id, name) {
  const ws = state.workspaces.find((w) => w.id === id)
  name = name.trim()
  if (!ws || !name || name === ws.name) return
  const from = ws.name
  if (supabase && state.user) {
    const { error } = await supabase.from('workspaces').update({ name, updated_at: new Date().toISOString() }).eq('id', id)
    if (error) throw error
    if (!ws.isPersonal) logEvent('RENAME_WORKSPACE', { workspaceId: id, targetName: name, metadata: { from, to: name } })
  }
  ws.name = name
  state.workspaces = sortWorkspaces(state.workspaces)
  await db.workspaces.put(plain(ws))
}

/** Team workspaces can be deleted by their creator; My Workspace and "Team" cannot. */
export const canDeleteWorkspace = (ws) => !!ws && !ws.isPersonal && ws.id !== TEAM_WORKSPACE_ID && (!supabase || ws.ownerId === state.user?.id)

/** Deletes the workspace with all its collections and environments, for everyone. */
export async function deleteWorkspace(id) {
  const ws = state.workspaces.find((w) => w.id === id)
  if (!canDeleteWorkspace(ws)) return false
  if (state.workspaceId === id) {
    const next = state.workspaces.find((w) => w.id !== id && w.isPersonal)?.id || state.workspaces.find((w) => w.id !== id)?.id
    if (!next || !(await switchWorkspace(next))) return false
  }
  const cols = state.collections.filter((c) => c.workspaceId === id)
  const envs = state.environments.filter((e) => !e.isGlobal && e.workspaceId === id)
  // pending saves / syncs of its collections and environments must not re-create them
  for (const c of cols) for (const k of ['save:col:', 'sync:col:', 'activity:']) await flushTimers(k + c.id)
  for (const e of envs) for (const k of ['save:env:', 'sync:env:']) await flushTimers(k + e.id)
  if (supabase && state.user) {
    const { error } = await supabase.from('workspaces').delete().eq('id', id) // cascades to its collections and environments
    if (error) throw error
    logEvent('DELETE_WORKSPACE', { targetName: ws.name, metadata: { collections: cols.length, environments: envs.length } })
  }
  const colIds = new Set(cols.map((c) => c.id))
  const envIds = new Set(envs.map((e) => e.id))
  state.collections = state.collections.filter((c) => !colIds.has(c.id))
  state.environments = state.environments.filter((e) => !envIds.has(e.id))
  const histIds = state.history.filter((h) => h.workspaceId === id).map((h) => h.id)
  state.history = state.history.filter((h) => h.workspaceId !== id)
  state.workspaces = state.workspaces.filter((w) => w.id !== id)
  await db.transaction('rw', db.workspaces, db.collections, db.environments, db.history, db.tombstones, async () => {
    await db.workspaces.delete(id)
    await db.collections.bulkDelete([...colIds])
    await db.environments.bulkDelete([...envIds])
    await db.history.bulkDelete(histIds)
    await db.tombstones.bulkDelete([...colIds, ...envIds])
  })
  return true
}

// ---- Settings -----------------------------------------------------------

export function setActiveEnv(id) {
  state.activeEnvId = id
  setMeta('activeEnvId', id)
  // remembered per workspace, restored when switching back
  getMeta('envByWorkspace', {}).then((m) => setMeta('envByWorkspace', { ...(m || {}), [state.workspaceId]: id }))
}
export function setMode(mode) {
  state.mode = mode
  setMeta('mode', mode)
  if (mode === 'agent') watchAgent()
}

// ---- Curlion Agent ---------------------------------------------------------
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

/** Collection and folders above a request, outermost first ([] for history tabs). */
export function ancestorsFor(requestId, collectionId = state.active?.collectionId) {
  const found = findRequest(requestId, collectionId) || findRequest(requestId)
  if (!found) return []
  return [found.col, ...(folderPath(found.col.items, requestId) || [])]
}

/** The request as sent: auth and headers inherited from its folders and collection applied. */
export function withInheritance(req, collectionId) {
  return applyInheritance(req, ancestorsFor(req.id, collectionId))
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

/** Switch saved requests to "inherit" auth (open tabs without edits follow). */
export function makeRequestsInherit(col, requests) {
  for (const r of requests) r.auth = { ...(r.auth || {}), type: 'inherit' }
  touchCollection(col)
  refreshCleanDrafts()
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
  const keep = new Set()
  for (const id of save) {
    if (isHistoryId(id)) {
      if (!(await saveHistoryTab(id))) keep.add(id) // cancelled: leave that tab open
    } else saveRequest(id)
  }
  closeTabs((t) => requestIds.includes(t.requestId) && !keep.has(t.requestId))
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
export function openRequest(collectionId, requestId, { preview = false, kind } = {}) {
  const existing = state.tabs.find((t) => t.requestId === requestId)
  if (existing) {
    existing.collectionId = collectionId
    if (!preview) existing.preview = false
  } else {
    const tab = kind ? { collectionId, requestId, preview, kind } : { collectionId, requestId, preview }
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

/** Open a collection's overview tab (sidebar click on a collection), and expand it. */
export function openCollectionOverview(collectionId, { preview = true } = {}) {
  expand(collectionId)
  openRequest(collectionId, collectionTabId(collectionId), { preview, kind: 'collection' })
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
    if (realtime.has(t.requestId)) disconnectRealtime(t.requestId) // closing a tab ends its connection
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
  const col = { ...newCollection(name), workspaceId: state.workspaceId }
  state.collections.push(col)
  expand(col.id)
  persistCollection(col)
  return col
}

export function addCollection(col) {
  col.workspaceId ||= state.workspaceId
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
  closeTabs((t) => t.collectionId === col.id && !isCollectionTab(t) && !findNode(col.items, t.requestId))
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
  const env = { ...newEnvironment(name), workspaceId: state.workspaceId }
  state.environments.push(env)
  persistEnvironment(env)
  return env
}

// ---- Current values (per user, this browser only) -----------------------

function saveEnvCurrent() {
  debounce('save:envCurrent', SAVE_DELAY, () => setMeta('envCurrent', clone(toRaw(state.envCurrent))))
}

/** Open the inline variable editor below a clicked {{variable}} (see VarPopover.vue). */
export function openVarPopover(name, rect) {
  state.varPopover = { name, rect: { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width } }
}
export const closeVarPopover = () => (state.varPopover = null)

/** Add a new variable to an environment (from the inline editor). Returns the variable. */
export function addVariable(envId, key, value = '', isSecret = /token|secret|password|key/i.test(key)) {
  const env = state.environments.find((e) => e.id === envId)
  if (!env) return null
  const v = { id: uid(), key, value, enabled: true, isSecret }
  env.variables.push(v)
  touchEnvironment(env)
  return v
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
  if (!env.isGlobal) env.workspaceId ||= state.workspaceId
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


// ---- OAuth 2.0 ------------------------------------------------------------------
// Tokens are keyed by the id of the request, folder or collection whose auth settings got
// them, so every request inheriting that auth shares one token. They stay in this browser.

/** Key of the token used by a request (after applyInheritance). */
export const oauthKeyFor = (eff) => eff.authSourceId || eff.id

function saveOAuthTokens() {
  debounce('save:oauthTokens', SAVE_DELAY, () => setMeta('oauthTokens', clone(toRaw(state.oauthTokens))))
}

export function clearOAuthToken(key) {
  delete state.oauthTokens[key]
  saveOAuthTokens()
}

/** OAuth settings with {{variables}} replaced. */
function oauthConfig(auth) {
  const c = auth.oauth2 || {}
  const I = (v) => interpolate(v ?? '', scope.value).trim()
  return { ...c, authUrl: I(c.authUrl), tokenUrl: I(c.tokenUrl), clientId: I(c.clientId), clientSecret: I(c.clientSecret), scope: I(c.scope), audience: I(c.audience), redirectUri: I(c.redirectUri) || defaultRedirectUri() }
}

/** POST to the token endpoint (through the current send mode) and store the token. */
async function requestToken(key, cfg, params, previous = null) {
  if (!cfg.tokenUrl) throw new Error('OAuth 2.0: enter the Access Token URL in the Auth tab.')
  if (!cfg.clientId) throw new Error('OAuth 2.0: enter the Client ID in the Auth tab.')
  let res
  try {
    res = await sendRequest(tokenRequest(cfg, params), { mode: state.mode, agentPort: state.agent.port })
  } catch (e) {
    throw new Error(`Could not reach the token endpoint: ${e.message}`)
  }
  const token = parseTokenResponse(res, previous)
  state.oauthTokens[key] = token
  saveOAuthTokens()
  return token
}

export function refreshOAuthToken(auth, key) {
  const prev = state.oauthTokens[key]
  if (!prev?.refreshToken) throw new Error('This token has no refresh token. Get a new access token.')
  return requestToken(key, oauthConfig(auth), refreshParams(oauthConfig(auth), prev.refreshToken), prev)
}

let oauthWaiter = null // { state, verifier, redirectUri, cfg, key, resolve, reject, cleanup }

/** Authorization code: sign in through the provider in a popup, then exchange the code. */
async function authorizeWithPopup(auth, key) {
  const cfg = oauthConfig(auth)
  if (!cfg.authUrl) throw new Error('OAuth 2.0: enter the Auth URL in the Auth tab.')
  if (!cfg.clientId) throw new Error('OAuth 2.0: enter the Client ID in the Auth tab.')
  cancelOAuth()
  const st = randomString(16)
  const pkce = cfg.pkce !== false ? await pkcePair() : null
  let url
  try {
    url = authorizeUrl(cfg, { state: st, redirectUri: cfg.redirectUri, pkce })
  } catch {
    throw new Error(`OAuth 2.0: the Auth URL "${cfg.authUrl}" is not a valid URL.`)
  }
  const popup = window.open(url, 'curlion-oauth', 'popup,width=520,height=720')
  if (!popup) throw new Error('The browser blocked the sign-in window. Allow popups for this site and try again.')
  state.oauthPending = { key, startedAt: Date.now(), manual: cfg.redirectUri !== defaultRedirectUri() }
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(OAUTH_CHANNEL) : null
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Sign-in timed out.')), 5 * 60_000)
    const cleanup = () => {
      clearTimeout(timer)
      channel?.close()
      oauthWaiter = null
      state.oauthPending = null
    }
    oauthWaiter = { state: st, resolve, reject, cleanup }
    if (channel) channel.onmessage = (e) => e.data?.type === 'redirect' && completeOAuthRedirect(e.data.url)
  }).finally(() => oauthWaiter?.cleanup?.())
  try {
    popup.close()
  } catch {}
  return requestToken(key, cfg, authorizationCodeParams(cfg, { code, redirectUri: cfg.redirectUri, verifier: pkce?.verifier }))
}

/** Finish a pending sign-in from the URL the provider redirected to (callback page, or pasted by the user). */
export function completeOAuthRedirect(url) {
  if (!oauthWaiter) return false
  let r
  try {
    r = parseRedirect(url.trim())
  } catch {
    oauthWaiter.reject(new Error('That is not a URL.'))
    return true
  }
  if (r.error) oauthWaiter.reject(new Error(`Sign-in failed: ${r.error}`))
  else if (!r.code) oauthWaiter.reject(new Error('The redirect URL has no "code" parameter.'))
  else if (r.state !== oauthWaiter.state) oauthWaiter.reject(new Error('The redirect does not belong to this sign-in (state mismatch). Try again.'))
  else oauthWaiter.resolve(r.code)
  return true
}

export function cancelOAuth() {
  oauthWaiter?.reject(new Error('Sign-in cancelled.'))
}

/** "Get new access token": interactive for the authorization code grant. */
export function getNewOAuthToken(auth, key) {
  const cfg = oauthConfig(auth)
  if (cfg.grantType === 'client_credentials') return requestToken(key, cfg, clientCredentialsParams(cfg))
  return authorizeWithPopup(auth, key)
}

/**
 * A usable access token before sending: the stored one, refreshed when it has expired
 * (or when `force`), or a new one for client credentials. Authorization code tokens need the
 * user to sign in first (Auth tab).
 */
async function ensureOAuthToken(auth, key, { force = false, sourceName = '' } = {}) {
  const cfg = oauthConfig(auth)
  const tok = state.oauthTokens[key]
  if (tok && !force && !isExpired(tok)) return tok.accessToken
  if (tok?.refreshToken && cfg.autoRefresh !== false) {
    try {
      return (await requestToken(key, cfg, refreshParams(cfg, tok.refreshToken), tok)).accessToken
    } catch (e) {
      if (cfg.grantType !== 'client_credentials') throw new Error(`The access token expired and refreshing it failed (${e.message}). Get a new access token in the Auth tab${sourceName}.`)
    }
  }
  if (cfg.grantType === 'client_credentials') return (await requestToken(key, cfg, clientCredentialsParams(cfg))).accessToken
  if (tok && !force && cfg.autoRefresh === false) return tok.accessToken // expired, but refreshing is off: let the API decide
  throw new Error(tok ? `The access token expired. Get a new one in the Auth tab${sourceName}.` : `No OAuth 2.0 access token yet. Click "Get new access token" in the Auth tab${sourceName}.`)
}

/**
 * Turn a request into what is sent: inherited auth / headers applied, OAuth 2.0 token
 * fetched or refreshed when needed, {{variables}} resolved.
 * @returns {{ eff, resolved, oauth: { key, auth } | null }}
 */
export async function prepareRequest(req, { collectionId, forceToken = false } = {}) {
  const eff = applyInheritance(req, ancestorsFor(req.id, collectionId))
  let oauthToken
  let oauth = null
  if (eff.auth?.type === 'oauth2') {
    const source = eff.authSourceId ? ancestorsFor(req.id, collectionId).find((a) => a.id === eff.authSourceId) : null
    oauth = { key: oauthKeyFor(eff), auth: eff.auth }
    oauthToken = await ensureOAuthToken(eff.auth, oauth.key, { force: forceToken, sourceName: source ? ` of "${source.name}"` : '' })
  }
  return { eff, resolved: resolveRequest(eff, scope.value, { oauthToken }), oauth }
}

/** Whether a 401 is worth one retry with a fresh token (refresh token, or client credentials). */
function canRetryOAuth(oauth) {
  if (!oauth) return false
  const tok = state.oauthTokens[oauth.key]
  return oauth.auth.oauth2?.grantType === 'client_credentials' || (!!tok?.refreshToken && oauth.auth.oauth2?.autoRefresh !== false)
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
  const protocol = protocolOf(req)
  // WebSocket / Socket.IO: Send (Ctrl+Enter) connects, or sends the composed message when open
  if (protocol === 'ws' || protocol === 'socketio') {
    return state.conns[id]?.status === 'open' ? sendRealtime(id) : connectRealtime()
  }
  controllers.get(id)?.abort()
  const controller = new AbortController()
  controllers.set(id, controller)
  state.pending[id] = true
  delete state.errors[id]
  let resolved
  try {
    let oauth
    ;({ resolved, oauth } = await prepareRequest(req))
    if (protocol === 'grpc') {
      const res = await invokeGrpc(req, resolved, controller.signal)
      state.responses[id] = res
      addHistory(req, { method: 'GRPC', url: `${resolved.url}${res.grpcPath}` }, res)
      return
    }
    if (protocol === 'graphql') {
      try {
        JSON.parse(resolved.body.raw)
      } catch {
        throw new Error('Variables are not valid JSON (after replacing {{variables}}). Check the Variables tab.')
      }
    }
    if (state.mode === 'proxy' && /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(resolved.url)) {
      throw new Error('localhost cannot be reached through the cloud proxy. Use Agent mode (runs requests from your computer), or Direct mode with CORS enabled on your local server.')
    }
    let res = await sendRequest(resolved, { mode: state.mode, agentPort: state.agent.port, download, signal: controller.signal })
    // OAuth 2.0: the token may have been revoked or expired early; get a fresh one and retry once
    if (res.status === 401 && canRetryOAuth(oauth)) {
      ;({ resolved } = await prepareRequest(req, { forceToken: true }))
      res = await sendRequest(resolved, { mode: state.mode, agentPort: state.agent.port, download, signal: controller.signal })
    }
    if (state.mode === 'agent') state.agent.status = 'online'
    res.at = Date.now()
    res.extracted = runExtract(req, res)
    const prev = state.responses[id]?.downloadUrl
    if (prev && prev !== res.downloadUrl) URL.revokeObjectURL(prev)
    state.responses[id] = res
    if (res.saved === 'saved') toast(`Saved ${res.fileName}`, 'success', 2500)
    else if (res.saved === 'downloaded') toast(`Downloading ${res.fileName}…`, 'success', 2500)
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

// ---- gRPC (through the Curlion Agent) -------------------------------------------

async function invokeGrpc(req, resolved, signal) {
  ensureProtocol(req)
  const g = req.grpc
  if (state.mode !== 'agent') throw new Error('gRPC runs through the Curlion Agent. Switch to Agent mode in the header (and start the agent).')
  if (!g.proto.trim()) throw new Error('Add the service definition in the Proto tab first.')
  const parsed = await parseProto(g.proto)
  const method = findMethod(parsed, g.service, g.method)
  if (!method) throw new Error('Pick a service method (next to the address).')
  let json
  try {
    json = JSON.parse(interpolate(g.message || '{}', scope.value) || '{}')
  } catch (e) {
    throw new Error(`Message is not valid JSON: ${e.message}`)
  }
  const outgoing = method.requestStream ? (Array.isArray(json) ? json : [json]) : [json]
  const target = resolved.url.replace(/^grpcs?:\/\//, '').replace(/\/+$/, '')
  const tls = g.tls || /^grpcs:\/\//.test(resolved.url)
  const res = await fetch(`${agentBase(state.agent.port)}/grpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, tls, path: method.path, metadata: resolved.headers, messages: outgoing.map((m) => encodeMessage(parsed.root, method.requestType, m)) }),
    signal,
    targetAddressSpace: 'loopback',
  }).catch((e) => {
    if (e.name === 'AbortError') throw e
    throw new Error(`Could not reach the Curlion Agent on 127.0.0.1:${state.agent.port}. Start it (header → Agent) and try again.`)
  })
  if (!res.ok) throw new Error(`Agent: ${await res.text()}`)
  state.agent.status = 'online'
  const r = await res.json()
  const replies = r.messages.map((b64) => decodeMessage(parsed.root, method.responseType, b64))
  const body = method.responseStream ? replies : (replies[0] ?? null)
  const text = r.grpcStatus === 0 || body !== null ? JSON.stringify(body, null, indentString()) : ''
  return {
    grpc: true,
    grpcPath: method.path,
    status: r.grpcStatus ?? -1,
    statusText: r.grpcStatus === null ? `HTTP ${r.httpStatus}` : GRPC_STATUS[r.grpcStatus] || 'UNKNOWN',
    message: r.grpcMessage,
    time: r.time,
    size: r.messages.reduce((n, b) => n + Math.floor((b.length * 3) / 4), 0),
    headers: [...r.headers, ...r.trailers.map((t) => ({ ...t, trailer: true }))],
    contentType: 'application/json',
    body: r.grpcMessage && r.grpcStatus !== 0 ? `${r.grpcMessage}${text ? `\n\n${text}` : ''}` : text,
    json: r.grpcStatus === 0 ? body : undefined,
    binary: false,
    at: Date.now(),
  }
}

// ---- WebSocket / Socket.IO connections --------------------------------------------
// state.conns[requestId] = { status: 'connecting'|'open'|'closed', log: [...], protocol }

const realtime = new Map() // requestId -> { send, close }
const LOG_LIMIT = 500
let logSeq = 0

function logConn(id, entry) {
  const c = state.conns[id]
  if (!c) return
  c.log.push({ id: ++logSeq, ts: Date.now(), ...entry })
  if (c.log.length > LOG_LIMIT) c.log.splice(0, c.log.length - LOG_LIMIT)
}

/** Connect the active WebSocket / Socket.IO request. */
export async function connectRealtime() {
  const req = activeRequest.value
  if (!req) return
  ensureProtocol(req)
  const id = req.id
  const protocol = protocolOf(req)
  disconnectRealtime(id)
  const prev = state.conns[id]?.log || []
  let resolved
  try {
    ;({ resolved } = await prepareRequest(req))
  } catch (e) {
    state.conns[id] = { status: 'closed', protocol, log: prev }
    logConn(id, { dir: 'error', data: e.message })
    return
  }
  state.conns[id] = { status: 'connecting', protocol, log: prev }
  logConn(id, { dir: 'info', data: `Connecting to ${resolved.url}${state.mode === 'agent' && protocol === 'ws' ? ' (through the agent)' : ''}…` })
  const cb = {
    onOpen: ({ protocol: sub }) => {
      state.conns[id].status = 'open'
      state.conns[id].openedAt = Date.now()
      logConn(id, { dir: 'info', data: `Connected${sub ? ` · ${sub}` : ''}` })
    },
    onMessage: ({ event, data, binary }) => logConn(id, { dir: 'in', event, data, binary }),
    onInfo: (text) => logConn(id, { dir: 'info', data: text }),
    onError: (text) => logConn(id, { dir: 'error', data: text }),
    onClose: ({ code, reason }) => {
      if (!state.conns[id] || state.conns[id].status === 'closed') return
      state.conns[id].status = 'closed'
      realtime.delete(id)
      logConn(id, { dir: 'info', data: `Disconnected${code ? ` (${code}${reason ? `: ${reason}` : ''})` : reason ? ` (${reason})` : ''}` })
    },
  }
  try {
    if (protocol === 'ws') {
      const protocols = req.ws.protocols.split(',').map((p) => p.trim()).filter(Boolean)
      if (state.mode === 'agent') realtime.set(id, connectWsAgent({ url: resolved.url, protocols, headers: resolved.headers }, state.agent.port, cb))
      else {
        if (resolved.headers.length) logConn(id, { dir: 'info', data: 'Browsers cannot send custom headers on WebSocket connections; they are ignored. Use Agent mode to send them.' })
        realtime.set(id, connectWsDirect({ url: resolved.url, protocols }, cb))
      }
    } else {
      const s = req.socketio
      let auth
      if (s.auth.trim()) {
        try {
          auth = JSON.parse(interpolate(s.auth, scope.value))
        } catch {
          throw new Error('Auth payload is not valid JSON (Settings tab).')
        }
      }
      const transports = s.transports === 'polling' ? ['polling', 'websocket'] : ['websocket']
      if (resolved.headers.length && transports[0] === 'websocket') logConn(id, { dir: 'info', data: 'Custom headers are only sent with the long-polling transport (Settings tab).' })
      realtime.set(id, await connectSocketIo({ url: resolved.url, headers: resolved.headers, path: s.path, auth, transports }, cb))
    }
  } catch (e) {
    cb.onError(e.message)
    cb.onClose({ code: 0, reason: '' })
  }
}

export function disconnectRealtime(id = activeRequest.value?.id) {
  realtime.get(id)?.close()
}

/** Send the composed message (WebSocket) or emit the composed event (Socket.IO). */
export function sendRealtime(id = activeRequest.value?.id, override) {
  const req = activeRequest.value?.id === id ? activeRequest.value : state.drafts[id]
  const handle = realtime.get(id)
  if (!req || !handle || state.conns[id]?.status !== 'open') return
  ensureProtocol(req)
  if (protocolOf(req) === 'ws') {
    const text = interpolate(override ?? req.ws.message, scope.value)
    handle.send(text)
    logConn(id, { dir: 'out', data: text })
  } else {
    const s = req.socketio
    const raw = interpolate(override ?? s.args, scope.value).trim()
    let args = []
    if (raw) {
      try {
        const v = JSON.parse(raw)
        args = Array.isArray(v) ? v : [v]
      } catch {
        args = [raw] // plain text argument
      }
    }
    const event = interpolate(s.event || 'message', scope.value)
    handle.send({ event, args, ack: s.ack })
    logConn(id, { dir: 'out', event, data: args.length === 1 ? args[0] : args })
  }
}

export function clearConnLog(id) {
  if (state.conns[id]) state.conns[id].log = []
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
    workspaceId: state.workspaceId,
    requestId: req.id,
    collectionId: state.active?.collectionId,
    name: req.name,
    method: resolved.method,
    url: resolved.url,
    status: res.status,
    time: res.time,
    request: historySnapshot(req), // what was sent, with {{variables}} as written
  }
  const id = await db.history.add(entry)
  state.history.unshift({ ...entry, id })
  const extra = state.history.filter((h) => h.workspaceId === entry.workspaceId).slice(HISTORY_LIMIT)
  if (extra.length) {
    const drop = new Set(extra.map((e) => e.id))
    state.history = state.history.filter((h) => !drop.has(h.id))
    db.history.bulkDelete([...drop])
  }
}

/** The request as written (not resolved), without samples or picked files. */
function historySnapshot(req) {
  const { id, samples, ...rest } = clone(toRaw(req))
  return rest
}

/** Request for a history entry: its snapshot, or (older entries) one built from method + URL. */
function requestFromHistory(h) {
  const base = h.request ? clone(h.request) : newRequest(h.name || h.url, { method: h.method, url: h.url, params: paramsFromUrl(h.url || '', []) })
  return { ...newRequest(base.name), ...base, id: `hist:${h.id}`, samples: [] }
}

/** Sidebar History click: open what was sent in a history tab (preview), like Postman. */
export function openHistoryEntry(h, { preview = true } = {}) {
  const id = `hist:${h.id}`
  if (!state.drafts[id]) {
    const req = requestFromHistory(h)
    state.drafts[id] = req
    draftBase.set(id, json(req))
  }
  openRequest(null, id, { preview, kind: 'history' })
}

/**
 * Save a history tab into a collection (asks for the collection and name first).
 * The tab then becomes a normal request tab. Resolves false when cancelled.
 */
export async function saveHistoryTab(requestId) {
  const draft = state.drafts[requestId]
  if (!draft) return false
  const answer = await new Promise((resolve) => (state.savePrompt = { requestId, name: draft.name, resolve }))
  state.savePrompt = null
  if (!answer) return false
  const col = answer.collectionId === '__new__' ? createCollection(answer.newCollectionName || 'My Collection') : state.collections.find((c) => c.id === answer.collectionId)
  if (!col) return false
  const req = { ...clone(toRaw(draft)), id: uid(), name: answer.name || draft.name, samples: [] }
  const idx = state.tabs.findIndex((t) => t.requestId === requestId)
  addRequest(col, null, req) // stores, syncs, logs and opens it in a tab
  // put the new tab where the history tab was, and drop the history tab
  const newIdx = state.tabs.findIndex((t) => t.requestId === req.id)
  if (idx !== -1 && newIdx !== -1) {
    const [t] = state.tabs.splice(newIdx, 1)
    state.tabs.splice(idx, 0, t)
  }
  if (state.responses[requestId]) state.responses[req.id] = state.responses[requestId]
  closeTabs((t) => t.requestId === requestId)
  toast(`Saved to "${col.name}"`, 'success', 1800)
  return true
}
export function answerSavePrompt(answer) {
  state.savePrompt?.resolve(answer)
}

/** Clears the history shown in the current workspace. */
export async function clearHistory() {
  const ids = wsHistory.value.map((h) => h.id)
  const drop = new Set(ids)
  state.history = state.history.filter((h) => !drop.has(h.id))
  await db.history.bulkDelete(ids)
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
  for (const id of [...realtime.keys()]) disconnectRealtime(id)
  await flushTimers('') // drop pending debounced saves/syncs of the old data
  await db.transaction('rw', db.workspaces, db.collections, db.environments, db.history, db.tombstones, async () => {
    await Promise.all([db.workspaces.clear(), db.collections.clear(), db.environments.clear(), db.history.clear(), db.tombstones.clear()])
  })
  await Promise.all(['tabs', 'active', 'activeEnvId', 'envByWorkspace', 'workspaceId', 'lastUserId', 'envCurrent', 'drafts', 'oauthTokens'].map((k) => db.meta.delete(k)))
  draftBase.clear()
  activityBase.clear()
  pendingLogs.clear()
  const globals = newEnvironment('Globals', true)
  await db.environments.put(plain(globals))
  Object.assign(state, {
    workspaces: [],
    workspaceId: TEAM_WORKSPACE_ID,
    collections: [],
    environments: [globals],
    envCurrent: {},
    oauthTokens: {},
    oauthPending: null,
    drafts: {},
    unsavedPrompt: null,
    savePrompt: null,
    history: [],
    tabs: [],
    active: null,
    activeEnvId: null,
    responses: {},
    conns: {},
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
  col.workspaceId ||= state.workspaceId
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
  if (!env.isGlobal) env.workspaceId ||= state.workspaceId
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
    await syncWorkspaces()

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
    const workspaceGone = !!local.workspaceId && !state.workspaces.some((w) => w.id === local.workspaceId)
    if (remote) local.workspaceId = remote.workspaceId
    if (!remote) {
      if (workspaceGone) await drop() // its workspace was deleted
      else if (mine && local.syncedAt) await drop() // deleted on another device
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
async function logEvent(action, { user = state.user, collectionId = null, collectionName = null, workspaceId = null, targetName, metadata = {} } = {}) {
  if (!supabase || !user) return
  const { error } = await supabase.from('activity_logs').insert({
    action,
    workspace_id: workspaceId, // filled in from the collection by the database when null
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
 * Activity in the current workspace, newest first (activity dashboard). Team workspaces
 * also show account events (sign in / out, workspaces created or deleted); a personal
 * workspace shows only its own entries.
 * filters: { actorId, collectionId, action, since (ISO), search, before (ISO, for paging) }
 */
export async function fetchAllActivity(filters = {}, limit = 200) {
  await flushAllActivity()
  let q = supabase.from('activity_logs').select('*').order('created_at', { ascending: false }).limit(limit)
  const ws = currentWorkspace.value
  const wsFilter = ws?.isPersonal ? null : `workspace_id.eq.${state.workspaceId},workspace_id.is.null`
  if (!wsFilter) q = q.eq('workspace_id', state.workspaceId)
  if (filters.actorId) q = q.eq('actor_id', filters.actorId)
  if (filters.collectionId === '__account__') q = q.is('workspace_id', null)
  else if (filters.collectionId) q = q.eq('collection_id', filters.collectionId)
  if (filters.action) q = q.eq('action', filters.action)
  if (filters.since) q = q.gte('created_at', filters.since)
  if (filters.before) q = q.lt('created_at', filters.before)
  if (filters.search?.trim()) {
    const term = filters.search.trim().replace(/[%,()]/g, ' ')
    const searchFilter = `target_name.ilike.%${term}%,collection_name.ilike.%${term}%,actor_email.ilike.%${term}%`
    q = q.or(wsFilter && filters.collectionId !== '__account__' ? `and(or(${wsFilter}),or(${searchFilter}))` : searchFilter)
  } else if (wsFilter && filters.collectionId !== '__account__') {
    q = q.or(wsFilter)
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
