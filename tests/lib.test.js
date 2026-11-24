import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCurl, tokenize } from '../src/lib/curl.js'
import { paramsFromUrl, urlFromParams } from '../src/lib/url.js'
import { buildScope, getByPath, interpolate } from '../src/lib/variables.js'
import { exportPostman, importPostman, ImportError } from '../src/lib/postman.js'
import { resolveRequest } from '../src/lib/resolve.js'
import { generateSnippet, SNIPPET_LANGS } from '../src/lib/snippets.js'
import { kv, newRequest } from '../src/lib/model.js'

test('tokenize handles quotes, escapes and line continuations', () => {
  assert.deepEqual(tokenize(`curl 'a b' "c \\"d\\"" e\\ f \\\n  -H x`), ['curl', 'a b', 'c "d"', 'e f', '-H', 'x'])
  assert.deepEqual(tokenize(`curl $'line\\nnext'`), ['curl', 'line\nnext'])
})

test('parseCurl: JSON POST with headers and bearer', () => {
  const r = parseCurl(`curl -X POST 'https://api.test/login?x=1' -H 'Content-Type: application/json' -H 'Authorization: Bearer abc' --data-raw '{"a":1}'`)
  assert.equal(r.method, 'POST')
  assert.equal(r.url, 'https://api.test/login?x=1')
  assert.deepEqual(r.params.map((p) => [p.key, p.value]), [['x', '1']])
  assert.equal(r.auth.type, 'bearer')
  assert.equal(r.auth.bearer.token, 'abc')
  assert.equal(r.body.mode, 'raw')
  assert.equal(r.body.rawType, 'json')
  assert.deepEqual(JSON.parse(r.body.raw), { a: 1 })
  assert.equal(r.headers.length, 1)
})

test('parseCurl: basic auth, urlencoded, form and implied method', () => {
  const a = parseCurl(`curl https://x.test -u user:pa:ss -d 'a=1&b=two'`)
  assert.equal(a.method, 'POST')
  assert.equal(a.auth.basic.username, 'user')
  assert.equal(a.auth.basic.password, 'pa:ss')
  assert.equal(a.body.mode, 'urlencoded')
  assert.deepEqual(a.body.urlencoded.map((f) => [f.key, f.value]), [['a', '1'], ['b', 'two']])

  const f = parseCurl(`curl --location 'https://x.test/up' --form 'name="Bob"' --form 'file=@"/tmp/a.png"'`)
  assert.equal(f.body.mode, 'form-data')
  assert.equal(f.body.formData[0].value, 'Bob')
  assert.equal(f.body.formData[1].type, 'file')
  assert.equal(f.body.formData[1].fileName, '/tmp/a.png')

  assert.equal(parseCurl('curl example.com').url, 'http://example.com')
  assert.throws(() => parseCurl('wget x'))
})

test('URL <-> params two-way sync keeps vars and disabled rows', () => {
  const old = [kv('a', '1'), { ...kv('off', 'x'), enabled: false }]
  old[0].description = 'desc'
  const params = paramsFromUrl('{{base}}/p?a=2&b={{v}}', old)
  assert.deepEqual(params.map((p) => [p.key, p.value, p.enabled]), [['a', '2', true], ['b', '{{v}}', true], ['off', 'x', false]])
  assert.equal(params[0].description, 'desc')
  assert.equal(urlFromParams('{{base}}/p?old=1#h', params), '{{base}}/p?a=2&b={{v}}#h')
})

test('interpolate: env, globals override, dynamic, secrets masked', () => {
  const g = { name: 'G', variables: [{ key: 'host', value: 'g.test' }, { key: 'k', value: 'G' }] }
  const e = { name: 'Dev', variables: [{ key: 'k', value: 'D' }, { key: 'tok', value: 's3', isSecret: true }, { key: 'off', value: 'x', enabled: false }] }
  const s = buildScope(g, e)
  assert.equal(interpolate('{{host}}/{{k}}/{{tok}}/{{off}}', s), 'g.test/D/s3/{{off}}')
  assert.equal(interpolate('{{tok}}', s, { maskSecrets: true }), '{{tok}}')
  assert.match(interpolate('{{$uuid}}', s), /^[0-9a-f-]{36}$/)
  assert.match(interpolate('{{$timestamp}}', s), /^\d{10}$/)
  const n = Number(interpolate('{{$randomInt}}', s))
  assert.ok(n >= 1 && n <= 1000)
  assert.match(interpolate('{{$randomEmail}}', s), /^[^@]+@[^@]+\.\w+$/)
})

test('getByPath', () => {
  const o = { data: { access_token: 't', items: [{ id: 7 }] }, 'a b': { c: 1 } }
  assert.equal(getByPath(o, 'data.access_token'), 't')
  assert.equal(getByPath(o, '$.data.items[0].id'), 7)
  assert.equal(getByPath(o, "['a b'].c"), 1)
  assert.equal(getByPath(o, 'nope.x'), undefined)
})

test('resolveRequest applies auth and body content-type', () => {
  const r = newRequest('x', { method: 'POST', url: '{{h}}/a' })
  r.auth.type = 'apikey'
  r.auth.apikey = { key: 'api_key', value: '{{k}}', in: 'query' }
  r.body.mode = 'raw'
  r.body.raw = '{"t":"{{k}}"}'
  const s = buildScope(null, { name: 'e', variables: [{ key: 'h', value: 'https://h.test' }, { key: 'k', value: 'K' }] })
  const out = resolveRequest(r, s)
  assert.equal(out.url, 'https://h.test/a?api_key=K')
  assert.equal(out.body.raw, '{"t":"K"}')
  assert.deepEqual(out.headers, [{ key: 'Content-Type', value: 'application/json' }])

  r.auth = { type: 'basic', basic: { username: 'u', password: 'p' } }
  assert.equal(resolveRequest(r, s).headers.find((h) => h.key === 'Authorization').value, 'Basic dTpw')
})

const pmFixture = {
  info: { name: 'Demo', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [
    {
      name: 'Users',
      item: [
        {
          name: 'Create',
          request: {
            method: 'POST',
            header: [{ key: 'X-A', value: '1' }],
            url: { raw: '{{base}}/users?x=1', query: [{ key: 'x', value: '1' }] },
            auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{tok}}' }] },
            body: { mode: 'raw', raw: '{"n":1}', options: { raw: { language: 'json' } } },
          },
          response: [{ name: 'OK', code: 201, header: [{ key: 'Content-Type', value: 'application/json' }], body: '{"id":1}' }],
        },
      ],
    },
    { name: 'Ping', request: { method: 'GET', url: 'https://p.test/ping' } },
  ],
  variable: [{ key: 'base', value: 'https://api.test' }],
}

