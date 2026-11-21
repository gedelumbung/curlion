// Netlify Edge Function: CORS proxy.
// The browser POSTs to /api/proxy with the target in X-Curlion-* headers and the
// request body as-is. We forward it and return the upstream response, always with
// HTTP 200; the real status and headers travel in X-Curlion-* response headers
// (so 204/304/1xx and opaque headers survive the hop).

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i

const fail = (status, message) =>
  new Response(message, { status, headers: { 'X-Curlion-Error': '1', 'Content-Type': 'text/plain' } })

export default async (request) => {
  if (request.method !== 'POST') return fail(405, 'Use POST')

  // Only accept calls from this site's own pages (keeps it from becoming an open proxy).
  const origin = request.headers.get('origin')
  const self = new URL(request.url).origin
  if (origin && origin !== self) return fail(403, 'Cross-origin use of the proxy is not allowed')

  const target = request.headers.get('x-curlion-url')
  const method = (request.headers.get('x-curlion-method') || 'GET').toUpperCase()
  let headers = []
  try {
    headers = JSON.parse(decodeURIComponent(request.headers.get('x-curlion-headers') || '%5B%5D'))
  } catch {
    return fail(400, 'Invalid X-Curlion-Headers')
  }

  let url
  try {
    url = new URL(target)
  } catch {
    return fail(400, 'Invalid target URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) return fail(400, 'Only http and https URLs are supported')
  if (PRIVATE_HOST.test(url.hostname)) {
    return fail(400, 'Private/localhost addresses cannot be reached through the cloud proxy. Use Direct mode.')
  }

  const out = new Headers()
  for (const h of headers) {
    if (!h?.key || HOP_BY_HOP.has(h.key.toLowerCase())) continue
    try {
      out.append(h.key, h.value ?? '')
    } catch {
      return fail(400, `Invalid header: ${h.key}`)
    }
  }
  // multipart bodies: keep the browser-generated boundary
  const incomingCt = request.headers.get('content-type')
  if (incomingCt && !out.has('content-type')) out.set('content-type', incomingCt)

  const hasBody = !['GET', 'HEAD'].includes(method)
  let upstream
  try {
    upstream = await fetch(url, {
      method,
      headers: out,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: 'follow',
    })
  } catch (err) {
    return fail(502, `Could not reach ${url.host}: ${err.message}`)
  }

  const respHeaders = []
  upstream.headers.forEach((value, key) => respHeaders.push({ key, value }))

  const res = new Headers({
    'X-Curlion-Status': String(upstream.status),
    'X-Curlion-Status-Text': upstream.statusText || '',
    'X-Curlion-Headers': encodeURIComponent(JSON.stringify(respHeaders)),
    'Cache-Control': 'no-store',
  })
  const ct = upstream.headers.get('content-type')
  if (ct) res.set('Content-Type', ct)
  const cd = upstream.headers.get('content-disposition')
  if (cd) res.set('Content-Disposition', cd)

  const noBody = method === 'HEAD' || [101, 204, 205, 304].includes(upstream.status)
  return new Response(noBody ? null : upstream.body, { status: 200, headers: res })
}
