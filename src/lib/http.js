// Request engine: Direct Browser Mode and Netlify Proxy Mode.
import { urlencode } from './resolve.js'

export const PROXY_PATH = '/api/proxy'

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
 * @param opts { mode: 'direct'|'proxy', download: boolean, signal }
 */
export async function sendRequest(resolved, opts = {}) {
  const { mode = 'direct', download = false, signal } = opts
  const headers = new Headers()
  const body = buildBody(resolved.body)

  let fetchUrl = resolved.url
  let init

  if (mode === 'proxy') {
    // Target info travels in headers; the body is streamed through untouched.
    const ct = resolved.headers.find((h) => h.key.toLowerCase() === 'content-type')
    if (ct && !(body instanceof FormData)) headers.set('Content-Type', ct.value)
    headers.set('X-Echo-Url', resolved.url)
    headers.set('X-Echo-Method', resolved.method)
    headers.set('X-Echo-Headers', encodeURIComponent(JSON.stringify(resolved.headers)))
    fetchUrl = PROXY_PATH
    init = { method: 'POST', headers, body: body ?? '', signal }
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
  }

  const started = performance.now()
  let res
  try {
    res = await fetch(fetchUrl, init)
  } catch (err) {
    if (err.name === 'AbortError') throw err
    const hint =
      mode === 'direct'
        ? 'Request failed. The API may be unreachable or blocking CORS. Try Proxy mode for public APIs, or enable CORS on your local server.'
        : 'Proxy request failed. Is the app running on Netlify (or `netlify dev`)?'
    const e = new Error(`${err.message}. ${hint}`)
    e.cause = err
    throw e
  }

  if (mode === 'proxy' && res.headers.get('x-echo-error')) {
    throw new Error('Proxy error: ' + (await res.text()))
  }

  const blob = await res.blob()
  const time = Math.round(performance.now() - started)

  const status = mode === 'proxy' ? Number(res.headers.get('x-echo-status') || res.status) : res.status
  const statusText = mode === 'proxy' ? res.headers.get('x-echo-status-text') || res.statusText : res.statusText

  let responseHeaders = []
  if (mode === 'proxy' && res.headers.get('x-echo-headers')) {
    responseHeaders = JSON.parse(decodeURIComponent(res.headers.get('x-echo-headers')))
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