test('importPostman maps folders, requests, auth, body, samples, variables', () => {
  const { collection, environment } = importPostman(JSON.stringify(pmFixture))
  assert.equal(collection.name, 'Demo')
  const folder = collection.items[0]
  assert.equal(folder.type, 'folder')
  const req = folder.items[0]
  assert.equal(req.method, 'POST')
  assert.equal(req.url, '{{base}}/users?x=1')
  assert.equal(req.auth.type, 'bearer')
  assert.equal(req.auth.bearer.token, '{{tok}}')
  assert.equal(req.body.rawType, 'json')
  assert.equal(req.samples[0].status, 201)
  assert.equal(collection.items[1].url, 'https://p.test/ping')
  assert.equal(environment.variables[0].key, 'base')
})

test('importPostman validation errors', () => {
  assert.throws(() => importPostman('{oops'), ImportError)
  assert.throws(() => importPostman('{"item": []}'), /info/)
  assert.throws(() => importPostman('{"info": {"name": "x"}}'), /item/)
})

test('export -> import round trip', () => {
  const { collection } = importPostman(pmFixture)
  const again = importPostman(exportPostman(collection)).collection
  const a = again.items[0].items[0]
  assert.equal(a.url, '{{base}}/users?x=1')
  assert.equal(a.auth.bearer.token, '{{tok}}')
  assert.equal(a.samples[0].body, '{"id":1}')
})

test('every snippet language renders method and URL', () => {
  const r = newRequest('x', { method: 'PUT', url: 'https://s.test/a', headers: [kv('X-Y', 'z')] })
  r.body.mode = 'raw'
  r.body.raw = '{"a":1}'
  const resolved = resolveRequest(r, new Map())
  for (const { id } of SNIPPET_LANGS) {
    const code = generateSnippet(id, resolved)
    assert.ok(code.includes('https://s.test/a'), id)
    assert.ok(/PUT|put/.test(code), id)
    assert.ok(code.includes('X-Y'), id)
  }
})

// ---- Phase 4 ---------------------------------------------------------------
import { diffTrees, describeLog } from '../src/lib/activity.js'
import { buildDocsSnapshot, slugify, SLUG_RE } from '../src/lib/publish.js'
import { newFolder, newSample, clone } from '../src/lib/model.js'

test('diffTrees: create, update (method/url/sections), sample, rename/delete folder', () => {
  const f = newFolder('Users')
  const a = newRequest('List', { url: 'https://x/u' })
  const gone = newRequest('Old')
  f.items.push(a, gone)
  const before = [f]
  const after = clone(before)
  after[0].name = 'People'
  const a2 = after[0].items[0]
  a2.method = 'POST'
  a2.url = 'https://x/users'
  a2.headers.push(kv('X', '1'))
  a2.samples.push(newSample('OK'))
  after[0].items.splice(1, 1)
  after.push(newRequest('Fresh'))
  const log = diffTrees(before, after)
  const byAction = Object.fromEntries(log.map((l) => [l.action, l]))
  assert.equal(byAction.RENAME_FOLDER.metadata.from, 'Users')
  assert.deepEqual(byAction.UPDATE_REQUEST.metadata.changes.map((c) => c.field), ['method', 'url', 'headers'])
  assert.equal(byAction.ADD_MOCK_SAMPLE.target_name, 'OK')
  assert.equal(byAction.DELETE_REQUEST.target_name, 'Old')
  assert.equal(byAction.CREATE_REQUEST.target_name, 'Fresh')
  assert.match(describeLog(byAction.UPDATE_REQUEST), /method: GET → POST/)
  assert.deepEqual(diffTrees(before, clone(before)), [])
})

test('diffTrees: deleting a folder logs only the folder', () => {
  const f = newFolder('F')
  f.items.push(newRequest('a'), newFolder('inner'))
  const log = diffTrees([f], [])
  assert.equal(log.length, 1)
  assert.equal(log[0].action, 'DELETE_FOLDER')
  assert.equal(log[0].metadata.items, 1)
})

test('buildDocsSnapshot hides literal secrets but keeps {{vars}}', () => {
  const r1 = newRequest('A', { url: 'https://x/a?api_key=SECRET&page=2', headers: [kv('Authorization', 'Bearer abc'), kv('X-Api-Key', '{{key}}'), { ...kv('X-Off', 'v'), enabled: false }] })
  r1.auth.type = 'bearer'
  r1.auth.bearer.token = 'literal-token'
  const r2 = newRequest('B')
  r2.auth.type = 'basic'
  r2.auth.basic.password = '{{pw}}'
  r2.extract.push({ path: 'x', variable: 'y' })
  const f = newFolder('F')
  f.items.push(r2)
  const snap = buildDocsSnapshot({ name: 'C', description: 'd', items: [r1, f] })
  const [a, folder] = snap.items
  assert.equal(a.auth.bearer.token, '<token>')
  assert.equal(a.headers.find((h) => h.key === 'Authorization').value, '<redacted>')
  assert.equal(a.headers.find((h) => h.key === 'X-Api-Key').value, '{{key}}')
  assert.equal(a.headers.length, 2)
  assert.equal(a.url, 'https://x/a?api_key=<redacted>&page=2')
  assert.equal(folder.items[0].auth.basic.password, '{{pw}}')
  assert.equal(folder.items[0].extract, undefined)
  assert.equal(r1.auth.bearer.token, 'literal-token') // original untouched
})

test('slugify produces valid slugs', () => {
  assert.equal(slugify('Ápi Pembayaran v2!'), 'api-pembayaran-v2')
  assert.ok(SLUG_RE.test(slugify('Ápi Pembayaran v2!')))
  assert.ok(!SLUG_RE.test('-bad'))
  assert.ok(!SLUG_RE.test('ab'))
})

test('docs snippets keep {{vars}} and dynamic vars unresolved', () => {
  const r = newRequest('x', { url: '{{baseUrl}}/a?id={{$uuid}}' })
  const out = resolveRequest(r, new Map(), { keepDynamic: true })
  assert.equal(out.url, '{{baseUrl}}/a?id={{$uuid}}')
})

test('buildScope: per-user current values override shared initial values', () => {
  const env = { id: 'e1', name: 'Dev', variables: [
    { id: 'v1', key: 'baseUrl', value: 'https://shared.test', enabled: true },
    { id: 'v2', key: 'token', value: '', enabled: true, isSecret: true },
    { id: 'v3', key: 'region', value: 'eu', enabled: true },
  ] }
  const current = { e1: { v2: 'my-token', v3: '' } }
  const s = buildScope(null, env, current)
  assert.equal(s.get('baseUrl').value, 'https://shared.test')
  assert.equal(s.get('baseUrl').isCurrent, false)
  assert.equal(s.get('token').value, 'my-token')
  assert.equal(s.get('token').isCurrent, true)
  assert.equal(s.get('region').value, 'eu', 'empty current value falls back to the initial value')
  assert.equal(interpolate('{{baseUrl}}/me?t={{token}}', s), 'https://shared.test/me?t=my-token')
})

