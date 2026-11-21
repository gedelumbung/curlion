#!/usr/bin/env node
// Curlion Agent: lets the Curlion web app send requests from *your* computer, so it can
// reach localhost, your local network and APIs without CORS (like Postman's Desktop Agent).
//
//   node curlion-agent.mjs --origin https://your-curlion-site.netlify.app
//
// Options
//   --origin <url>   Curlion site allowed to use this agent (repeatable). Required.
//   --port <n>       Port to listen on (default 5577). Curlion must use the same port.
//   --strict-tls     Reject self-signed / invalid TLS certificates (default: accepted,
//                    since local HTTPS APIs often use them).
//
// Security: listens on 127.0.0.1 only, answers only the --origin sites (checked on every
// request, including CORS preflight), and rejects other Host headers (DNS rebinding).
// Requires Node.js 18+. No dependencies.

import http from 'node:http'
import https from 'node:https'
import http2 from 'node:http2'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'

const VERSION = '1.1.0' // 1.1: gRPC (HTTP/2) and WebSocket bridge

// ---- options ----------------------------------------------------------------
const args = process.argv.slice(2)
const opt = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : a.startsWith(name + '=') ? [a.slice(name.length + 1)] : []))
const origins = new Set(
  [...opt('--origin'), ...(process.env.CURLION_AGENT_ORIGINS || '').split(',')]
    .map((o) => o?.trim().replace(/\/+$/, ''))
    .filter(Boolean),
)
const PORT = Number(opt('--port')[0] || process.env.CURLION_AGENT_PORT || 5577)
const STRICT_TLS = args.includes('--strict-tls')

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node curlion-agent.mjs --origin https://your-curlion-site [--port 5577] [--strict-tls]')
  process.exit(0)
}
if (!origins.size) {
  console.error('Curlion Agent: pass the Curlion site that may use this agent, e.g.\n  node curlion-agent.mjs --origin https://your-curlion-site.netlify.app')
  process.exit(1)
}
for (const o of origins) {
  try {
    new URL(o)
  } catch {
    console.error(`Curlion Agent: invalid --origin "${o}"`)
    process.exit(1)
  }
}

