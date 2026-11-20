// Local-first storage (IndexedDB via Dexie). Everything works without login.
import Dexie from 'dexie'

export const db = new Dexie('postlite')

db.version(1).stores({
  collections: 'id, updatedAt',
  environments: 'id, updatedAt',
  history: '++id, ts',
  tombstones: 'id', // { id, table } rows deleted locally that still need a remote delete
  meta: 'key', // { key, value } misc settings (active env, mode, last request...)
})

export async function getMeta(key, fallback = null) {
  const row = await db.meta.get(key)
  return row ? row.value : fallback
}

export function setMeta(key, value) {
  return db.meta.put({ key, value })
}