import { addressSpace } from '../src/lib/http.js'
test('addressSpace classifies loopback, local network and public hosts', () => {
  for (const u of ['http://localhost:3000/x', 'http://127.0.0.1:8080', 'http://[::1]:3000/', 'http://api.localhost/']) assert.equal(addressSpace(u), 'loopback', u)
  for (const u of ['http://192.168.1.20:8080', 'http://10.0.0.5/', 'http://172.20.1.1', 'http://printer.local/', 'http://intranet/', 'http://[fd00::1]/']) assert.equal(addressSpace(u), 'local', u)
  for (const u of ['https://dummyjson.com', 'http://172.32.0.1/', 'https://api.example.com:8443/v1', 'not a url']) assert.equal(addressSpace(u), 'public', u)
})

import { uid } from '../src/lib/model.js'
test('uid works without crypto.randomUUID (plain-http LAN hosting)', () => {
  const orig = crypto.randomUUID
  try {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
    const id = uid()
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.notEqual(uid(), id)
  } finally {
    Object.defineProperty(crypto, 'randomUUID', { value: orig, configurable: true })
  }
})

import { summarizeSchema, operationFor } from '../src/lib/graphql.js'
test('GraphQL: resolveRequest builds a JSON POST and keeps {{vars}} in variables valid', () => {
  const req = { ...newRequest('q'), protocol: 'graphql', url: '{{base}}/graphql', graphql: { query: 'query($id: ID!) { user(id: $id) { name } }', variables: '{"id": "{{userId}}"}' } }
  const scope = new Map([['base', { value: 'https://api.test' }], ['userId', { value: '42' }]])
  const r = resolveRequest(req, scope)
  assert.equal(r.method, 'POST')
  assert.equal(r.url, 'https://api.test/graphql')
  assert.deepEqual(JSON.parse(r.body.raw), { query: req.graphql.query, variables: { id: '42' } })
  assert.ok(r.headers.some((h) => h.key === 'Content-Type' && h.value === 'application/json'))
})

test('GraphQL: schema summary and starter operation', () => {
  const T = (kind, name, ofType) => ({ kind, name, ofType })
  const json = { data: { __schema: { queryType: { name: 'Query' }, mutationType: null, subscriptionType: null, types: [
    { kind: 'OBJECT', name: 'Query', fields: [{ name: 'user', args: [{ name: 'id', type: T('NON_NULL', null, T('SCALAR', 'ID')) }], type: T('OBJECT', 'User') }] },
    { kind: 'OBJECT', name: 'User', fields: [{ name: 'id', args: [], type: T('SCALAR', 'ID') }, { name: 'name', args: [], type: T('SCALAR', 'String') }] },
    { kind: 'SCALAR', name: 'ID' }, { kind: 'SCALAR', name: 'String' },
  ] } } }
  const s = summarizeSchema(json)
  assert.equal(s.roots[0].kind, 'query')
  const op = operationFor('query', s.roots[0].fields[0], s.types)
  assert.match(op, /query User\(\$id: ID!\) \{\n  user\(id: \$id\) \{\n    id\n    name\n  \}\n\}/)
  assert.throws(() => summarizeSchema({ errors: [{ message: 'introspection disabled' }] }), /introspection disabled/)
})

