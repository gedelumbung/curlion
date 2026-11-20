// Postman Collection v2.1 importer / exporter.
import { kv, newCollection, newEnvironment, newFolder, newRequest, newSample, uid } from './model.js'
import { parseQuery } from './url.js'

export class ImportError extends Error {}

const toKv = (list) =>
  (Array.isArray(list) ? list : []).map((h) => kv(h.key ?? '', h.value ?? '', { description: descText(h.description), enabled: !h.disabled }))

const descText = (d) => (typeof d === 'string' ? d : d?.content || '')

const authVal = (arr, key) => (Array.isArray(arr) ? arr.find((x) => x.key === key)?.value : arr?.[key]) ?? ''

function mapAuth(pmAuth, req) {
  if (!pmAuth || pmAuth.type === 'noauth') return
  if (pmAuth.type === 'bearer') {
    req.auth.type = 'bearer'
    req.auth.bearer.token = String(authVal(pmAuth.bearer, 'token'))
  } else if (pmAuth.type === 'basic') {
    req.auth.type = 'basic'
    req.auth.basic.username = String(authVal(pmAuth.basic, 'username'))
    req.auth.basic.password = String(authVal(pmAuth.basic, 'password'))
  } else if (pmAuth.type === 'apikey') {
    req.auth.type = 'apikey'
    req.auth.apikey.key = String(authVal(pmAuth.apikey, 'key'))
    req.auth.apikey.value = String(authVal(pmAuth.apikey, 'value'))
    req.auth.apikey.in = authVal(pmAuth.apikey, 'in') === 'query' ? 'query' : 'header'
  }
}

function mapUrl(url) {
  if (!url) return { raw: '', params: [] }
  if (typeof url === 'string') {
    const q = url.indexOf('?')
    return { raw: url, params: q === -1 ? [] : parseQuery(url.slice(q + 1)) }
  }
  let raw = url.raw
  if (!raw) {
    const host = Array.isArray(url.host) ? url.host.join('.') : url.host || ''
    const path = Array.isArray(url.path) ? url.path.join('/') : url.path || ''
    raw = `${url.protocol ? url.protocol + '://' : ''}${host}${path ? '/' + path : ''}`
  }
  const params = url.query ? toKv(url.query) : parseQuery(raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '')
  return { raw, params }
}

