// Request engine: Direct Browser Mode, Netlify Proxy Mode and Agent Mode (Curlion Agent on this computer).
import { urlencode } from './resolve.js'
import { uid } from './model.js'
import { estimateRequestSize, estimateResponseHeaderSize, fromResourceTiming } from './metrics.js'

export const PROXY_PATH = '/api/proxy'
export const AGENT_DEFAULT_PORT = 5577
export const agentBase = (port = AGENT_DEFAULT_PORT) => `http://127.0.0.1:${port}`

/** Is the Curlion Agent running? Resolves { ok, version } or { ok: false, reason }. */
export async function pingAgent(port) {
  try {
    const res = await fetch(`${agentBase(port)}/health`, { cache: 'no-store', signal: AbortSignal.timeout(2000), targetAddressSpace: 'loopback' })
    if (!res.ok) return { ok: false, reason: await res.text() }
    const info = await res.json()
    return info?.name === 'curlion-agent' ? { ok: true, version: info.version } : { ok: false, reason: 'Not a Curlion Agent' }
  } catch {
    return { ok: false, reason: 'not running' }
  }
}

const BINARY_TYPES = /^(image|audio|video|font)\/|application\/(pdf|zip|octet-stream|x-zip|x-7z|x-rar|x-tar|gzip|x-gzip|msword|vnd\.|x-msdownload)/i

export function isBinaryResponse(headers) {
  const ct = headers.get('content-type') || ''
  const cd = headers.get('content-disposition') || ''
  if (/attachment/i.test(cd)) return true
  if (/svg\+xml|json|xml|javascript|text\//i.test(ct)) return false
  return BINARY_TYPES.test(ct)
}

function filenameFrom(headers, url) {
  const cd = headers.get('content-disposition') || ''
  const star = cd.match(/filename\*\s*=\s*[^']*''([^;]+)/i)
  if (star) return decodeURIComponent(star[1].trim().replace(/"/g, ''))
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i)
  if (plain) return plain[1].trim()
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop()
    if (last) return decodeURIComponent(last)
  } catch {}
  return 'response.bin'
}

/**
 * Save a response as a file. In Chrome / Edge this opens the native "Save as" dialog
 * (File System Access API): unlike an <a download> click after an await, it is not
 * subject to Chrome's "automatic downloads" blocking. It needs a recent user gesture,
 * which a click on Send (and a quick response) or on "Download again" provides.
 * @returns {Promise<'saved'|'downloaded'|'cancelled'>}
 */
export async function saveResponseFile(blobOrUrl, name, contentType = '') {
  const activeGesture = navigator.userActivation ? navigator.userActivation.isActive : false
  if (typeof window.showSaveFilePicker === 'function' && activeGesture) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name })
      const blob = typeof blobOrUrl === 'string' ? await (await fetch(blobOrUrl)).blob() : blobOrUrl
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      return 'saved'
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled'
      // SecurityError / NotAllowedError: fall back to a regular download
    }
  }
  downloadBlob(blobOrUrl, name)
  return 'downloaded'
}

/** Save a blob (or an existing blob: URL) as a file. */
export function downloadBlob(blob, name) {
  const href = typeof blob === 'string' ? blob : URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  if (typeof blob !== 'string') setTimeout(() => URL.revokeObjectURL(href), 10_000)
}

const EXT_BY_TYPE = [
  [/json/, 'json'], [/xml/, 'xml'], [/html/, 'html'], [/csv/, 'csv'], [/javascript/, 'js'], [/css/, 'css'],
  [/text\/plain/, 'txt'], [/pdf/, 'pdf'], [/zip/, 'zip'], [/png/, 'png'], [/jpe?g/, 'jpg'], [/gif/, 'gif'],
  [/webp/, 'webp'], [/svg/, 'svg'], [/gzip/, 'gz'],
]
/** "1" + application/json -> "1.json" (Safari and Firefox keep a bare name as-is). */
function withExtension(name, contentType) {
  if (/\.[a-z0-9]{1,8}$/i.test(name)) return name
  const ext = EXT_BY_TYPE.find(([re]) => re.test(contentType || ''))?.[1]
  return ext ? `${name}.${ext}` : name
}

// ---- Local network access (Direct mode) ----------------------------------------
// Chrome asks the user before a public site may reach localhost / the local network
// ("Local network access"). Telling fetch which address space the target is in lets
// Chrome show that prompt instead of blocking an http:// target as mixed content.

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/

