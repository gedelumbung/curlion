// Request engine: Direct Browser Mode, Netlify Proxy Mode and Agent Mode (Curlion Agent on this computer).
import { urlencode } from './resolve.js'

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

export function downloadBlob(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
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
 * Send a resolved request.
 * @param resolved output of resolveRequest()
 * @param opts { mode: 'direct'|'proxy'|'agent', agentPort, download: boolean, signal }
 */
export async function sendRequest(resolved, opts = {}) {
  const { mode = 'direct', download = false, signal, agentPort } = opts
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

  const blob = await res.blob()
  const time = Math.round(performance.now() - started)

  const status = relayed ? Number(res.headers.get('x-curlion-status') || res.status) : res.status
  const statusText = relayed ? res.headers.get('x-curlion-status-text') || res.statusText : res.statusText

  let responseHeaders = []
  if (relayed && res.headers.get('x-curlion-headers')) {
    responseHeaders = JSON.parse(decodeURIComponent(res.headers.get('x-curlion-headers')))
  } else {
    res.headers.forEach((value, key) => responseHeaders.push({ key, value }))
  }
  const hdrs = new Headers(responseHeaders.map((h) => [h.key, h.value]))

  const result = {
    status,
    statusText,
    time,
    size: blob.size,
    headers: responseHeaders,
    contentType: hdrs.get('content-type') || '',
    body: '',
    json: undefined,
    binary: false,
    fileName: null,
  }

  if (download || isBinaryResponse(hdrs)) {
    result.binary = true
    result.fileName = filenameFrom(hdrs, resolved.url)
    downloadBlob(blob, result.fileName)
    if (/^image\//.test(result.contentType)) result.previewUrl = URL.createObjectURL(blob)
    return result
  }

  result.body = await blob.text()
  try {
    result.json = JSON.parse(result.body)
  } catch {}
  return result
}
