// OpenAPI 3.x / Swagger 2.0 importer (JSON or YAML) -> Curlion collection + environment.
//
// - Operations become requests, grouped into folders by their first tag.
// - The server URL becomes {{baseUrl}} in a new environment; path parameters become {{name}}.
// - Query and header parameters, request bodies and response samples get example values
//   (from `example(s)`, `default` or `enum`, else generated from the schema).
// - The global security requirement becomes the collection's auth (inherited by requests);
//   operations with other requirements get their own. Secrets become {{variables}}.
import { parse as parseYaml } from 'yaml'
import { AUTH_DEFAULTS, PROTOCOL_DEFAULTS, kv, newAuth, newCollection, newFolder, newRequest, newSample, uid } from './model.js'
import { ImportError } from './postman.js'

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']
const SECRET_VARS = new Set(['bearerToken', 'password', 'apiKey', 'clientSecret'])

/** Parse JSON or YAML text. */
export function parseSpecText(text) {
  const t = String(text || '').trim()
  if (!t) throw new ImportError('The file is empty.')
  if (t.startsWith('{')) {
    try {
      return JSON.parse(t)
    } catch (e) {
      throw new ImportError('File is not valid JSON: ' + e.message)
    }
  }
  try {
    return parseYaml(t, { maxAliasCount: 1000 })
  } catch (e) {
    throw new ImportError('File is not valid JSON or YAML: ' + e.message)
  }
}

export const isOpenApi = (o) => !!o && typeof o === 'object' && (typeof o.openapi === 'string' || typeof o.swagger === 'string')

/**
 * @param input spec object, or JSON / YAML text
 * @returns {{ collection, environment, warnings: string[] }}
 */
export function importOpenApi(input) {
  const spec = typeof input === 'string' ? parseSpecText(input) : input
  if (!isOpenApi(spec)) throw new ImportError('This does not look like an OpenAPI or Swagger file (no "openapi" or "swagger" field).')
  const v2 = typeof spec.swagger === 'string'
  if (v2 && !spec.swagger.startsWith('2')) throw new ImportError(`Swagger ${spec.swagger} is not supported (2.0 and OpenAPI 3.x are).`)
  if (!v2 && !/^3\./.test(spec.openapi)) throw new ImportError(`OpenAPI ${spec.openapi} is not supported (3.x and Swagger 2.0 are).`)

  const ctx = { spec, v2, warnings: new Set(), vars: new Map() }
  const info = spec.info || {}
  const col = newCollection(info.title || 'Imported API')
  col.importedFrom = 'openapi'
  col.description = [info.description, info.version ? `Version ${info.version}` : ''].filter(Boolean).join('\n\n')

  // ---- base URL ---------------------------------------------------------------------
  const baseUrl = v2 ? swaggerBase(spec, ctx) : serverBase(spec, ctx)
  ctx.vars.set('baseUrl', baseUrl)

  // ---- auth -----------------------------------------------------------------------------
  const schemes = (v2 ? spec.securityDefinitions : spec.components?.securitySchemes) || {}
  let globalReq = pickRequirement(spec.security, schemes)
  if (!globalReq) {
    // no global requirement, but every secured operation uses the same scheme: set it once on
    // the collection, so those requests share one token / key
    const used = []
    for (const item of Object.values(spec.paths || {})) {
      for (const m of METHODS) {
        const sec = deref(item, ctx)?.[m]?.security
        const r = Array.isArray(sec) && pickRequirement(sec, schemes)
        if (r) used.push(r)
      }
    }
    if (used.length && used.every((r) => r.name === used[0].name)) {
      globalReq = used[0]
      ctx.promotedAuth = true // operations without `security` are public: they get "No Auth"
    }
  }
  if (globalReq) col.auth = authFor(globalReq, ctx) || col.auth

  // ---- operations ---------------------------------------------------------------------
  const folders = new Map()
  for (const t of spec.tags || []) if (t?.name && !folders.has(t.name)) folders.set(t.name, null) // keep the spec's tag order
  const rootItems = []
  for (const [path, rawItem] of Object.entries(spec.paths || {})) {
    const pathItem = deref(rawItem, ctx)
    if (!pathItem || typeof pathItem !== 'object') continue
    for (const method of METHODS) {
      const op = pathItem[method]
      if (!op || typeof op !== 'object') continue
      const req = requestFor(path, method, pathItem, op, schemes, globalReq, ctx)
      const tag = Array.isArray(op.tags) && op.tags[0]
      if (tag) {
        let f = folders.get(tag)
        if (!f) folders.set(tag, (f = newFolder(tag)))
        f.items.push(req)
      } else rootItems.push(req)
    }
  }
  col.items = [...[...folders.values()].filter(Boolean), ...rootItems]
  if (!col.items.length) ctx.warnings.add('The file has no operations under "paths".')
  if (spec.webhooks || JSON.stringify(spec.paths || {}).includes('"callbacks"')) ctx.warnings.add('Webhooks and callbacks are not imported.')

  const environment = {
    id: uid(),
    name: `${col.name} (OpenAPI)`,
    isGlobal: false,
    variables: [...ctx.vars].map(([key, value]) => ({ id: uid(), key, value, enabled: true, isSecret: SECRET_VARS.has(key) })),
    updatedAt: new Date().toISOString(),
    syncedAt: null,
  }
  return { collection: col, environment, warnings: [...ctx.warnings] }
}

