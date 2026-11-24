// Build the public, read-only documentation snapshot of a collection.
// Literal credentials are replaced with placeholders; {{variables}} are kept as-is
// (their values live in environments, which are never published).
import { clone } from './model.js'
import { applyInheritance } from './resolve.js'

const ONLY_VARS = /^\s*(\{\{[^{}]+\}\}\s*)*$/
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-csrf-token)$/i

/** Keep values made only of {{vars}}; hide anything else. */
const hide = (value, placeholder) => (!value || ONLY_VARS.test(value) ? value : placeholder)

export function sanitizeRequest(req) {
  const r = clone(req)
  if (r.auth) {
    if (r.auth.bearer) r.auth.bearer.token = hide(r.auth.bearer.token, '<token>')
    if (r.auth.basic) r.auth.basic.password = hide(r.auth.basic.password, '<password>')
    if (r.auth.apikey) r.auth.apikey.value = hide(r.auth.apikey.value, '<api-key>')
  }
  delete r.authSourceId
  for (const h of r.headers || []) if (SENSITIVE_HEADER.test(h.key)) h.value = hide(h.value, '<redacted>')
  for (const p of r.params || []) if (/^(api_?key|access_token|token|key|secret)$/i.test(p.key)) p.value = hide(p.value, '<redacted>')
  if (r.url) r.url = r.url.replace(/([?&](?:api_?key|access_token|token|key|secret)=)([^&#]*)/gi, (m, k, v) => k + hide(decodeURIComponent(v), '<redacted>'))
  // protocol settings: hide literal Socket.IO auth payloads; the .proto source is not published
  if (r.socketio?.auth) r.socketio.auth = hide(r.socketio.auth, '<auth payload>')
  if (r.grpc) delete r.grpc.proto
  // drop things that only matter inside the editor
  delete r.extract
  // keep only enabled rows
  r.params = (r.params || []).filter((x) => x.enabled !== false)
  r.headers = (r.headers || []).filter((x) => x.enabled !== false).map(({ source, sourceId, ...h }) => h)
  return r
}

/** Requests are published as they are sent: inherited auth and headers are filled in. */
function sanitizeItems(items, ancestors) {
  return items.map((n) => {
    if (n.type !== 'folder') return sanitizeRequest(applyInheritance(n, ancestors))
    const { auth, headers, ...folder } = n // folder settings are already applied to its requests
    return { ...clone({ ...folder, items: [] }), items: sanitizeItems(n.items, [...ancestors, n]) }
  })
}

export function buildDocsSnapshot(collection) {
  return {
    name: collection.name,
    description: collection.description || '',
    items: sanitizeItems(collection.items, [collection]),
  }
}

export function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'api-docs'
  )
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/