// ---- helpers ----------------------------------------------------------------
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length'])
const EXPOSE = 'X-Curlion-Status, X-Curlion-Status-Text, X-Curlion-Headers, X-Curlion-Error, Content-Disposition'
const okHost = (host) => new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${PORT}$`, 'i').test(host || '')

function cors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Private-Network', 'true')
  res.setHeader('Access-Control-Expose-Headers', EXPOSE)
  res.setHeader('Access-Control-Max-Age', '600')
}

function fail(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Curlion-Error': '1', 'Cache-Control': 'no-store' })
  res.end(message)
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

/** One HTTP(S) request without following redirects. */
function once(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(url, { method, headers, rejectUnauthorized: STRICT_TLS }, resolve)
    req.on('error', reject)
    req.setTimeout(120_000, () => req.destroy(new Error('timed out after 120s')))
    if (body?.length) req.write(body)
    req.end()
  })
}

/** Send the request, following redirects like a browser (max 10). */
async function send(url, method, headers, body) {
  for (let hop = 0; hop <= 10; hop++) {
    const res = await once(url, method, headers, body)
    const loc = res.headers.location
    if (![301, 302, 303, 307, 308].includes(res.statusCode) || !loc) return { res, url }
    res.resume()
    const next = new URL(loc, url)
    if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === 'POST')) {
      method = 'GET'
      body = null
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^content-(type|length)$/i.test(k)))
    }
    if (next.host !== url.host) headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(authorization|cookie|host)$/i.test(k)))
    url = next
  }
  throw new Error('too many redirects')
}

function decoder(encoding) {
  switch ((encoding || '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip()
    case 'deflate':
      return zlib.createInflate()
    case 'br':
      return zlib.createBrotliDecompress()
    default:
      return null
  }
}

// ---- server -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const origin = (req.headers.origin || '').replace(/\/+$/, '')
  if (!okHost(req.headers.host)) return fail(res, 421, 'Unexpected Host header')
  if (!origins.has(origin)) return fail(res, 403, `Origin ${origin || '(none)'} is not allowed. Start the agent with --origin ${origin || '<curlion-site>'}`)
  cors(res, origin)

  const path = new URL(req.url, 'http://x').pathname
  if (req.method === 'OPTIONS') return res.writeHead(204).end()

  if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify({ name: 'curlion-agent', version: VERSION }))
  }
  if (req.method === 'POST' && path === '/grpc') return handleGrpc(req, res)
  if (req.method === 'GET' && path === '/ws/connect') return handleWsConnect(req, res)
  if (req.method === 'POST' && (path === '/ws/send' || path === '/ws/close')) return handleWsCommand(req, res, path)
  if (req.method !== 'POST' || path !== '/proxy') return fail(res, 404, 'Not found')

  let target
  let list = []
  try {
    target = new URL(req.headers['x-curlion-url'])
    list = JSON.parse(decodeURIComponent(req.headers['x-curlion-headers'] || '%5B%5D'))
  } catch {
    return fail(res, 400, 'Invalid X-Curlion-Url or X-Curlion-Headers')
  }
  if (!['http:', 'https:'].includes(target.protocol)) return fail(res, 400, 'Only http and https URLs are supported')
  const method = String(req.headers['x-curlion-method'] || 'GET').toUpperCase()

  // Headers exactly as the user set them (Cookie, Host, User-Agent… included).
  const headers = {}
  for (const h of list) {
    if (!h?.key || HOP_BY_HOP.has(h.key.toLowerCase())) continue
    const k = h.key
    headers[k] = headers[k] !== undefined ? `${headers[k]}, ${h.value ?? ''}` : String(h.value ?? '')
  }
  const hasCt = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')
  if (!hasCt && req.headers['content-type'] && req.headers['content-type'] !== 'text/plain;charset=UTF-8') {
    headers['Content-Type'] = req.headers['content-type'] // keeps the multipart boundary
  }

  const started = Date.now()
  let body = null
  if (!['GET', 'HEAD'].includes(method)) {
    body = await readBody(req)
    headers['Content-Length'] = String(body.length)
  } else req.resume()

  let upstream
  try {
    upstream = (await send(target, method, headers, body)).res
  } catch (err) {
    const why = describeError(err)
    log(method, target, `ERROR ${why}`, started)
    return fail(res, 502, `Could not reach ${target.host}: ${why}`)
  }

  const respHeaders = []
  for (let i = 0; i < upstream.rawHeaders.length; i += 2) respHeaders.push({ key: upstream.rawHeaders[i].toLowerCase(), value: upstream.rawHeaders[i + 1] })
  const out = {
    'X-Curlion-Status': String(upstream.statusCode),
    'X-Curlion-Status-Text': (upstream.statusMessage || '').replace(/[^\t\x20-\x7e]/g, ''),
    'X-Curlion-Headers': encodeURIComponent(JSON.stringify(respHeaders)),
    'Cache-Control': 'no-store',
  }
  if (upstream.headers['content-type']) out['Content-Type'] = upstream.headers['content-type']
  if (upstream.headers['content-disposition']) out['Content-Disposition'] = upstream.headers['content-disposition']
  res.writeHead(200, out)
  log(method, target, upstream.statusCode, started)

  if (method === 'HEAD' || [204, 205, 304].includes(upstream.statusCode)) {
    upstream.resume()
    return res.end()
  }
  const dec = decoder(upstream.headers['content-encoding'])
  try {
    await (dec ? pipeline(upstream, dec, res) : pipeline(upstream, res))
  } catch {
    res.destroy()
  }
})

// ---- gRPC over HTTP/2 -------------------------------------------------------------
// The browser sends { target: 'host:port', tls, path: '/pkg.Service/Method', metadata: [{key,value}],
// messages: [base64 protobuf] } and gets back the raw reply frames plus headers/trailers.

async function handleGrpc(req, res) {
  let input
  try {
    input = JSON.parse((await readBody(req)).toString('utf8'))
  } catch {
    return fail(res, 400, 'Invalid JSON')
  }
  const started = Date.now()
  const target = String(input.target || '').replace(/^grpcs?:\/\//, '')
  try {
    const out = await grpcCall({ ...input, target })
    log('gRPC', `${target}${input.path}`, `${out.grpcStatus ?? '?'} ${out.grpcMessage || ''}`.trim(), started)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ ...out, time: Date.now() - started }))
  } catch (err) {
    const why = describeError(err)
    log('gRPC', `${target}${input.path}`, `ERROR ${why}`, started)
    fail(res, 502, `Could not reach ${target}: ${why}`)
  }
}

function grpcCall({ target, tls, path, metadata = [], messages = [], timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`${tls ? 'https' : 'http'}://${target}`, { rejectUnauthorized: STRICT_TLS })
    let settled = false
    const done = (fn, v) => {
      if (settled) return
      settled = true
      client.close()
      fn(v)
    }
    client.on('error', (e) => done(reject, e))
    const headers = { ':method': 'POST', ':path': path, 'content-type': 'application/grpc+proto', te: 'trailers', 'grpc-accept-encoding': 'identity', 'user-agent': `curlion-agent/${VERSION}` }
    for (const m of metadata) if (m?.key) headers[m.key.toLowerCase()] = String(m.value ?? '')
    const stream = client.request(headers)
    stream.setTimeout(timeoutMs, () => stream.close(http2.constants.NGHTTP2_CANCEL))
    let respHeaders = {}
    let trailers = {}
    const chunks = []
    stream.on('response', (h) => (respHeaders = h))
    stream.on('trailers', (t) => (trailers = t))
    stream.on('data', (c) => chunks.push(c))
    stream.on('error', (e) => done(reject, e))
    stream.on('close', () => {
      const data = Buffer.concat(chunks)
      const replies = []
      for (let i = 0; i + 5 <= data.length; ) {
        const compressed = data[i]
        const len = data.readUInt32BE(i + 1)
        if (compressed) return done(reject, new Error('compressed gRPC messages are not supported'))
        replies.push(data.subarray(i + 5, i + 5 + len).toString('base64'))
        i += 5 + len
      }
      const pick = (k) => trailers[k] ?? respHeaders[k]
      const plain = (h) => Object.entries(h).filter(([k]) => !k.startsWith(':')).map(([key, value]) => ({ key, value: String(value) }))
      done(resolve, {
        httpStatus: respHeaders[':status'] || 0,
        grpcStatus: pick('grpc-status') !== undefined ? Number(pick('grpc-status')) : null,
        grpcMessage: pick('grpc-message') ? decodeURIComponent(pick('grpc-message')) : '',
        headers: plain(respHeaders),
        trailers: plain(trailers),
        messages: replies,
      })
    })
    for (const b64 of messages) {
      const body = Buffer.from(b64, 'base64')
      const prefix = Buffer.alloc(5)
      prefix.writeUInt32BE(body.length, 1)
      stream.write(Buffer.concat([prefix, body]))
    }
    stream.end()
  })
}