test('Postman GraphQL body round trip', () => {
  const col = importPostman({ info: { name: 'G', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [{ name: 'Q', request: { method: 'POST', url: 'https://x/graphql', body: { mode: 'graphql', graphql: { query: '{ me { id } }', variables: '{"a":1}' } } } }] }).collection
  const r = col.items[0]
  assert.equal(r.protocol, 'graphql')
  assert.equal(r.graphql.query, '{ me { id } }')
  const back = exportPostman(col).item[0].request
  assert.equal(back.body.mode, 'graphql')
  assert.equal(back.body.graphql.variables, '{"a":1}')
})

test('WebSocket URLs default to ws:// and gRPC targets stay host:port', () => {
  const ws = resolveRequest({ ...newRequest('w'), protocol: 'ws', url: 'echo.test/socket' }, new Map())
  assert.equal(ws.url, 'ws://echo.test/socket')
  const g = resolveRequest({ ...newRequest('g'), protocol: 'grpc', url: 'localhost:50051' }, new Map())
  assert.equal(g.url, 'localhost:50051')
})

import { parseProto, findMethod, encodeMessage, decodeMessage, exampleMessage } from '../src/lib/grpc.js'
const PROTO = `syntax = "proto3";
package demo.v1;
import "google/protobuf/timestamp.proto";
service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply);
  rpc Countdown (HelloRequest) returns (stream HelloReply);
}
enum Mood { MOOD_UNSPECIFIED = 0; HAPPY = 1; }
message HelloRequest { string name = 1; int32 times = 2; Mood mood = 3; repeated string tags = 4; }
message HelloReply { string message = 1; google.protobuf.Timestamp at = 2; }`

test('gRPC: parse .proto (with a well-known type), encode and decode', async () => {
  const p = await parseProto(PROTO)
  assert.deepEqual(p.services.map((s) => s.fullName), ['demo.v1.Greeter'])
  const m = findMethod(p, 'demo.v1.Greeter', 'Countdown')
  assert.equal(m.path, '/demo.v1.Greeter/Countdown')
  assert.equal(m.responseStream, true)
  assert.deepEqual(exampleMessage(p.root, m.requestType), { name: '', times: 0, mood: 'MOOD_UNSPECIFIED', tags: [''] })
  const b64 = encodeMessage(p.root, 'demo.v1.HelloRequest', { name: 'Ada', times: 3, mood: 'HAPPY', tags: ['x'] })
  assert.deepEqual(decodeMessage(p.root, 'demo.v1.HelloRequest', b64), { name: 'Ada', times: 3, mood: 'HAPPY', tags: ['x'] })
  assert.throws(() => encodeMessage(p.root, 'demo.v1.HelloRequest', { times: 'many' }), /Invalid demo.v1.HelloRequest/)
})

// ---- Auth / header inheritance -------------------------------------------------
import { applyInheritance, effectiveAuth } from '../src/lib/resolve.js'
import { newAuth, newCollection, folderPath } from '../src/lib/model.js'

test('inheritance: nearest folder auth wins, collection is the fallback, own auth stays', () => {
  const col = newCollection('API')
  col.auth = { ...newAuth('bearer'), bearer: { token: 'col-token' } }
  col.headers = [kv('X-Tenant', 'acme'), kv('Accept', 'application/json')]
  const outer = newFolder('Admin')
  outer.headers = [kv('X-Tenant', 'admin')]
  const inner = newFolder('Users')
  inner.auth = { ...newAuth('apikey'), apikey: { key: 'X-Key', value: 'k', in: 'header' } }
  const req = newRequest('List', { url: 'https://api.test/u', headers: [kv('Accept', 'text/plain')] })
  inner.items.push(req)
  outer.items.push(inner)
  col.items.push(outer)

  const chain = [col, ...folderPath(col.items, req.id)]
  assert.deepEqual(chain.map((n) => n.name), ['API', 'Admin', 'Users'])
  assert.equal(effectiveAuth(req.auth, chain).source, inner)

  const r = resolveRequest(applyInheritance(req, chain), new Map())
  const h = Object.fromEntries(r.headers.map((x) => [x.key, x.value]))
  assert.equal(h['X-Key'], 'k')
  assert.equal(h['X-Tenant'], 'admin') // inner folder replaces the collection header
  assert.equal(h.Accept, 'text/plain') // the request's own header wins
  assert.equal(r.headers.filter((x) => x.key.toLowerCase() === 'accept').length, 1)

  inner.auth.type = 'inherit'
  assert.equal(resolveRequest(applyInheritance(req, chain), new Map()).headers.find((x) => x.key === 'Authorization').value, 'Bearer col-token')
  req.auth.type = 'none'
  assert.equal(resolveRequest(applyInheritance(req, chain), new Map()).headers.find((x) => x.key === 'Authorization'), undefined)
  assert.equal(effectiveAuth(newAuth('inherit'), []).auth.type, 'none')
})

test('Postman: collection and folder auth import as inherited, export keeps them', () => {
  const pm = {
    info: { name: 'P', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
    item: [
      { name: 'F', auth: { type: 'basic', basic: [{ key: 'username', value: 'u' }, { key: 'password', value: 'p' }] }, item: [{ name: 'a', request: { method: 'GET', url: 'https://x.test/a' } }] },
      { name: 'b', request: { method: 'GET', url: 'https://x.test/b', auth: { type: 'noauth' } } },
      { name: 'c', request: { method: 'GET', url: 'https://x.test/c' } },
    ],
  }
  const { collection: col } = importPostman(pm)
  assert.equal(col.auth.type, 'bearer')
  assert.equal(col.items[0].auth.type, 'basic')
  assert.equal(col.items[0].items[0].auth.type, 'inherit')
  assert.equal(col.items[1].auth.type, 'none')
  assert.equal(col.items[2].auth.type, 'inherit')

  col.headers = [kv('X-Team', 'core')]
  const out = exportPostman(col)
  assert.equal(out.auth.type, 'bearer')
  assert.equal(out.item[0].auth.type, 'basic')
  assert.equal(out.item[0].item[0].request.auth, undefined)
  assert.equal(out.item[1].request.auth.type, 'noauth')
  assert.deepEqual(out.item[2].request.header.map((h) => h.key), ['X-Team']) // Postman has no collection headers
})

test('docs snapshot shows inherited auth and headers on each request', () => {
  const col = newCollection('D')
  col.auth = { ...newAuth('bearer'), bearer: { token: 'secret-literal' } }
  const f = newFolder('F')
  f.headers = [kv('X-Api-Key', 'literal')]
  f.items.push(newRequest('r', { url: 'https://d.test' }))
  col.items.push(f)
  const snap = buildDocsSnapshot(col)
  const r = snap.items[0].items[0]
  assert.equal(r.auth.type, 'bearer')
  assert.equal(r.auth.bearer.token, '<token>')
  assert.deepEqual(r.headers.map((h) => [h.key, h.value]), [['X-Api-Key', '<redacted>']])
  assert.equal(snap.items[0].auth, undefined)
})

// ---- OAuth 2.0 --------------------------------------------------------------------
import { authorizeUrl, isExpired, parseRedirect, parseTokenResponse, pkcePair, refreshParams, tokenRequest, authorizationCodeParams } from '../src/lib/oauth.js'
import { createHash } from 'node:crypto'

test('OAuth: PKCE S256 challenge and authorize URL', async () => {
  const p = await pkcePair()
  assert.equal(p.method, 'S256')
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43,128}$/)
  assert.equal(p.challenge, createHash('sha256').update(p.verifier).digest('base64url'))
  const u = new URL(authorizeUrl({ authUrl: 'https://id.test/authorize?prompt=login', clientId: 'cid', scope: 'read write', audience: 'api' }, { state: 's1', redirectUri: 'https://app.test/oauth-callback.html', pkce: p }))
  assert.equal(u.searchParams.get('prompt'), 'login')
  assert.equal(u.searchParams.get('response_type'), 'code')
  assert.equal(u.searchParams.get('scope'), 'read write')
  assert.equal(u.searchParams.get('code_challenge'), p.challenge)
  assert.equal(u.searchParams.get('redirect_uri'), 'https://app.test/oauth-callback.html')
})

test('OAuth: redirect parsing, token request client auth, token parsing and expiry', () => {
  assert.deepEqual(parseRedirect('https://a.test/cb?code=xyz&state=s1'), { code: 'xyz', state: 's1', error: null })
  assert.equal(parseRedirect('https://a.test/cb?error=access_denied&error_description=No').error, 'access_denied: No')
  assert.equal(parseRedirect('https://a.test/cb#code=h&state=2').code, 'h')

  const basic = tokenRequest({ tokenUrl: 'https://id.test/token', clientId: 'id', clientSecret: 'sec', clientAuth: 'basic' }, authorizationCodeParams({}, { code: 'c', redirectUri: 'r', verifier: 'v' }))
  assert.equal(basic.headers.find((h) => h.key === 'Authorization').value, 'Basic ' + Buffer.from('id:sec').toString('base64'))
  assert.deepEqual(basic.body.fields.map((f) => f.key), ['grant_type', 'code', 'redirect_uri', 'code_verifier'])
  const body = tokenRequest({ tokenUrl: 'https://id.test/token', clientId: 'id', clientSecret: 'sec', clientAuth: 'body', scope: 's' }, refreshParams({ scope: 's' }, 'rt'))
  assert.equal(body.headers.some((h) => h.key === 'Authorization'), false)
  assert.deepEqual(Object.fromEntries(body.body.fields.map((f) => [f.key, f.value])), { grant_type: 'refresh_token', refresh_token: 'rt', scope: 's', client_id: 'id', client_secret: 'sec' })
  const pub = tokenRequest({ tokenUrl: 't', clientId: 'id', clientSecret: '', clientAuth: 'basic' }, { grant_type: 'client_credentials' })
  assert.ok(pub.body.fields.some((f) => f.key === 'client_id'))

  const t = parseTokenResponse({ status: 200, json: { access_token: 'a', expires_in: 60, token_type: 'bearer' } }, { refreshToken: 'old' }, 1000)
  assert.deepEqual([t.accessToken, t.refreshToken, t.expiresAt], ['a', 'old', 61000])
  assert.equal(parseTokenResponse({ status: 200, body: 'access_token=gh&scope=repo' }).accessToken, 'gh')
  assert.throws(() => parseTokenResponse({ status: 400, json: { error: 'invalid_grant', error_description: 'bad code' } }), /invalid_grant: bad code/)
  assert.equal(isExpired({ expiresAt: 61000 }, 40000), true) // within the 30 s margin
  assert.equal(isExpired({ expiresAt: null }, 1e15), false)
})

