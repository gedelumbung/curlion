// Response details: where the time went, how big request and response were, and what the
// connection looked like. The detail depends on the send mode:
// - Agent: everything, measured on the agent's own socket (GET /timing on the agent).
// - Direct: phases from the browser's Resource Timing when the server sends
//   Timing-Allow-Origin; otherwise only what fetch itself shows.
// - Proxy: only what fetch shows (the proxy hop is not the API's connection).
// Sizes the browser cannot see (request headers it adds, compressed bytes) are estimated.

const enc = new TextEncoder()
const bytes = (s) => enc.encode(String(s ?? '')).length

/** Request size: headers as written (plus the request line and Host), body as sent. */
export function estimateRequestSize(resolved) {
  let path = '/'
  let host = ''
  try {
    const u = new URL(resolved.url)
    path = u.pathname + u.search
    host = u.host
  } catch {}
  let headers = bytes(`${resolved.method} ${path} HTTP/1.1\r\nHost: ${host}\r\n`) + 2
  for (const h of resolved.headers || []) headers += bytes(`${h.key}: ${h.value}\r\n`)
  let body = 0
  const b = resolved.body
  if (b?.mode === 'raw') body = bytes(b.raw)
  else if (b?.mode === 'urlencoded') body = bytes(b.fields.map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`).join('&'))
  else if (b?.mode === 'form-data') {
    const boundary = 44 // "------WebKitFormBoundary…" line + CRLFs
    for (const f of b.fields) {
      body += boundary + bytes(`Content-Disposition: form-data; name="${f.key}"${f.type === 'file' ? `; filename="${f.fileName || ''}"\r\nContent-Type: ${f.file?.type || 'application/octet-stream'}` : ''}\r\n\r\n`)
      body += f.type === 'file' ? f.file?.size || 0 : bytes(f.value) + 2
    }
    body += boundary
  }
  return { headers, body }
}

/** Response header size from the status line and header list. */
export function estimateResponseHeaderSize(status, statusText, headers, httpVersion = '1.1') {
  let n = bytes(`HTTP/${httpVersion} ${status} ${statusText || ''}\r\n`) + 2
  for (const h of headers || []) n += bytes(`${h.key}: ${h.value}\r\n`)
  return n
}

const HTTP_VERSION = { 'http/1.0': '1.0', 'http/1.1': '1.1', h2: '2', h2c: '2', h3: '3', 'h3-29': '3' }

/**
 * Phases from a PerformanceResourceTiming entry. Cross-origin entries only carry them when the
 * server sends Timing-Allow-Origin; then `detailed` is true.
 */
export function fromResourceTiming(e) {
  if (!e) return null
  const detailed = e.requestStart > 0 // zero for cross-origin requests without Timing-Allow-Origin
  const out = { detailed, httpVersion: HTTP_VERSION[e.nextHopProtocol] || e.nextHopProtocol || null }
  if (detailed) {
    const reused = e.connectStart === e.connectEnd && e.domainLookupStart === e.domainLookupEnd
    const d = (a, b) => (a > 0 && b > 0 ? Math.max(0, +(b - a).toFixed(2)) : null)
    out.timing = {
      socket: d(e.fetchStart, e.domainLookupStart || e.connectStart || e.requestStart),
      dns: reused ? 'reused' : d(e.domainLookupStart, e.domainLookupEnd),
      tcp: reused ? 'reused' : d(e.connectStart, e.secureConnectionStart || e.connectEnd),
      tls: reused ? 'reused' : e.secureConnectionStart > 0 ? d(e.secureConnectionStart, e.connectEnd) : null,
      ttfb: d(e.requestStart, e.responseStart),
      download: d(e.responseStart, e.responseEnd),
    }
  }
  if (e.encodedBodySize > 0 || e.transferSize > 0) {
    out.size = {
      responseBody: e.encodedBodySize || null,
      responseHeaders: e.transferSize > e.encodedBodySize ? e.transferSize - e.encodedBodySize : null,
    }
  }
  return out
}

/**
 * Put the pieces together.
 * @param base what fetch itself measured: { mode, prepare, ttfb (fetch start -> headers), download, process,
 *   requestSize: { headers, body }, responseHeaders (estimate), responseBody (bytes read, decoded) }
 * @param detail fromResourceTiming() result, or the agent's /timing JSON ({ timing, size, network })
 */
export function buildMetrics(base, detail = null, source = 'basic') {
  const timing = { prepare: base.prepare ?? null, socket: null, dns: null, tcp: null, tls: null, ttfb: base.ttfb ?? null, download: base.download ?? null, process: base.process ?? null }
  const size = {
    requestHeaders: base.requestSize?.headers ?? null,
    requestBody: base.requestSize?.body ?? 0,
    responseHeaders: base.responseHeaders ?? null,
    responseBody: base.responseBody ?? 0,
    responseBodyDecoded: base.responseBody ?? 0,
    estimated: { requestHeaders: true, responseHeaders: true },
  }
  let network = { httpVersion: null, localAddress: null, remoteAddress: null, tlsProtocol: null, cipher: null, certCN: null, issuerCN: null, validTo: null, authorized: null, redirects: null }

  if (source === 'agent' && detail) {
    if (detail.timing) {
      const { total, ...phases } = detail.timing
      Object.assign(timing, phases)
    }
    if (detail.size) {
      if (detail.size.requestHeaders) {
        size.requestHeaders = detail.size.requestHeaders
        size.estimated.requestHeaders = false
      }
      size.requestBody = detail.size.requestBody ?? size.requestBody
      if (detail.size.responseHeaders) {
        size.responseHeaders = detail.size.responseHeaders
        size.estimated.responseHeaders = false
      }
      size.responseBody = detail.size.responseBody ?? size.responseBody // on the wire (compressed)
    }
    network = { ...network, ...detail.network }
  } else if (source === 'browser' && detail) {
    if (detail.timing) Object.assign(timing, detail.timing)
    network.httpVersion = detail.httpVersion
    if (detail.size?.responseBody) size.responseBody = detail.size.responseBody
    if (detail.size?.responseHeaders) {
      size.responseHeaders = detail.size.responseHeaders
      size.estimated.responseHeaders = false
    }
  }

  const note =
    source === 'agent' && detail
      ? null
      : base.mode === 'proxy'
        ? 'Proxy mode: connection details are not visible to the browser. Agent mode measures every phase.'
        : source === 'browser' && detail?.timing
          ? 'Measured by the browser. Addresses and certificates are available in Agent mode.'
          : base.mode === 'agent'
            ? 'This Curlion Agent is too old to report details. Download the latest agent (1.3 or newer).'
            : 'The server does not send Timing-Allow-Origin, so the browser hides connection phases. Agent mode measures every phase.'
  return { source: detail ? source : 'basic', timing, size, network, note }
}

/** Total of the phases that make up the network time (Prepare and Process are outside it). */
export const networkTime = (t) => ['socket', 'dns', 'tcp', 'tls', 'ttfb', 'download'].reduce((n, k) => n + (typeof t[k] === 'number' ? t[k] : 0), 0)
