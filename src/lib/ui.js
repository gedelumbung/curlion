export const methodColor = {
  GET: 'text-emerald-400',
  POST: 'text-amber-400',
  PUT: 'text-sky-400',
  PATCH: 'text-violet-400',
  DELETE: 'text-red-400',
  OPTIONS: 'text-pink-400',
  HEAD: 'text-teal-400',
}

/** Short coloured label shown for a request in lists and tabs: its method, or its protocol. */
const PROTOCOL_BADGE = {
  graphql: { label: 'GQL', class: 'text-pink-400' },
  ws: { label: 'WS', class: 'text-teal-400' },
  socketio: { label: 'SIO', class: 'text-sky-400' },
  grpc: { label: 'gRPC', class: 'text-violet-400' },
}
const SHORT_METHOD = { DELETE: 'DEL', OPTIONS: 'OPT' }
export function requestBadge(req, { short = false } = {}) {
  const p = PROTOCOL_BADGE[req?.protocol]
  if (p) return p
  const m = req?.method || 'GET'
  return { label: short ? SHORT_METHOD[m] || m : m, class: methodColor[m] }
}

/** Status colour for HTTP codes, or for gRPC status codes when grpc is true. */
export function statusColor(code, grpc = false) {
  if (grpc) return code === 0 ? 'text-emerald-400' : 'text-red-400'
  if (code >= 500) return 'text-red-400'
  if (code >= 400) return 'text-orange-400'
  if (code >= 300) return 'text-sky-400'
  if (code >= 200) return 'text-emerald-400'
  return 'text-zinc-400'
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export async function copyText(text) {
  await navigator.clipboard.writeText(text)
}

export function downloadJson(obj, fileName) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

export const STANDARD_HEADERS = [
  'Accept',
  'Accept-Encoding',
  'Accept-Language',
  'Authorization',
  'Cache-Control',
  'Connection',
  'Content-Disposition',
  'Content-Encoding',
  'Content-Length',
  'Content-Type',
  'Cookie',
  'If-Match',
  'If-Modified-Since',
  'If-None-Match',
  'Origin',
  'Pragma',
  'Referer',
  'User-Agent',
  'X-API-Key',
  'X-Request-ID',
  'X-Requested-With',
]
