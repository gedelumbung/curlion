import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

/** null when Supabase is not configured: the app then runs local-only. */
export const supabase = url && key ? createClient(url, key) : null

// ---- Row mappers (local camelCase <-> Postgres snake_case) -------------

export const collectionToRow = (c, ownerId) => ({
  id: c.id,
  owner_id: c.ownerId || ownerId,
  workspace_id: c.workspaceId,
  name: c.name,
  description: c.description || null,
  is_public: !!c.isPublic,
  public_slug: c.publicSlug || null,
  tree_data: { items: c.items, auth: c.auth || null, headers: c.headers || [] }, // collection-level auth / headers ride along with the tree
  updated_at: c.updatedAt,
})

export const rowToCollection = (r) => ({
  id: r.id,
  ownerId: r.owner_id,
  workspaceId: r.workspace_id,
  name: r.name,
  description: r.description || '',
  isPublic: r.is_public,
  publicSlug: r.public_slug,
  items: r.tree_data?.items || [],
  auth: r.tree_data?.auth || { type: 'none' },
  headers: r.tree_data?.headers || [],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  syncedAt: r.updated_at,
})

export const environmentToRow = (e, ownerId) => ({
  id: e.id,
  owner_id: ownerId,
  workspace_id: e.isGlobal ? null : e.workspaceId,
  name: e.name,
  is_global: !!e.isGlobal,
  variables: e.variables,
  updated_at: e.updatedAt,
})

export const rowToEnvironment = (r) => ({
  id: r.id,
  ownerId: r.owner_id,
  workspaceId: r.is_global ? null : r.workspace_id,
  name: r.name,
  isGlobal: r.is_global,
  variables: r.variables || [],
  updatedAt: r.updated_at,
  syncedAt: r.updated_at,
})

export const rowToWorkspace = (r) => ({
  id: r.id,
  name: r.name,
  isPersonal: r.is_personal,
  ownerId: r.owner_id,
  createdAt: r.created_at,
})
