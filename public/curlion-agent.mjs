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
import zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'

const VERSION = '1.0.0'

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