test('OAuth: resolveRequest adds the token, snippets get a placeholder; Postman round trip', () => {
  const req = newRequest('o', { url: 'https://api.test' })
  req.auth = { ...newAuth('oauth2'), oauth2: { ...newAuth().oauth2, headerPrefix: 'Token' } }
  assert.equal(resolveRequest(req, new Map(), { oauthToken: 'abc' }).headers[0].value, 'Token abc')
  assert.equal(resolveRequest(req, new Map()).headers[0].value, 'Token <access token>')

  const col = newCollection('C')
  col.auth = { ...newAuth('oauth2'), oauth2: { ...newAuth().oauth2, grantType: 'client_credentials', tokenUrl: 'https://id.test/token', clientId: 'cid', clientSecret: 's3cret', scope: 'a b' } }
  const back = importPostman(exportPostman(col)).collection.auth
  assert.equal(back.type, 'oauth2')
  assert.equal(back.oauth2.grantType, 'client_credentials')
  assert.equal(back.oauth2.tokenUrl, 'https://id.test/token')
  assert.equal(back.oauth2.scope, 'a b')
  col.items.push(newRequest('r'))
  assert.equal(buildDocsSnapshot(col).items[0].auth.oauth2.clientSecret, '<client-secret>')
})

// ---- OpenAPI / Swagger import -----------------------------------------------------
import { importOpenApi, isOpenApi, parseSpecText } from '../src/lib/openapi.js'

const PETSTORE_YAML = `
openapi: 3.0.3
info:
  title: Pets
  version: 1.2.0
  description: Pet API
servers:
  - url: https://{env}.pets.test/v1
    variables:
      env: { default: api }
security:
  - bearer: []
tags:
  - name: pets
paths:
  /pets:
    get:
      tags: [pets]
      summary: List pets
      parameters:
        - { name: limit, in: query, required: true, schema: { type: integer, default: 20 } }
        - { name: q, in: query, schema: { type: string } }
        - { name: X-Request-Id, in: header, schema: { type: string, format: uuid } }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: { type: array, items: { $ref: '#/components/schemas/Pet' } }
    post:
      tags: [pets]
      operationId: createPet
      requestBody:
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Pet' }
      responses: { '201': { description: Created } }
  /pets/{petId}:
    parameters:
      - { name: petId, in: path, required: true, description: The id, schema: { type: string } }
    get:
      tags: [pets]
      summary: Get a pet
      responses: { '404': { description: Not found } }
  /health:
    get:
      summary: Health
      security: []
      responses: { '200': { description: OK } }
  /upload:
    post:
      summary: Upload
      security: [ { key: [] } ]
      requestBody:
        content:
          multipart/form-data:
            schema:
              type: object
              properties:
                file: { type: string, format: binary }
                note: { type: string, example: hi }
      responses: { '200': { description: OK } }
components:
  securitySchemes:
    bearer: { type: http, scheme: bearer }
    key: { type: apiKey, name: X-Key, in: header }
  schemas:
    Pet:
      type: object
      required: [name]
      properties:
        id: { type: integer, readOnly: true, example: 7 }
        name: { type: string, example: Rex }
        tags: { type: array, items: { type: string } }
        parent: { $ref: '#/components/schemas/Pet' }
`

test('OpenAPI 3 (YAML): folders, baseUrl, params, bodies, samples and auth', () => {
  const spec = parseSpecText(PETSTORE_YAML)
  assert.ok(isOpenApi(spec))
  const { collection: col, environment: env, warnings } = importOpenApi(PETSTORE_YAML)
  assert.equal(col.name, 'Pets')
  assert.equal(env.variables.find((v) => v.key === 'baseUrl').value, 'https://api.pets.test/v1')
  assert.ok(env.variables.find((v) => v.key === 'bearerToken').isSecret)
  assert.equal(col.auth.type, 'bearer')
  assert.equal(col.auth.bearer.token, '{{bearerToken}}')

  const [pets, health, upload] = col.items
  assert.equal(pets.type, 'folder')
  assert.equal(pets.name, 'pets')
  const [list, create, get] = pets.items
  assert.equal(list.url, '{{baseUrl}}/pets?limit=20')
  assert.deepEqual(list.params.map((p) => [p.key, p.value, p.enabled]), [['limit', '20', true], ['q', '', false]])
  assert.equal(list.headers[0].key, 'X-Request-Id')
  assert.equal(list.auth.type, 'inherit')
  const sample = JSON.parse(list.samples[0].body)
  assert.equal(sample[0].name, 'Rex')
  assert.equal(sample[0].id, 7) // readOnly is kept in responses
  assert.equal(create.name, 'createPet')
  assert.deepEqual(Object.keys(JSON.parse(create.body.raw)), ['name', 'tags']) // readOnly id left out; the recursive parent is dropped
  assert.equal(get.url, '{{baseUrl}}/pets/{{petId}}')
  assert.match(get.description, /petId \(string\): The id/)
  assert.equal(health.auth.type, 'none')
  assert.equal(upload.auth.type, 'apikey')
  assert.equal(upload.auth.apikey.key, 'X-Key')
  assert.deepEqual(upload.body.formData.map((f) => [f.key, f.type, f.value]), [['file', 'file', ''], ['note', 'text', 'hi']])
  assert.deepEqual(warnings, [])
})

test('Swagger 2.0 (JSON): host/basePath, body and form params, OAuth 2.0 promoted to the collection', () => {
  const spec = {
    swagger: '2.0',
    info: { title: 'Legacy', version: '1' },
    host: 'legacy.test',
    basePath: '/api/',
    schemes: ['http', 'https'],
    securityDefinitions: { oa: { type: 'oauth2', flow: 'application', tokenUrl: 'https://id.test/token', scopes: { read: 'Read', write: 'Write' } } },
    paths: {
      '/items': {
        post: {
          security: [{ oa: ['write'] }],
          parameters: [{ in: 'body', name: 'body', schema: { type: 'object', properties: { n: { type: 'number', minimum: 1 } } } }],
          responses: { 200: { description: 'ok', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } },
        },
        put: {
          security: [{ oa: ['write'] }],
          consumes: ['application/x-www-form-urlencoded'],
          parameters: [{ in: 'formData', name: 'a', type: 'string', default: 'x' }],
          responses: {},
        },
        get: { parameters: [{ in: 'query', name: 'page', type: 'integer', required: true }], responses: {} },
      },
    },
  }
  const { collection: col, environment: env } = importOpenApi(JSON.stringify(spec))
  assert.equal(env.variables.find((v) => v.key === 'baseUrl').value, 'https://legacy.test/api')
  assert.equal(col.auth.type, 'oauth2')
  assert.equal(col.auth.oauth2.grantType, 'client_credentials')
  assert.equal(col.auth.oauth2.tokenUrl, 'https://id.test/token')
  assert.equal(col.auth.oauth2.scope, 'write')
  const [get, post, put] = col.items
  assert.deepEqual(JSON.parse(post.body.raw), { n: 1 })
  assert.equal(post.auth.type, 'inherit')
  assert.deepEqual(JSON.parse(post.samples[0].body), { ok: true })
  assert.deepEqual(put.body.urlencoded.map((f) => [f.key, f.value]), [['a', 'x']])
  assert.equal(get.url, '{{baseUrl}}/items?page=0')
  assert.equal(get.auth.type, 'none') // not secured while the others are
})