/** 'loopback' | 'local' | 'public' for a URL's host. */
export function addressSpace(url) {
  let host
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return 'public'
  }
  if (host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '::1' || host === '0.0.0.0') return 'loopback'
  if (PRIVATE_V4.test(host) || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return 'local'
  if (!host.includes('.') && !host.includes(':')) return 'local' // single-label intranet name
  return 'public'
}

/** State of the browser's local-network permission for this site, if the browser exposes it. */
async function localNetworkPermission(space) {
  if (!navigator.permissions?.query) return null
  // the permission has had a few names across Chrome versions
  const names = space === 'loopback' ? ['loopback-network', 'local-network-access', 'local-network'] : ['local-network', 'local-network-access']
  for (const name of names) {
    try {
      return (await navigator.permissions.query({ name })).state // granted | denied | prompt
    } catch {
      // unknown permission name in this browser
    }
  }
  return null
}

/** Explain why a Direct-mode fetch failed (permission, mixed content, unreachable or CORS). */
async function diagnoseDirectFailure(url) {
  const space = addressSpace(url)
  const target = new URL(url)
  const pageIsPublic = addressSpace(location.href) === 'public'

  const perm = space !== 'public' && pageIsPublic ? await localNetworkPermission(space) : null
  if (perm === 'denied') {
    return `The browser blocked this site from reaching ${target.host} ("Local network access" is set to Block). Allow it in the site settings (icon left of the address bar → Site settings → Local network access → Allow), then send again. Agent mode also works.`
  }
  if (location.protocol === 'https:' && target.protocol === 'http:' && space === 'public') {
    return `Browsers block http:// requests from an https:// page (mixed content). Use https, Proxy mode or Agent mode.`
  }

  // Is anything answering at that address? An opaque no-cors request succeeds even without CORS.
  let reachable = false
  try {
    const probe = { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(4000) }
    if (space !== 'public') probe.targetAddressSpace = space
    await fetch(`${target.origin}/`, probe)
    reachable = true
  } catch {}

  if (reachable) {
    return `${target.host} answered, but its response did not allow this site (CORS). Enable CORS on the API for ${location.origin}, or use Agent mode${space === 'public' ? ' / Proxy mode' : ''}, which are not limited by CORS.`
  }
  if (perm === 'prompt') {
    return `Could not reach ${target.host}. If the browser asked about local network access, choose "Allow" and send again; otherwise check that the API is running on that address and port. Agent mode also works.`
  }
  if (space !== 'public') {
    return `Could not reach ${target.host}. Check that the API is running on that address and port. If it is, the browser may have blocked local network access for this site (site settings → Local network access → Allow). Agent mode also works.`
  }
  return `Could not reach ${target.host}. The server may be down, or the address is wrong. Proxy mode can help when the API blocks browsers.`
}

function buildBody(body) {
  if (!body) return undefined
  if (body.mode === 'raw') return body.raw
  if (body.mode === 'urlencoded') return urlencode(body.fields)
  if (body.mode === 'form-data') {
    const fd = new FormData()
    for (const f of body.fields) {
      if (f.type === 'file') {
        if (f.file) fd.append(f.key, f.file, f.fileName)
      } else fd.append(f.key, f.value)
    }
    return fd
  }
}

/**
 * fetch() a resolved request in the given mode. Relayed modes (Proxy, Agent) carry the target
 * in X-Curlion-* headers and stream the body back untouched.
 * @returns {{ res: Response, relayed: boolean, started: number }}
 */