function mapBody(pmBody, req) {
  if (!pmBody || !pmBody.mode) return
  if (pmBody.mode === 'raw') {
    req.body.mode = 'raw'
    req.body.raw = pmBody.raw || ''
    const lang = pmBody.options?.raw?.language
    req.body.rawType = ['json', 'xml', 'html', 'text'].includes(lang) ? lang : /^\s*[[{]/.test(req.body.raw) ? 'json' : 'text'
  } else if (pmBody.mode === 'urlencoded') {
    req.body.mode = 'urlencoded'
    req.body.urlencoded = toKv(pmBody.urlencoded)
  } else if (pmBody.mode === 'formdata') {
    req.body.mode = 'form-data'
    req.body.formData = (pmBody.formdata || []).map((f) =>
      f.type === 'file'
        ? kv(f.key, '', { type: 'file', fileName: Array.isArray(f.src) ? f.src[0] : f.src || '', enabled: !f.disabled })
        : kv(f.key, f.value ?? '', { type: 'text', enabled: !f.disabled }),
    )
  } else if (pmBody.mode === 'graphql') {
    req.body.mode = 'raw'
    req.body.rawType = 'json'
    req.body.raw = JSON.stringify({ query: pmBody.graphql?.query || '', variables: tryJson(pmBody.graphql?.variables) || {} }, null, 2)
  }
}

const tryJson = (s) => {
  try {
    return typeof s === 'string' ? JSON.parse(s) : s
  } catch {
    return null
  }
}

function mapItem(item, path) {
  if (Array.isArray(item.item)) {
    const folder = newFolder(item.name || 'Folder')
    folder.items = item.item.map((child, i) => mapItem(child, `${path}.item[${i}]`))
    return folder
  }
  if (!item.request) throw new ImportError(`Item "${item.name || path}" has neither "item" nor "request".`)
  const pr = typeof item.request === 'string' ? { url: item.request, method: 'GET' } : item.request
  const req = newRequest(item.name || 'Request')
  req.description = descText(pr.description)
  req.method = String(pr.method || 'GET').toUpperCase()
  const { raw, params } = mapUrl(pr.url)
  req.url = raw
  req.params = params
  req.headers = toKv(pr.header)
  mapAuth(pr.auth, req)
  mapBody(pr.body, req)
  req.samples = (item.response || []).map((r) =>
    newSample(r.name || 'Example', {
      status: r.code || 200,
      headers: toKv(r.header),
      body: r.body || '',
    }),
  )
  return req
}

/**
 * @returns {{ collection, environment: object|null, warnings: string[] }}
 */
export function importPostman(json) {
  let data = json
  if (typeof json === 'string') {
    try {
      data = JSON.parse(json)
    } catch (e) {
      throw new ImportError('File is not valid JSON: ' + e.message)
    }
  }
  if (!data || typeof data !== 'object') throw new ImportError('File is empty or not a JSON object.')
  if (data.collection && data.collection.info) data = data.collection // Postman API export wrapper
  if (!data.info) throw new ImportError('Missing "info" object. This does not look like a Postman collection.')
  if (!Array.isArray(data.item)) throw new ImportError('Missing "item" array. This does not look like a Postman collection.')

  const warnings = []
  const schema = data.info.schema || ''
  if (schema && !schema.includes('v2.1') && !schema.includes('v2.0')) {
    warnings.push(`Schema "${schema}" is not v2.1; import may be incomplete.`)
  }

  const col = newCollection(data.info.name || 'Imported Collection')
  col.description = descText(data.info.description)
  col.items = data.item.map((it, i) => mapItem(it, `item[${i}]`))

  // Collection-level auth -> apply to requests without their own auth
  if (data.auth && data.auth.type !== 'noauth') {
    const apply = (items) =>
      items.forEach((n) => {
        if (n.type === 'folder') apply(n.items)
        else if (n.auth.type === 'none') mapAuth(data.auth, n)
      })
    apply(col.items)
    warnings.push('Collection-level auth was copied into each request without its own auth.')
  }
  if (data.event?.length || JSON.stringify(data.item).includes('"event"')) {
    warnings.push('Pre-request/test scripts are not supported and were skipped. Use the Extract tab instead.')
  }

  let environment = null
  if (Array.isArray(data.variable) && data.variable.length) {
    environment = newEnvironment(`${col.name} variables`)
    environment.variables = data.variable.map((v) => ({ id: uid(), key: v.key, value: String(v.value ?? ''), enabled: !v.disabled, isSecret: v.type === 'secret' }))
  }

  return { collection: col, environment, warnings }
}

// ---- Export -------------------------------------------------------------

const outKv = (list) => list.map((r) => ({ key: r.key, value: r.value, ...(r.description ? { description: r.description } : {}), ...(r.enabled === false ? { disabled: true } : {}) }))

function exportAuth(a) {
  if (!a || a.type === 'none') return undefined
  if (a.type === 'bearer') return { type: 'bearer', bearer: [{ key: 'token', value: a.bearer.token, type: 'string' }] }
  if (a.type === 'basic')
    return { type: 'basic', basic: [{ key: 'username', value: a.basic.username, type: 'string' }, { key: 'password', value: a.basic.password, type: 'string' }] }
  if (a.type === 'apikey')
    return {
      type: 'apikey',
      apikey: [{ key: 'key', value: a.apikey.key, type: 'string' }, { key: 'value', value: a.apikey.value, type: 'string' }, { key: 'in', value: a.apikey.in, type: 'string' }],
    }
}

function exportBody(b) {
  if (!b || b.mode === 'none') return undefined
  if (b.mode === 'raw') return { mode: 'raw', raw: b.raw, options: { raw: { language: b.rawType } } }
  if (b.mode === 'urlencoded') return { mode: 'urlencoded', urlencoded: outKv(b.urlencoded) }
  if (b.mode === 'form-data')
    return {
      mode: 'formdata',
      formdata: b.formData.map((f) => (f.type === 'file' ? { key: f.key, type: 'file', src: f.fileName || '' } : { key: f.key, value: f.value, type: 'text', ...(f.enabled === false ? { disabled: true } : {}) })),
    }
}

function exportNode(n) {
  if (n.type === 'folder') return { name: n.name, item: n.items.map(exportNode) }
  const request = {
    method: n.method,
    ...(n.description ? { description: n.description } : {}),
    header: outKv(n.headers),
    url: { raw: n.url, query: outKv(n.params) },
  }
  const auth = exportAuth(n.auth)
  if (auth) request.auth = auth
  const body = exportBody(n.body)
  if (body) request.body = body
  return {
    name: n.name,
    request,
    response: n.samples.map((s) => ({
      name: s.name,
      originalRequest: { method: n.method, url: n.url },
      code: Number(s.status),
      header: outKv(s.headers),
      body: s.body,
    })),
  }
}

export function exportPostman(collection) {
  return {
    info: {
      _postman_id: collection.id,
      name: collection.name,
      description: collection.description || '',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: collection.items.map(exportNode),
  }
}