// ---- WebSocket bridge --------------------------------------------------------------
// GET /ws/connect?target&headers&protocols opens the real socket and streams events to the
// browser as Server-Sent Events; POST /ws/send|/ws/close?id=… drive it.

const sockets = new Map() // id -> { send(text), close() }

function handleWsConnect(req, res) {
  const q = new URL(req.url, 'http://x').searchParams
  let target
  let headers = []
  try {
    target = new URL(q.get('target'))
    headers = JSON.parse(q.get('headers') || '[]')
  } catch {
    return fail(res, 400, 'Invalid target or headers')
  }
  if (!['ws:', 'wss:'].includes(target.protocol)) return fail(res, 400, 'Only ws:// and wss:// URLs are supported')
  const protocols = (q.get('protocols') || '').split(',').map((s) => s.trim()).filter(Boolean)
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  const id = crypto.randomUUID()
  const started = Date.now()
  const ws = wsClient(target, headers, protocols, {
    open: (protocol) => {
      sockets.set(id, ws)
      log('WS', target, 'open', started)
      emit('open-ws', { id, protocol })
    },
    message: (data, binary) => emit('message', binary ? { binary: true, size: data.length } : { data: data.toString('utf8') }),
    error: (message) => emit('ws-error', { message }),
    close: (code, reason) => {
      sockets.delete(id)
      log('WS', target, `closed ${code}`, started)
      emit('close-ws', { code, reason })
      res.end()
    },
  })
  const ping = setInterval(() => res.write(': keep-alive\n\n'), 15_000)
  res.on('close', () => {
    clearInterval(ping)
    if (sockets.has(id)) ws.close(1000, 'browser disconnected')
  })
}

async function handleWsCommand(req, res, path) {
  const id = new URL(req.url, 'http://x').searchParams.get('id')
  const ws = sockets.get(id)
  let body = {}
  try {
    body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
  } catch {}
  if (!ws) return fail(res, 404, 'No such connection')
  if (path === '/ws/send') ws.send(String(body.data ?? ''))
  else ws.close(1000, 'Closed by user')
  res.writeHead(204).end()
}