async function fetchResolved(resolved, opts = {}) {
  const { mode = 'direct', signal, agentPort } = opts
  const relayed = mode === 'proxy' || mode === 'agent' // target info travels in X-Curlion-* headers
  const headers = new Headers()
  const body = buildBody(resolved.body)

  let fetchUrl = resolved.url
  let init

  if (relayed) {
    // Target info travels in headers; the body is streamed through untouched.
    const ct = resolved.headers.find((h) => h.key.toLowerCase() === 'content-type')
    if (ct && !(body instanceof FormData)) headers.set('Content-Type', ct.value)
    headers.set('X-Curlion-Url', resolved.url)
    headers.set('X-Curlion-Method', resolved.method)
    headers.set('X-Curlion-Headers', encodeURIComponent(JSON.stringify(resolved.headers)))
    if (opts.timingId) headers.set('X-Curlion-Id', opts.timingId) // the agent keeps this request's timing for GET /timing
    fetchUrl = mode === 'agent' ? `${agentBase(agentPort)}/proxy` : PROXY_PATH
    init = { method: 'POST', headers, body: body ?? '', signal }
    if (mode === 'agent') init.targetAddressSpace = 'loopback' // the agent runs on this computer
  } else {
    for (const h of resolved.headers) {
      try {
        headers.append(h.key, h.value)
      } catch {
        throw new Error(`Invalid header "${h.key}"`)
      }
    }
    if (body instanceof FormData) headers.delete('content-type') // let the browser add the boundary
    init = { method: resolved.method, headers, body, signal }
    // localhost / local network from a public site: let Chrome ask for "Local network access"
    const space = addressSpace(resolved.url)
    if (space !== 'public') init.targetAddressSpace = space
  }

  const started = performance.now()
  let res
  try {
    res = await fetch(fetchUrl, init)
  } catch (err) {
    if (err.name === 'AbortError') throw err
    if (mode === 'direct') {
      const e = new Error(await diagnoseDirectFailure(resolved.url).catch(() => 'Request failed. The API may be unreachable or blocking CORS. Try Agent mode.'))
      e.cause = err
      throw e
    }
    const hint = {
      proxy: 'Proxy request failed. Is the app running on Netlify (or `netlify dev`)?',
      agent: `Could not reach the Curlion Agent on 127.0.0.1:${agentPort || AGENT_DEFAULT_PORT}. Is it running (see Agent setup), and did you allow "local network access" for this site in the browser?`,
    }[mode]
    const e = new Error(`${err.message}. ${hint}`)
    e.cause = err
    throw e
  }

  if (relayed && res.headers.get('x-curlion-error')) {
    throw new Error(`${mode === 'agent' ? 'Agent' : 'Proxy'} error: ${await res.text()}`)
  }
  return { res, relayed, started }
}

// ---- timing / size / network details (see metrics.js) ---------------------------------

if (typeof performance !== 'undefined' && performance.setResourceTimingBufferSize) performance.setResourceTimingBufferSize(500)

/** The browser's Resource Timing entry for this fetch (Direct mode). */
async function resourceEntry(urls, since) {
  if (typeof performance === 'undefined' || !performance.getEntriesByType) return null
  await new Promise((r) => setTimeout(r, 0)) // the entry is added once the body has been read
  const list = performance.getEntriesByType('resource')
  const hit = list.filter((e) => urls.includes(e.name) && e.startTime >= since - 1).at(-1) || null
  if (list.length > 400) performance.clearResourceTimings()
  return hit
}

/** Details for metrics.buildMetrics(): { source, detail } */
async function collectDetail({ mode, agentPort, timingId, urls, started }) {
  try {
    if (mode === 'agent' && timingId) {
      const r = await fetch(`${agentBase(agentPort)}/timing?id=${encodeURIComponent(timingId)}`, { cache: 'no-store', targetAddressSpace: 'loopback' })
      return r.ok ? { source: 'agent', detail: await r.json() } : { source: 'agent', detail: null } // older agents: 404
    }
    if (mode === 'direct') {
      const d = fromResourceTiming(await resourceEntry(urls, started))
      return { source: 'browser', detail: d && (d.detailed || d.httpVersion || d.size) ? d : null }
    }
  } catch {}
  return { source: mode === 'agent' ? 'agent' : 'basic', detail: null }
}

/** Status, status text and headers of the target's response (relayed modes carry them in X-Curlion-*). */
function responseMeta(res, relayed) {
  const status = relayed ? Number(res.headers.get('x-curlion-status') || res.status) : res.status
  const statusText = relayed ? res.headers.get('x-curlion-status-text') || res.statusText : res.statusText
  let headers = []
  if (relayed && res.headers.get('x-curlion-headers')) headers = JSON.parse(decodeURIComponent(res.headers.get('x-curlion-headers')))
  else res.headers.forEach((value, key) => headers.push({ key, value }))
  return { status, statusText, headers }
}

/**
 * Open a response as a stream (Server-Sent Events): resolves once the headers arrive.
 * @returns {{ status, statusText, headers: {key,value}[], body: ReadableStream, text(): Promise<string> }}
 */
export async function openStream(resolved, opts = {}) {
  const { res, relayed } = await fetchResolved(resolved, opts)
  return { ...responseMeta(res, relayed), body: res.body, text: () => res.text() }
}

const NDJSON_TYPE = /(x-)?ndjson|jsonl|json-seq|jsonlines/i

/**
 * Newline-delimited JSON (NDJSON / JSON Lines / JSON text sequences): the parsed lines, or
 * undefined when the body is not that. Bodies without such a Content-Type count when they
 * have at least two lines and every line is JSON (common for streamed APIs).
 */
