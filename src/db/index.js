// Local-first storage (IndexedDB via Dexie). Everything works without login.
import Dexie from 'dexie'

export const db = new Dexie('echo')

const SCHEMA = {
  collections: 'id, updatedAt',
  environments: 'id, updatedAt',
  history: '++id, ts',
  tombstones: 'id', // { id, table } rows deleted locally that still need a remote delete
  meta: 'key', // { key, value } misc settings (active env, mode, last request...)
}
db.version(1).stores(SCHEMA)

const LEGACY_NAME = 'postlite' // database name before the rename to Echo

/**
 * Copy data from the pre-rename database, once. Rows already in this database win,
 * except an empty auto-created Globals env, which is replaced by the old one.
 */
export async function migrateLegacyDb() {
  if (await getMeta('legacyMigrated')) return false
  if (!(await Dexie.exists(LEGACY_NAME))) {
    await setMeta('legacyMigrated', true)
    return false
  }
  const legacy = new Dexie(LEGACY_NAME)
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