test('OpenAPI import errors', () => {
  assert.throws(() => importOpenApi('{"info":{}}'), /does not look like an OpenAPI/)
  assert.throws(() => importOpenApi('openapi: 4.0.0\npaths: {}'), /not supported/)
  assert.throws(() => parseSpecText(': : :\n  - ['), /not valid JSON or YAML/)
})

// ---- Tests without scripts -----------------------------------------------------------
import { checkTest, describeTest, newTest, runTests, summarize } from '../src/lib/assertions.js'

test('assertions: status, time, JSON path, header, body, types and regex', () => {
  const res = {
    status: 201,
    time: 120,
    headers: [{ key: 'content-type', value: 'application/json; charset=utf-8' }],
    body: '{"data":{"id":7,"tags":["a","b"],"ok":true,"owner":null,"items":[{"n":1}]}}',
  }
  res.json = JSON.parse(res.body)
  const ok = (patch) => checkTest(newTest(patch), res).ok
  assert.equal(ok({ source: 'status', op: 'eq', expected: '201' }), true)
  assert.equal(ok({ source: 'status', op: 'eq', expected: '200' }), false)
  assert.equal(ok({ source: 'status', op: 'matches', expected: '^2\\d\\d$' }), true)
  assert.equal(ok({ source: 'time', op: 'lt', expected: '500' }), true)
  assert.equal(ok({ source: 'time', op: 'gte', expected: 'abc' }), false)
  assert.equal(ok({ source: 'json', property: 'data.id', op: 'eq', expected: '7' }), true)
  assert.equal(ok({ source: 'json', property: '$.data.ok', op: 'eq', expected: 'true' }), true)
  assert.equal(ok({ source: 'json', property: 'data.owner', op: 'type', expected: 'null' }), true)
  assert.equal(ok({ source: 'json', property: 'data.tags', op: 'type', expected: 'array' }), true)
  assert.equal(ok({ source: 'json', property: 'data.tags', op: 'contains', expected: 'b' }), true)
  assert.equal(ok({ source: 'json', property: 'data.items', op: 'contains', expected: '{"n":1}' }), true)
  assert.equal(ok({ source: 'json', property: 'data.items[0]', op: 'eq', expected: '{ "n": 1 }' }), true)
  assert.equal(ok({ source: 'json', property: 'data.missing', op: 'not_exists' }), true)
  assert.equal(ok({ source: 'json', property: 'data.id', op: 'exists' }), true)
  assert.equal(ok({ source: 'json', property: 'data.id', op: 'gt', expected: '10' }), false)
  assert.equal(ok({ source: 'header', property: 'Content-Type', op: 'contains', expected: 'json' }), true)
  assert.equal(ok({ source: 'header', property: 'X-Nope', op: 'exists' }), false)
  assert.equal(ok({ source: 'body', op: 'matches', expected: '/"ID":7/i' }), true)
  assert.equal(checkTest(newTest({ source: 'body', op: 'matches', expected: '(' }), res).message.startsWith('invalid regex'), true)
  assert.equal(checkTest(newTest({ source: 'json', property: 'x', op: 'eq', expected: '1' }), { ...res, json: undefined }).message, 'Response is not JSON')
  assert.equal(describeTest(newTest({ source: 'json', property: 'data.id', op: 'exists' })), 'JSON data.id exists')
})

test('runTests: skips disabled and incomplete tests, resolves {{variables}} in expected values', () => {
  const res = { status: 200, time: 5, headers: [], body: '{"id":"u1"}', json: { id: 'u1' } }
  const tests = [
    newTest({ source: 'json', property: 'id', op: 'eq', expected: '{{userId}}' }),
    newTest({ enabled: false }),
    newTest({ source: 'header', property: '', op: 'exists' }), // no header name: skipped
    newTest({ source: 'status', op: 'eq', expected: '404' }),
  ]
  const out = runTests(tests, res, (s) => s.replace('{{userId}}', 'u1'))
  assert.deepEqual(out.map((r) => r.ok), [true, false])
  assert.equal(out[0].name, 'JSON id equals u1')
  assert.deepEqual(summarize(out), { passed: 1, failed: 1, total: 2 })
})

// ---- Server-Sent Events ---------------------------------------------------------------
import { connectSse, createSseParser } from '../src/lib/sse.js'
import http from 'node:http'

test('SSE parser: fields, multi-line data, ids, retry, comments, CRLF split across chunks', () => {
  const events = []
  const retries = []
  const comments = []
  const p = createSseParser({ onEvent: (e) => events.push(e), onRetry: (ms) => retries.push(ms), onComment: (c) => comments.push(c) })
  const stream = '﻿: hello\r\nevent: price\r\nid: 1\r\ndata: {"a":1}\r\n\r\ndata: line1\ndata:line2\n\nretry: 2500\nid: 2\ndata\n\nevent: ignored-no-data\n\nid: 3\ndata: tail'
  // feed one character at a time: every boundary, including \r|\n, is exercised
  for (const ch of stream) p.push(ch)
  p.end()
  assert.deepEqual(events, [
    { event: 'price', data: '{"a":1}', id: '1' },
    { event: 'message', data: 'line1\nline2', id: '1' },
    { event: 'message', data: '', id: '2' },
  ])
  assert.deepEqual(retries, [2500])
  assert.deepEqual(comments, ['hello'])
  assert.equal(p.lastEventId, '3') // the unterminated last event is dropped, its id still counts
})