// ---- $ref ------------------------------------------------------------------------------

function resolvePointer(spec, ref, ctx) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) {
    ctx.warnings.add(`External references are not followed (${ref}).`)
    return undefined
  }
  let cur = spec
  for (const part of ref.slice(2).split('/')) {
    const key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~')
    cur = cur?.[key]
    if (cur === undefined) {
      ctx.warnings.add(`Reference ${ref} was not found.`)
      return undefined
    }
  }
  return cur
}

/** Follow $ref chains (parameters, bodies, responses, schemas). */
function deref(node, ctx, depth = 0) {
  let cur = node
  while (cur && typeof cur === 'object' && typeof cur.$ref === 'string' && depth++ < 20) cur = resolvePointer(ctx.spec, cur.$ref, ctx)
  return cur
}

// ---- base URL ------------------------------------------------------------------------------

function serverBase(spec, ctx) {
  const s = Array.isArray(spec.servers) ? spec.servers[0] : null
  if (!s?.url) {
    ctx.warnings.add('No server URL in the file: set {{baseUrl}} in the new environment.')
    return ''
  }
  let url = s.url.replace(/\{([^}]+)\}/g, (m, name) => {
    const v = s.variables?.[name]
    return v?.default !== undefined ? String(v.default) : m
  })
  if (url.startsWith('/')) ctx.warnings.add(`The server URL "${url}" is relative: add the host to {{baseUrl}} in the new environment.`)
  return url.replace(/\/+$/, '')
}

function swaggerBase(spec, ctx) {
  const basePath = (spec.basePath || '').replace(/\/+$/, '')
  if (!spec.host) {
    ctx.warnings.add('No host in the file: set {{baseUrl}} in the new environment.')
    return basePath
  }
  const scheme = (spec.schemes || []).includes('https') ? 'https' : spec.schemes?.[0] || 'https'
  return `${scheme}://${spec.host}${basePath}`
}

// ---- requests ------------------------------------------------------------------------------

