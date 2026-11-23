// Local-first storage (IndexedDB via Dexie). Everything works without login.
import Dexie from 'dexie'

export const db = new Dexie('curlion')

const SCHEMA = {
  collections: 'id, updatedAt',
  environments: 'id, updatedAt',
  history: '++id, ts',
  tombstones: 'id', // { id, table } rows deleted locally that still need a remote delete
  meta: 'key', // { key, value } misc settings (active env, mode, last request...)
}
db.version(1).stores(SCHEMA)
// v2: workspaces ({ id, name, isPersonal, ownerId }); collections, environments and history
// entries carry a workspaceId (not indexed: lists are small and kept in memory)
db.version(2).stores({ ...SCHEMA, workspaces: 'id' })

// Database names used by earlier versions of the app, newest first
// (PostLite -> Echo -> Beacon -> Curlion). The newest one that exists already holds the data
// migrated from the ones before it, so only that one is copied.
const LEGACY_NAMES = ['beacon', 'echo', 'postlite']

/**
 * Copy data from the pre-rename database, once. Rows already in this database win,
 * except an empty auto-created Globals env, which is replaced by the old one.
 */
export async function migrateLegacyDb() {
  if (await getMeta('legacyMigrated')) return false
  let legacyName = null
  for (const name of LEGACY_NAMES) {
    if (await Dexie.exists(name)) {
      legacyName = name
      break
    }
  }
  if (!legacyName) {
    await setMeta('legacyMigrated', true)
    return false
  }
  const legacy = new Dexie(legacyName)
  legacy.version(1).stores(SCHEMA)
  try {
    const old = Object.fromEntries(await Promise.all(db.tables.map(async (t) => [t.name, await legacy.table(t.name).toArray()])))
    await db.transaction('rw', db.tables, async () => {
      const addMissing = async (table, rows, key = 'id') => {
        const have = new Set(await db.table(table).toCollection().primaryKeys())
        await db.table(table).bulkPut(rows.filter((r) => !have.has(r[key])))
      }
      const oldGlobal = old.environments.find((e) => e.isGlobal)
      const curGlobal = (await db.environments.toArray()).find((e) => e.isGlobal)
      if (oldGlobal && curGlobal && curGlobal.id !== oldGlobal.id) {
        if (curGlobal.variables?.length) old.environments = old.environments.filter((e) => e !== oldGlobal)
        else await db.environments.delete(curGlobal.id)
      }
      await addMissing('collections', old.collections)
      await addMissing('environments', old.environments)
      await addMissing('tombstones', old.tombstones)
      await db.history.bulkAdd(old.history.map(({ id, ...h }) => h))
      await addMissing('meta', old.meta, 'key')
      await db.meta.put({ key: 'legacyMigrated', value: true })
    })
    return true
  } finally {
    legacy.close()
  }
}

export async function getMeta(key, fallback = null) {
  const row = await db.meta.get(key)
  return row ? row.value : fallback
}

export function setMeta(key, value) {
  return db.meta.put({ key, value })
}