test('SSE client: streams events, rejects non-streams, reconnects with Last-Event-ID', async () => {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url, last: req.headers['last-event-id'] || null, accept: req.headers.accept, auth: req.headers.authorization })
    if (req.url === '/json') return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"no":"stream"}')
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const n = Number(req.headers['last-event-id'] || 0)
    res.write('retry: 50\n\n')
    res.write(`id: ${n + 1}\nevent: tick\ndata: ${n + 1}\n\n`)
    setTimeout(() => res.end(`id: ${n + 2}\ndata: ${n + 2}\n\n`), 20)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const run = (path, reconnect, until) =>
    new Promise((resolve) => {
      const log = []
      let conn
      const cb = {
        onOpen: () => log.push('open'),
        onMessage: (e) => {
          log.push(`${e.event}:${e.data}#${e.id}`)
          if (until(log)) conn.close()
        },
        onInfo: (t) => log.push(`info:${t.split(' ')[0]}`),
        onError: (t) => log.push(`error:${t.split('\n')[0]}`),
        onClose: ({ reason }) => resolve({ log, reason }),
      }
      conn = connectSse({ method: 'GET', url: base + path, headers: [{ key: 'Accept', value: 'text/event-stream' }, { key: 'Authorization', value: 'Bearer t' }], body: null }, { mode: 'direct', reconnect }, cb)
    })
  try {
    const once = await run('/events', false, () => false)
    assert.deepEqual(once.log, ['open', 'tick:1#1', 'message:2#2'])
    assert.equal(once.reason, 'stream ended by the server')

    const again = await run('/events', true, (log) => log.includes('message:4#4'))
    assert.deepEqual(again.log, ['open', 'tick:1#1', 'message:2#2', 'info:Stream', 'info:Reconnected', 'tick:3#3', 'message:4#4'])
    assert.equal(seen.at(-1).last, '2')
    assert.equal(seen.at(-1).auth, 'Bearer t')

    const bad = await run('/json', true, () => false)
    assert.match(bad.log[0], /^error:Not an event stream: Content-Type is "application\/json"/)
    assert.equal(bad.reason, 'not an event stream')
  } finally {
    server.close()
  }
})

test('SSE: Accept header added, snippets, OpenAPI event-stream operations', async () => {
  const req = newRequest('s', { protocol: 'sse', url: 'api.test/events' })
  const r = resolveRequest(req, new Map())
  assert.equal(r.url, 'http://api.test/events')
  assert.deepEqual(r.headers, [{ key: 'Accept', value: 'text/event-stream' }])
  assert.match(generateSnippet('curl-sse', r), /^curl --no-buffer /)
  assert.match(generateSnippet('sse-js', r), /new EventSource\("http:\/\/api\.test\/events"\)/)
  const { collection } = importOpenApi('openapi: 3.0.0\ninfo: { title: S, version: "1" }\npaths:\n  /stream:\n    get:\n      responses:\n        "200":\n          description: events\n          content:\n            text/event-stream:\n              schema: { type: string }\n')
  assert.equal(collection.items[0].protocol, 'sse')
  assert.deepEqual(collection.items[0].sse, { reconnect: false, lastEventId: '' })
})

// ---- Streaming HTTP responses (chunked / NDJSON) -------------------------------------
import { parseJsonLines, sendRequest } from '../src/lib/http.js'

test('parseJsonLines: declared NDJSON / JSON Lines / json-seq, detected multi-line JSON, plain text', () => {
  assert.deepEqual(parseJsonLines('{"a":1}\n{"a":2}\n', 'application/x-ndjson'), [{ a: 1 }, { a: 2 }])
  assert.deepEqual(parseJsonLines('{"only":1}', 'application/jsonl'), [{ only: 1 }])
  assert.deepEqual(parseJsonLines('\x1e{"a":1}\n\x1e[2]\n', 'application/json-seq'), [{ a: 1 }, [2]])
  assert.deepEqual(parseJsonLines('1\r\n"two"\r\n', 'text/plain'), [1, 'two'])
  assert.equal(parseJsonLines('hello\nworld', 'text/plain'), undefined)
  assert.equal(parseJsonLines('{"a":1}', 'text/plain'), undefined) // one line without a declared type
})

test('sendRequest streams text bodies: progress, NDJSON lines, stop keeps the partial body', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    let i = 0
    const t = setInterval(() => {
      res.write(JSON.stringify({ i: ++i }) + '\n')
      if (i === 4 && req.url === '/done') {
        clearInterval(t)
        res.end()
      }
    }, 100)
    res.on('close', () => clearInterval(t))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    const seen = []
    const done = await sendRequest({ method: 'GET', url: url + '/done', headers: [], body: null }, { onProgress: (p) => seen.push(p.bytes) })
    assert.deepEqual(done.lines, [{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }])
    assert.equal(done.json, undefined)
    assert.ok(seen.length >= 3 && seen[0] === 0 && seen.at(-1) > 0, `progress: ${seen}`) // updates while the body arrived
    assert.ok(done.time - done.ttfb >= 250)

    const ctl = new AbortController()
    const partial = sendRequest({ method: 'GET', url: url + '/forever', headers: [], body: null }, { signal: ctl.signal, onProgress: (p) => p.bytes > 20 && ctl.abort() })
    const r = await partial
    assert.equal(r.aborted, true)
    assert.ok(r.lines.length >= 2)

    // without onProgress (Collection Runner), stopping is an AbortError as before
    const ctl2 = new AbortController()
    setTimeout(() => ctl2.abort(), 150)
    await assert.rejects(sendRequest({ method: 'GET', url: url + '/forever', headers: [], body: null }, { signal: ctl2.signal }), { name: 'AbortError' })
  } finally {
    server.close()
  }
})

test('tests and JSON paths work on NDJSON lines', () => {
  const res = { status: 200, time: 1, headers: [], body: '{"id":1}\n{"id":2}\n', json: undefined, lines: [{ id: 1 }, { id: 2 }] }
  assert.equal(checkTest(newTest({ source: 'json', property: 'length', op: 'eq', expected: '2' }), res).ok, true)
  assert.equal(checkTest(newTest({ source: 'json', property: '[1].id', op: 'eq', expected: '2' }), res).ok, true)
})

// ---- Response diff -------------------------------------------------------------------
import { diffLines, diffStats, inlineChange, jsonChanges, sideBySide, sortKeysDeep } from '../src/lib/diff.js'