function requestFor(path, method, pathItem, op, schemes, globalReq, ctx) {
  const name = op.summary || op.operationId || `${method.toUpperCase()} ${path}`
  const req = newRequest(String(name).slice(0, 200))
  req.method = method.toUpperCase()

  // parameters: path-level, overridden by operation-level (same name + in)
  const params = new Map()
  for (const p of [...(pathItem.parameters || []), ...(op.parameters || [])].map((x) => deref(x, ctx))) {
    if (p?.name && p.in) params.set(`${p.in}:${p.name}`, p)
  }
  const pathDocs = []
  for (const p of params.values()) {
    const schema = ctx.v2 && !p.schema ? p : deref(p.schema, ctx) || {}
    const value = paramValue(p, schema, ctx)
    const desc = p.description || ''
    if (p.in === 'query') req.params.push(kv(p.name, value, { description: desc, enabled: !!p.required || value !== '' }))
    else if (p.in === 'header') {
      if (!/^(accept|content-type|authorization)$/i.test(p.name)) req.headers.push(kv(p.name, value, { description: desc, enabled: !!p.required || value !== '' }))
    } else if (p.in === 'path') pathDocs.push(`- ${p.name}${schema.type ? ` (${schema.type})` : ''}${desc ? `: ${desc}` : ''}`)
    else if (p.in === 'cookie') ctx.warnings.add('Cookie parameters are not imported (browsers set cookies themselves; use Agent mode and a Cookie header).')
  }

  const pathPart = path.replace(/\{([^}]+)\}/g, '{{$1}}')
  const query = req.params.filter((p) => p.enabled).map((p) => `${encodeURIComponent(p.key)}=${p.value}`).join('&')
  req.url = `{{baseUrl}}${pathPart}${query ? `?${query}` : ''}`

  if (ctx.v2) swaggerBody(req, op, [...params.values()], ctx)
  else openApiBody(req, deref(op.requestBody, ctx), ctx)

  // auth: no `security` on the operation = inherit the collection's
  if (!Array.isArray(op.security) && ctx.promotedAuth) req.auth.type = 'none'
  if (Array.isArray(op.security)) {
    const r = pickRequirement(op.security, schemes)
    if (!r) req.auth.type = op.security.length === 0 || op.security.every((x) => !Object.keys(x || {}).length) ? 'none' : 'inherit'
    else if (!(globalReq && globalReq.name === r.name)) req.auth = authFor(r, ctx) || req.auth
  }

  req.description = [
    op.description && op.description !== op.summary ? op.description : '',
    op.deprecated ? 'Deprecated.' : '',
    pathDocs.length ? `Path parameters:\n${pathDocs.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  req.samples = samplesFor(op, ctx)
  // operations that answer with an event stream become SSE requests
  const streams = Object.entries(op.responses || {}).some(([code, r]) => /^2/.test(code) && Object.keys(deref(r, ctx)?.content || {}).some((t) => /text\/event-stream/i.test(t)))
  if (streams || (ctx.v2 && (op.produces || []).some((t) => /text\/event-stream/i.test(t)))) {
    req.protocol = 'sse'
    req.sse = PROTOCOL_DEFAULTS.sse()
    req.samples = req.samples.filter((x) => !/event-stream/i.test(x.headers[0]?.value || ''))
  }
  return req
}

function paramValue(p, schema, ctx) {
  let v = p.example
  if (v === undefined && p.examples && typeof p.examples === 'object') v = deref(Object.values(p.examples)[0], ctx)?.value
  if (v === undefined) v = schema.example ?? schema.default ?? schema.enum?.[0]
  if (v === undefined && p.required) v = exampleFor(schema, ctx)
  if (v === undefined || v === null) return ''
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

/** Pick a media type: JSON first, then forms, XML, text, anything. */
function pickMedia(content) {
  const types = Object.keys(content || {})
  return (
    types.find((t) => /^application\/json/i.test(t)) ||
    types.find((t) => /\+json/i.test(t)) ||
    types.find((t) => /x-www-form-urlencoded/i.test(t)) ||
    types.find((t) => /multipart\/form-data/i.test(t)) ||
    types.find((t) => /xml/i.test(t)) ||
    types.find((t) => /^text\//i.test(t)) ||
    types[0]
  )
}

function mediaExample(media, ctx, mode = 'request') {
  if (!media) return undefined
  if (media.example !== undefined) return media.example
  if (media.examples && typeof media.examples === 'object') {
    const first = deref(Object.values(media.examples)[0], ctx)
    if (first?.value !== undefined) return first.value
  }
  return media.schema ? exampleFor(deref(media.schema, ctx), ctx, mode) : undefined
}

function openApiBody(req, body, ctx) {
  if (!body?.content || ['GET', 'HEAD'].includes(req.method)) return
  const type = pickMedia(body.content)
  const media = body.content[type] || {}
  const schema = deref(media.schema, ctx) || {}
  if (/x-www-form-urlencoded/i.test(type)) {
    req.body.mode = 'urlencoded'
    req.body.urlencoded = formFields(schema, ctx).map((f) => kv(f.key, f.value))
  } else if (/multipart\/form-data/i.test(type)) {
    req.body.mode = 'form-data'
    req.body.formData = formFields(schema, ctx).map((f) => kv(f.key, f.file ? '' : f.value, { type: f.file ? 'file' : 'text' }))
  } else {
    const ex = mediaExample(media, ctx)
    req.body.mode = 'raw'
    if (/json/i.test(type)) {
      req.body.rawType = 'json'
      req.body.raw = ex === undefined ? '' : typeof ex === 'string' ? ex : JSON.stringify(ex, null, 2)
      if (!/^application\/json/i.test(type)) req.headers.push(kv('Content-Type', type))
    } else {
      req.body.rawType = /xml/i.test(type) ? 'xml' : /html/i.test(type) ? 'html' : 'text'
      req.body.raw = typeof ex === 'string' ? ex : ''
      if (!/^(application\/xml|text\/plain|text\/html)/i.test(type)) req.headers.push(kv('Content-Type', type))
    }
  }
}

function swaggerBody(req, op, params, ctx) {
  if (['GET', 'HEAD'].includes(req.method)) return
  const bodyParam = params.find((p) => p.in === 'body')
  const formParams = params.filter((p) => p.in === 'formData')
  if (bodyParam) {
    const schema = deref(bodyParam.schema, ctx) || {}
    const ex = bodyParam['x-example'] ?? exampleFor(schema, ctx)
    req.body.mode = 'raw'
    req.body.rawType = 'json'
    req.body.raw = ex === undefined ? '' : typeof ex === 'string' ? ex : JSON.stringify(ex, null, 2)
  } else if (formParams.length) {
    const multipart = formParams.some((p) => p.type === 'file') || (op.consumes || ctx.spec.consumes || []).some((c) => /multipart/i.test(c))
    const rows = formParams.map((p) => ({ key: p.name, value: p.type === 'file' ? '' : String(p.default ?? p.example ?? p.enum?.[0] ?? ''), file: p.type === 'file' }))
    if (multipart) {
      req.body.mode = 'form-data'
      req.body.formData = rows.map((f) => kv(f.key, f.value, { type: f.file ? 'file' : 'text' }))
    } else {
      req.body.mode = 'urlencoded'
      req.body.urlencoded = rows.map((f) => kv(f.key, f.value))
    }
  }
}

function formFields(schema, ctx) {
  const props = mergedProperties(schema, ctx)
  return Object.entries(props).map(([key, raw]) => {
    const s = deref(raw, ctx) || {}
    const file = s.format === 'binary' || s.format === 'base64' || (s.type === 'array' && deref(s.items, ctx)?.format === 'binary')
    const ex = file ? '' : exampleFor(s, ctx)
    return { key, value: ex === undefined || ex === null ? '' : typeof ex === 'object' ? JSON.stringify(ex) : String(ex), file }
  })
}

function samplesFor(op, ctx) {
  const out = []
  for (const [code, raw] of Object.entries(op.responses || {})) {
    const r = deref(raw, ctx)
    if (!r) continue
    const status = /^\d{3}$/.test(code) ? Number(code) : code === 'default' ? 200 : null
    if (!status) continue
    let body = ''
    let type = ''
    if (ctx.v2) {
      const ex = r.examples && Object.entries(r.examples).find(([t]) => /json/i.test(t))
      const v = ex ? ex[1] : r.schema ? exampleFor(deref(r.schema, ctx), ctx, 'response') : undefined
      if (v !== undefined) {
        body = typeof v === 'string' ? v : JSON.stringify(v, null, 2)
        type = 'application/json'
      }
    } else if (r.content) {
      type = pickMedia(r.content)
      const v = mediaExample(r.content[type], ctx, 'response')
      if (v !== undefined) body = typeof v === 'string' ? v : JSON.stringify(v, null, 2)
    }
    if (!body && !r.description) continue
    const label = `${code}${r.description ? ` ${String(r.description).split('\n')[0]}` : ''}`.slice(0, 80)
    out.push(newSample(label, { status, headers: type ? [kv('Content-Type', type)] : [], body }))
  }
  return out
}

// ---- example values from schemas ------------------------------------------------------------

function mergedProperties(schema, ctx, seen = new Set()) {
  if (!schema || seen.has(schema)) return {}
  seen.add(schema)
  const props = { ...(schema.properties || {}) }
  for (const part of schema.allOf || []) Object.assign(props, mergedProperties(deref(part, ctx), ctx, seen))
  return props
}

const STRING_FORMATS = {
  'date-time': '2024-01-01T12:00:00Z',
  date: '2024-01-01',
  time: '12:00:00',
  email: 'user@example.com',
  uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  uri: 'https://example.com',
  url: 'https://example.com',
  hostname: 'example.com',
  ipv4: '192.0.2.1',
  ipv6: '2001:db8::1',
  password: 'password',
  byte: 'U3dhZ2dlcg==',
}

/**
 * An example value for a schema. `mode` 'request' leaves out readOnly properties and
 * 'response' leaves out writeOnly ones. Recursive schemas stop at the first repeat.
 */
export function exampleFor(schema, ctx, mode = 'request', depth = 0, seen = new Set()) {
  const s = deref(schema, ctx)
  if (!s || typeof s !== 'object') return undefined
  if (s.example !== undefined) return s.example
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0]
  if (s.const !== undefined) return s.const
  if (s.default !== undefined) return s.default
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0]
  if (seen.has(s) || depth > 8) return undefined
  const next = new Set(seen).add(s)
  const sub = (x) => exampleFor(x, ctx, mode, depth + 1, next)

  if (s.allOf) {
    const parts = s.allOf.map(sub).filter((x) => x !== undefined)
    if (parts.every((p) => p && typeof p === 'object' && !Array.isArray(p))) {
      const own = s.properties ? sub({ ...s, allOf: undefined }) : {}
      return Object.assign({}, ...parts, own)
    }
    return parts[0]
  }
  if (s.oneOf || s.anyOf) return sub((s.oneOf || s.anyOf)[0])

  let type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type
  if (!type) type = s.properties || s.additionalProperties ? 'object' : s.items ? 'array' : undefined
  switch (type) {
    case 'object': {
      const out = {}
      for (const [k, p] of Object.entries(s.properties || {})) {
        const ps = deref(p, ctx) || {}
        if ((mode === 'request' && ps.readOnly) || (mode === 'response' && ps.writeOnly)) continue
        const v = sub(ps)
        if (v !== undefined) out[k] = v
      }
      if (!Object.keys(out).length && s.additionalProperties && typeof s.additionalProperties === 'object') {
        const v = sub(s.additionalProperties)
        if (v !== undefined) out.key = v
      }
      return out
    }
    case 'array': {
      const v = sub(s.items)
      return v === undefined ? [] : [v]
    }
    case 'string':
      return STRING_FORMATS[s.format] ?? (s.format === 'binary' ? '' : 'string')
    case 'integer':
    case 'number':
      return typeof s.minimum === 'number' ? s.minimum : 0
    case 'boolean':
      return true
    case 'null':
      return null
    default:
      return undefined
  }
}

// ---- security ----------------------------------------------------------------------------------

/** First usable scheme of a security requirement list: { name, scheme, scopes } or null. */
function pickRequirement(security, schemes) {
  for (const reqObj of Array.isArray(security) ? security : []) {
    for (const [name, scopes] of Object.entries(reqObj || {})) {
      if (schemes[name]) return { name, scheme: schemes[name], scopes: Array.isArray(scopes) ? scopes : [] }
    }
  }
  return null
}

function useVar(ctx, name, value = '') {
  if (!ctx.vars.has(name)) ctx.vars.set(name, value)
  return `{{${name}}}`
}

function authFor({ name, scheme: raw, scopes }, ctx) {
  const scheme = deref(raw, ctx) || {}
  const type = String(scheme.type || '').toLowerCase()
  const a = newAuth('inherit')
  if (type === 'http' && /^bearer$/i.test(scheme.scheme)) {
    a.type = 'bearer'
    a.bearer.token = useVar(ctx, 'bearerToken')
  } else if ((type === 'http' && /^basic$/i.test(scheme.scheme)) || type === 'basic') {
    a.type = 'basic'
    a.basic.username = useVar(ctx, 'username')
    a.basic.password = useVar(ctx, 'password')
  } else if (type === 'apikey') {
    a.type = 'apikey'
    a.apikey.key = scheme.name || 'X-API-Key'
    a.apikey.value = useVar(ctx, 'apiKey')
    a.apikey.in = scheme.in === 'query' ? 'query' : 'header'
    if (scheme.in === 'cookie') ctx.warnings.add(`API key "${name}" is sent in a cookie; it was imported as a header instead.`)
  } else if (type === 'oauth2') {
    const o = AUTH_DEFAULTS.oauth2()
    // OpenAPI 3: flows.{authorizationCode,clientCredentials,...}; Swagger 2: flow + urls
    const flows = scheme.flows || {}
    const code = flows.authorizationCode || (['accessCode'].includes(scheme.flow) ? scheme : null)
    const client = flows.clientCredentials || (scheme.flow === 'application' ? scheme : null)
    const flow = code || client
    if (!flow) {
      ctx.warnings.add(`OAuth 2.0 scheme "${name}" uses a flow Curlion does not support (implicit or password); fill in the Auth tab yourself.`)
    }
    o.grantType = code ? 'authorization_code' : client ? 'client_credentials' : 'authorization_code'
    o.authUrl = code?.authorizationUrl || ''
    o.tokenUrl = flow?.tokenUrl || ''
    o.scope = (scopes.length ? scopes : Object.keys(flow?.scopes || {})).join(' ')
    o.clientId = useVar(ctx, 'clientId')
    o.clientSecret = useVar(ctx, 'clientSecret')
    a.type = 'oauth2'
    a.oauth2 = o
  } else if (type === 'openidconnect') {
    ctx.warnings.add(`OpenID Connect scheme "${name}" was not imported; use OAuth 2.0 in the Auth tab with the provider's URLs.`)
    return null
  } else {
    ctx.warnings.add(`Security scheme "${name}" (${scheme.type || 'unknown'}) was not imported.`)
    return null
  }
  return a
}
