// Two-way sync helpers between the URL bar and the Params table.
// We do not use the URL class because URLs may contain {{variables}}.
import { kv } from './model.js'

const dec = (s) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    return s
  }
}

/** Encode a query component but keep {{vars}} readable. */
const enc = (s) =>
  String(s)
    .split(/(\{\{[^}]*\}\})/)
    .map((part) => (part.startsWith('{{') ? part : encodeURIComponent(part).replace(/%2C/g, ',').replace(/%3A/g, ':').replace(/%2F/g, '/')))
    .join('')

export function parseQuery(qs) {
  if (!qs) return []
  return qs
    .replace(/#.*$/, '')
    .split('&')
    .filter((p) => p !== '')
    .map((pair) => {
      const i = pair.indexOf('=')
      return i === -1 ? kv(dec(pair), '') : kv(dec(pair.slice(0, i)), dec(pair.slice(i + 1)))
    })
}

export function splitUrl(url) {
  const hashIdx = url.indexOf('#')
  const hash = hashIdx === -1 ? '' : url.slice(hashIdx)
  const noHash = hashIdx === -1 ? url : url.slice(0, hashIdx)
  const q = noHash.indexOf('?')
  return q === -1 ? { base: noHash, query: '', hash } : { base: noHash.slice(0, q), query: noHash.slice(q + 1), hash }
}

/**
 * URL bar changed -> recompute params.
 * Keeps disabled params and the descriptions of params that still exist.
 */
export function paramsFromUrl(url, oldParams) {
  const parsed = parseQuery(splitUrl(url).query)
  const pool = oldParams.filter((p) => p.enabled !== false)
  const result = parsed.map((p) => {
    const idx = pool.findIndex((o) => o.key === p.key)
    if (idx === -1) return p
    const [old] = pool.splice(idx, 1)
    return { ...old, value: p.value }
  })
  // keep disabled ones in their relative place at the end
  return [...result, ...oldParams.filter((p) => p.enabled === false)]
}

/** Params changed -> rebuild the query string of the URL. */
export function urlFromParams(url, params) {
  const { base, hash } = splitUrl(url)
  const qs = params
    .filter((p) => p.enabled !== false && p.key !== '')
    .map((p) => (p.value === '' ? enc(p.key) : `${enc(p.key)}=${enc(p.value)}`))
    .join('&')
  return base + (qs ? '?' + qs : '') + hash
}

export function appendQuery(url, key, value) {
  const { base, query, hash } = splitUrl(url)
  const pair = `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
  return base + '?' + (query ? query + '&' : '') + pair + hash
}