test('diffLines: minimal edit script that rebuilds both sides', () => {
  const rebuild = (ops, side) => ops.filter((o) => o.type === 'equal' || o.type === (side === 'a' ? 'del' : 'add')).map((o) => o.text)
  const cases = [
    ['a\nb\nc', 'a\nb\nc'],
    ['', 'x\ny'],
    ['x\ny', ''],
    ['a\nb\nc\nd', 'a\nc\nd\ne'],
    ['1\n2\n3\n4\n5\n6', '0\n1\n3\n4\nX\n6\n7'],
  ]
  for (const [a, b] of cases) {
    const { ops, truncated } = diffLines(a, b)
    assert.equal(truncated, false)
    assert.deepEqual(rebuild(ops, 'a'), a ? a.split('\n') : [])
    assert.deepEqual(rebuild(ops, 'b'), b ? b.split('\n') : [])
  }
  assert.deepEqual(diffStats(diffLines('a\nb\nc\nd', 'a\nc\nd\ne').ops), { added: 1, removed: 1 })
  assert.deepEqual(diffStats(diffLines('1\n2\n3\n4\n5\n6', '0\n1\n3\n4\nX\n6\n7').ops), { added: 3, removed: 2 }) // shortest script
  // random check against both rebuilds
  for (let t = 0; t < 200; t++) {
    const gen = () => Array.from({ length: Math.floor(Math.random() * 12) }, () => 'abc'[Math.floor(Math.random() * 3)]).join('\n')
    const a = gen()
    const b = gen()
    const { ops } = diffLines(a, b)
    assert.deepEqual(rebuild(ops, 'a'), a ? a.split('\n') : [])
    assert.deepEqual(rebuild(ops, 'b'), b ? b.split('\n') : [])
  }
  const big = diffLines(Array.from({ length: 300 }, (_, i) => 'a' + i).join('\n'), Array.from({ length: 300 }, (_, i) => 'b' + i).join('\n'), { maxEdits: 50 })
  assert.equal(big.truncated, true)
})

test('sideBySide pairs changes and collapses unchanged runs; inlineChange', () => {
  const a = Array.from({ length: 20 }, (_, i) => `line ${i}`)
  const b = [...a]
  b[10] = 'line ten'
  const rows = sideBySide(diffLines(a.join('\n'), b.join('\n')).ops, { context: 2 })
  assert.deepEqual(rows.map((r) => (r.gap ? `gap ${r.gap}` : `${r.left?.type}/${r.right?.type}`)), ['gap 8', 'equal/equal', 'equal/equal', 'del/add', 'equal/equal', 'equal/equal', 'gap 7'])
  assert.deepEqual(rows[3].left.n, 11)
  assert.deepEqual(inlineChange('"id": 41,', '"id": 42,', 'right'), { pre: '"id": 4', mid: '2', post: ',' })
})

test('jsonChanges and sortKeysDeep', () => {
  const a = { id: 1, user: { name: 'A', roles: ['x', 'y'] }, gone: true, 'odd key': 1 }
  const b = { id: 2, user: { name: 'A', roles: ['x'], email: 'e' }, 'odd key': '1' }
  assert.deepEqual(jsonChanges(a, b), [
    { path: '$.id', type: 'changed', from: 1, to: 2 },
    { path: '$.user.roles[1]', type: 'removed', from: 'y' },
    { path: '$.user.email', type: 'added', to: 'e' },
    { path: '$.gone', type: 'removed', from: true },
    { path: '$["odd key"]', type: 'changed', from: 1, to: '1' },
  ])
  assert.deepEqual(jsonChanges({ a: [1] }, { a: [1] }), [])
  assert.equal(JSON.stringify(sortKeysDeep({ b: 1, a: { d: 1, c: [{ z: 1, y: 2 }] } })), '{"a":{"c":[{"y":2,"z":1}],"d":1},"b":1}')
})

// ---- Response metrics (time / size / network) ------------------------------------------
import { buildMetrics, estimateRequestSize, estimateResponseHeaderSize, fromResourceTiming, networkTime } from '../src/lib/metrics.js'

test('metrics: request / response size estimates', () => {
  const r = estimateRequestSize({ method: 'POST', url: 'https://api.test/v1/items?x=1', headers: [{ key: 'Content-Type', value: 'application/json' }], body: { mode: 'raw', raw: '{"é":1}' } })
  assert.equal(r.headers, 'POST /v1/items?x=1 HTTP/1.1\r\nHost: api.test\r\n'.length + 2 + 'Content-Type: application/json\r\n'.length)
  assert.equal(r.body, 8) // 7 characters, é is two bytes
  assert.equal(estimateRequestSize({ method: 'POST', url: 'https://a.test', headers: [], body: { mode: 'urlencoded', fields: [{ key: 'a b', value: '1' }] } }).body, 'a%20b=1'.length)
  assert.equal(estimateResponseHeaderSize(200, 'OK', [{ key: 'a', value: 'b' }]), 'HTTP/1.1 200 OK\r\n'.length + 2 + 'a: b\r\n'.length)
})

test('metrics: Resource Timing with and without Timing-Allow-Origin, agent details', () => {
  const full = fromResourceTiming({ nextHopProtocol: 'h2', fetchStart: 10, domainLookupStart: 11, domainLookupEnd: 15, connectStart: 15, secureConnectionStart: 20, connectEnd: 30, requestStart: 31, responseStart: 81, responseEnd: 90, transferSize: 1300, encodedBodySize: 1000 })
  assert.deepEqual(full.timing, { socket: 1, dns: 4, tcp: 5, tls: 10, ttfb: 50, download: 9 })
  assert.equal(full.httpVersion, '2')
  assert.deepEqual(full.size, { responseBody: 1000, responseHeaders: 300 })
  const reused = fromResourceTiming({ nextHopProtocol: 'http/1.1', fetchStart: 1, domainLookupStart: 1, domainLookupEnd: 1, connectStart: 1, connectEnd: 1, requestStart: 2, responseStart: 5, responseEnd: 6 })
  assert.equal(reused.timing.dns, 'reused')
  const hidden = fromResourceTiming({ nextHopProtocol: '', fetchStart: 1, requestStart: 0, responseStart: 0, responseEnd: 40, transferSize: 0, encodedBodySize: 0 })
  assert.equal(hidden.detailed, false)

  const base = { mode: 'direct', prepare: 2, ttfb: 60, download: 5, process: 1, requestSize: { headers: 100, body: 0 }, responseHeaders: 200, responseBody: 5000 }
  const basic = buildMetrics(base, null, 'basic')
  assert.equal(basic.source, 'basic')
  assert.equal(basic.timing.dns, null)
  assert.match(basic.note, /Timing-Allow-Origin/)
  assert.equal(networkTime(basic.timing), 65)

  const agent = buildMetrics({ ...base, mode: 'agent' }, { timing: { socket: 0.5, dns: 'reused', tcp: 'reused', tls: 'reused', ttfb: 61, download: 1.2, total: 63 }, size: { requestHeaders: 966, requestBody: 32, responseHeaders: 463, responseBody: 1200 }, network: { httpVersion: '1.1', remoteAddress: '1.2.3.4:443', tlsProtocol: 'TLSv1.3', certCN: '*.example.com' } }, 'agent')
  assert.equal(agent.note, null)
  assert.equal(agent.timing.prepare, 2)
  assert.equal(agent.timing.ttfb, 61)
  assert.deepEqual([agent.size.requestHeaders, agent.size.responseBody, agent.size.responseBodyDecoded, agent.size.estimated.requestHeaders], [966, 1200, 5000, false])
  assert.equal(agent.network.certCN, '*.example.com')
  assert.match(buildMetrics({ ...base, mode: 'agent' }, null, 'agent').note, /too old/)
})
