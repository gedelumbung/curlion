// Turn a stored request + variable scope into a concrete, ready-to-send request.
// Shared by the HTTP engine and the code snippet generator.
import { interpolate } from './variables.js'
import { appendQuery } from './url.js'
import { contentTypeFor } from './model.js'

/** Files picked for form-data rows live only in memory (they cannot be synced). */
export const fileStore = new Map() // rowId -> File

const enabled = (list) => (list || []).filter((r) => r.enabled !== false && r.key !== '')

function hasHeader(headers, name) {
  return headers.some((h) => h.key.toLowerCase() === name.toLowerCase())
}

/**
 * @returns {{ method, url, headers: {key,value}[], body: null | {mode, raw?, contentType?, fields?} }}
 */
export function resolveRequest(req, scope, opts = {}) {
  const I = (s) => interpolate(s ?? '', scope, opts)

  let url = I(req.url).trim()
  // default to http:// like Postman, unless the URL still starts with an unresolved {{var}}
  if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith('{{')) url = 'http://' + url

  const headers = enabled(req.headers).map((h) => ({ key: I(h.key), value: I(h.value) }))

  // Auth
  const a = req.auth || { type: 'none' }
  if (a.type === 'bearer' && a.bearer?.token) {
    if (!hasHeader(headers, 'authorization')) headers.push({ key: 'Authorization', value: `Bearer ${I(a.bearer.token)}` })
  } else if (a.type === 'basic') {
    const raw = `${I(a.basic?.username)}:${I(a.basic?.password)}`
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(raw)))
    if (!hasHeader(headers, 'authorization')) headers.push({ key: 'Authorization', value: `Basic ${b64}` })
  } else if (a.type === 'apikey' && a.apikey?.key) {
    if (a.apikey.in === 'query') url = appendQuery(url, I(a.apikey.key), I(a.apikey.value))
    else headers.push({ key: I(a.apikey.key), value: I(a.apikey.value) })
  }

  // Body (GET/HEAD cannot carry one in fetch)
  let body = null
  const b = req.body || { mode: 'none' }
  if (!['GET', 'HEAD'].includes(req.method) && b.mode !== 'none') {
    if (b.mode === 'raw') {
      body = { mode: 'raw', raw: I(b.raw), contentType: contentTypeFor[b.rawType] || 'text/plain' }
      if (!hasHeader(headers, 'content-type')) headers.push({ key: 'Content-Type', value: body.contentType })
    } else if (b.mode === 'urlencoded') {
      body = { mode: 'urlencoded', fields: enabled(b.urlencoded).map((f) => ({ key: I(f.key), value: I(f.value) })) }
      if (!hasHeader(headers, 'content-type')) headers.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded' })
    } else if (b.mode === 'form-data') {
      body = {
        mode: 'form-data',
        fields: enabled(b.formData).map((f) => ({
          key: I(f.key),
          value: f.type === 'file' ? '' : I(f.value),
          type: f.type || 'text',
          file: f.type === 'file' ? fileStore.get(f.id) : undefined,
          fileName: f.type === 'file' ? fileStore.get(f.id)?.name || f.fileName || 'file' : undefined,
        })),
      }
      // Content-Type (with boundary) is set by the browser for FormData
    }
  }

  return { method: req.method, url, headers, body }
}

export function urlencode(fields) {
  return fields.map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`).join('&')
}