/** Minimal RFC 6455 client: handshake with custom headers, masked frames out, ping/pong, close. */
function wsClient(url, headers, protocols, on) {
  const key = crypto.randomBytes(16).toString('base64')
  const reqHeaders = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
  if (protocols.length) reqHeaders['Sec-WebSocket-Protocol'] = protocols.join(', ')
  for (const h of headers) if (h?.key && !HOP_BY_HOP.has(h.key.toLowerCase())) reqHeaders[h.key] = String(h.value ?? '')
  const lib = url.protocol === 'wss:' ? https : http
  const httpUrl = new URL(url)
  httpUrl.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  let socket = null
  let closed = false
  const finish = (code, reason) => {
    if (closed) return
    closed = true
    socket?.destroy()
    on.close(code, reason)
  }
  const frame = (opcode, payload) => {
    const len = payload.length
    const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len]) : len < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b })()])
    const mask = crypto.randomBytes(4)
    const body = Buffer.from(payload)
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3]
    socket?.write(Buffer.concat([head, mask, body]))
  }
  const req = lib.request(httpUrl, { headers: reqHeaders, rejectUnauthorized: STRICT_TLS })
  req.on('response', (r) => {
    on.error(`Server answered HTTP ${r.statusCode} instead of switching to WebSocket`)
    r.resume()
    finish(1006, `HTTP ${r.statusCode}`)
  })
  req.on('error', (e) => {
    on.error(describeError(e))
    finish(1006, describeError(e))
  })
  req.on('upgrade', (r, sock, head) => {
    const expected = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    if (r.headers['sec-websocket-accept'] !== expected) {
      on.error('Invalid WebSocket handshake')
      sock.destroy()
      return finish(1006, 'bad handshake')
    }
    socket = sock
    on.open(r.headers['sec-websocket-protocol'] || '')
    let buf = head?.length ? Buffer.from(head) : Buffer.alloc(0)
    let fragments = []
    let fragOpcode = 0
    const parse = () => {
      while (buf.length >= 2) {
        const fin = buf[0] & 0x80
        const opcode = buf[0] & 0x0f
        let len = buf[1] & 0x7f
        let off = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          off = 4
        } else if (len === 127) {
          if (buf.length < 10) return
          len = Number(buf.readBigUInt64BE(2))
          off = 10
        }
        const masked = buf[1] & 0x80
        if (masked) off += 4
        if (buf.length < off + len) return
        const payload = buf.subarray(off, off + len)
        buf = buf.subarray(off + len)
        if (opcode === 0x8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
          frame(0x8, payload.subarray(0, 2))
          return finish(code, payload.subarray(2).toString('utf8'))
        }
        if (opcode === 0x9) frame(0xa, payload)
        else if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
          if (opcode) fragOpcode = opcode
          fragments.push(Buffer.from(payload))
          if (fin) {
            on.message(Buffer.concat(fragments), fragOpcode === 0x2)
            fragments = []
          }
        }
      }
    }
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      parse()
    })
    sock.on('close', () => finish(1006, 'connection closed'))
    sock.on('error', (e) => on.error(e.message))
    parse()
  })
  req.end()
  return {
    send: (text) => frame(0x1, Buffer.from(text, 'utf8')),
    close: (code = 1000, reason = '') => {
      const p = Buffer.alloc(2 + Buffer.byteLength(reason))
      p.writeUInt16BE(code, 0)
      p.write(reason, 2)
      frame(0x8, p)
      setTimeout(() => finish(code, reason), 500)
    },
  }
}

function describeError(err) {
  const code = err.code || err.errors?.[0]?.code
  const known = {
    ECONNREFUSED: 'connection refused (nothing is listening on that port)',
    ENOTFOUND: 'host not found',
    ETIMEDOUT: 'connection timed out',
    ECONNRESET: 'connection reset by the server',
    EHOSTUNREACH: 'host unreachable',
  }
  return known[code] || err.message || code || String(err)
}

function log(method, url, result, started) {
  const time = new Date().toLocaleTimeString(undefined, { hour12: false })
  console.log(`${time}  ${method.padEnd(7)} ${String(url).slice(0, 100)}  →  ${result}  ${Date.now() - started}ms`)
}

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Curlion Agent: port ${PORT} is already in use (another agent running?). Use --port.` : err)
  process.exit(1)
})
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Curlion Agent ${VERSION} listening on http://127.0.0.1:${PORT}`)
  console.log(`Allowed Curlion site(s): ${[...origins].join(', ')}`)
  console.log(`TLS certificates: ${STRICT_TLS ? 'verified' : 'self-signed accepted (use --strict-tls to verify)'}`)
  console.log('Keep this window open while you use Agent mode. Ctrl+C to stop.\n')
})
