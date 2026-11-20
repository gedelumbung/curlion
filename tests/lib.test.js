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