export function parseJsonLines(text, contentType = '') {
  const declared = NDJSON_TYPE.test(contentType)
  if (!declared && !/\n/.test(text.trim())) return undefined
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^\x1e/, '').trim()).filter(Boolean) // \x1e: RFC 7464 record separator
  if (!lines.length || (!declared && lines.length < 2)) return undefined
  const out = []
  for (const l of lines) {
    try {
      out.push(JSON.parse(l))
    } catch {
      return undefined
    }
  }
  return out
}

/**
 * Read a text body as it arrives. onProgress({ text, bytes }) is called at most every
 * PROGRESS_MS while data comes in. Stopping (signal) keeps what arrived: aborted is true.
 */
const PROGRESS_MS = 80
async function readText(res, { onProgress, signal } = {}) {
  if (!res.body) return { text: await res.text(), bytes: 0, aborted: false }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  let last = 0
  let aborted = false
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      text += decoder.decode(value, { stream: true })
      const now = performance.now()
      if (onProgress && now - last >= PROGRESS_MS) {
        last = now
        onProgress({ text, bytes })
      }
    }
    text += decoder.decode()
  } catch (err) {
    if (err.name !== 'AbortError' && !signal?.aborted) throw err
    aborted = true
    text += decoder.decode()
  }
  return { text, bytes, aborted }
}

/**
 * Send a resolved request.
 * @param resolved output of resolveRequest()
 * @param opts { mode: 'direct'|'proxy'|'agent', agentPort, download: boolean, signal,
 *   saveBinary: false to skip saving binary responses as files (Collection Runner),
 *   onProgress: ({ status, statusText, headers, contentType, text, bytes }) => void, called
 *   while a text body streams in; with it, stopping (signal) after the headers arrived
 *   returns what was received so far, marked `aborted` }
 */
export async function sendRequest(resolved, opts = {}) {
  const { download = false, saveBinary = true, onProgress, signal, mode = 'direct', agentPort } = opts
  const timingId = mode === 'agent' ? uid() : null
  const { res, relayed, started } = await fetchResolved(resolved, { ...opts, timingId })
  const headersAt = performance.now()
  const ttfb = Math.round(headersAt - started) // headers received
  // inputs for metrics.buildMetrics(); the store adds prepare / process times
  const metricsInput = async (bodyBytes) => {
    const end = performance.now()
    return {
      base: {
        mode,
        ttfb: +(headersAt - started).toFixed(2),
        download: +(end - headersAt).toFixed(2),
        requestSize: estimateRequestSize(resolved),
        responseHeaders: estimateResponseHeaderSize(result.status, result.statusText, result.headers),
        responseBody: bodyBytes,
      },
      ...(await collectDetail({ mode, agentPort, timingId, urls: [res.url, resolved.url], started })),
    }
  }

  const { status, statusText, headers: responseHeaders } = responseMeta(res, relayed)
  const hdrs = new Headers(responseHeaders.map((h) => [h.key, h.value]))

  const result = {
    status,
    statusText,
    time: 0,
    ttfb,
    size: 0,
    headers: responseHeaders,
    contentType: hdrs.get('content-type') || '',
    body: '',
    json: undefined,
    lines: undefined, // parsed NDJSON / JSON Lines
    binary: false,
    fileName: null,
  }

  if (download || isBinaryResponse(hdrs)) {
    const blob = await res.blob()
    result.time = Math.round(performance.now() - started)
    result.size = blob.size
    result.metricsInput = await metricsInput(blob.size)
    result.binary = true
    result.fileName = withExtension(filenameFrom(hdrs, resolved.url), result.contentType)
    if (!saveBinary) return result
    // kept so the response pane can offer "Download again" (a click there is a real user
    // gesture, which browsers never block, unlike this download after an await)
    result.downloadUrl = URL.createObjectURL(blob)
    result.saved = download ? await saveResponseFile(result.downloadUrl, result.fileName) : (downloadBlob(result.downloadUrl, result.fileName), 'downloaded')
    if (/^image\//.test(result.contentType)) result.previewUrl = result.downloadUrl
    return result
  }

  const meta = { status, statusText, headers: responseHeaders, contentType: result.contentType }
  onProgress?.({ ...meta, text: '', bytes: 0 })
  const read = await readText(res, { signal, onProgress: onProgress && ((p) => onProgress({ ...meta, ...p })) })
  if (read.aborted && !onProgress) throw new DOMException('Aborted', 'AbortError')
  result.time = Math.round(performance.now() - started)
  result.body = read.text
  result.size = read.bytes
  result.metricsInput = await metricsInput(read.bytes)
  if (read.aborted) result.aborted = true
  try {
    result.json = JSON.parse(result.body)
  } catch {
    result.lines = parseJsonLines(result.body, result.contentType)
  }
  return result
}
