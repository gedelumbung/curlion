// WebSocket and Socket.IO connections. A connection reports through callbacks:
//   onOpen(), onMessage({ dir, event?, data, binary? }), onInfo(text), onClose({ code, reason }), onError(text)
// and returns { send(text | { event, args, ack }), close() }.
import { agentBase } from './http.js'

/** WebSocket straight from the browser (cannot set custom headers). */
export function connectWsDirect({ url, protocols }, cb) {
  let ws
  try {
    ws = protocols.length ? new WebSocket(url, protocols) : new WebSocket(url)
  } catch (e) {
    cb.onError(e.message)
    cb.onClose({ code: 0, reason: '' })
    return { send() {}, close() {} }
  }
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => cb.onOpen({ protocol: ws.protocol })
  ws.onmessage = (e) =>
    typeof e.data === 'string' ? cb.onMessage({ data: e.data }) : cb.onMessage({ data: `<${e.data.byteLength} bytes binary>`, binary: true })
  ws.onerror = () => cb.onError('Connection failed (the browser does not report details; check the URL, CORS-free server and certificates).')
  ws.onclose = (e) => cb.onClose({ code: e.code, reason: e.reason })
  return {
    send: (text) => ws.send(text),
    close: () => ws.close(1000, 'Closed by user'),
  }
}

/**
 * WebSocket through the Curlion Agent: the agent opens the real socket (custom headers,
 * localhost, self-signed TLS) and relays frames over Server-Sent Events + POST.
 */
export function connectWsAgent({ url, protocols, headers }, agentPort, cb) {
  const base = agentBase(agentPort)
  const q = new URLSearchParams({ target: url, headers: JSON.stringify(headers), protocols: protocols.join(',') })
  const es = new EventSource(`${base}/ws/connect?${q}`)
  let id = null
  let closed = false
  const finish = (info) => {
    if (closed) return
    closed = true
    es.close()
    cb.onClose(info)
  }
  es.addEventListener('open-ws', (e) => {
    const d = JSON.parse(e.data)
    id = d.id
    cb.onOpen({ protocol: d.protocol })
  })
  es.addEventListener('message', (e) => {
    const d = JSON.parse(e.data)
    cb.onMessage(d.binary ? { data: `<${d.size} bytes binary>`, binary: true } : { data: d.data })
  })
  es.addEventListener('ws-error', (e) => cb.onError(JSON.parse(e.data).message))
  es.addEventListener('close-ws', (e) => finish(JSON.parse(e.data)))
  es.onerror = () => {
    if (!id) cb.onError(`Could not reach the Curlion Agent on 127.0.0.1:${agentPort}. Is it running?`)
    finish({ code: 1006, reason: 'agent connection lost' })
  }
  const post = (path, body) =>
    fetch(`${base}${path}?id=${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, targetAddressSpace: 'loopback' })
  return {
    send: (text) => post('/ws/send', { data: text }).catch((e) => cb.onError(e.message)),
    close: () => (id ? post('/ws/close', {}).catch(() => finish({ code: 1000, reason: '' })) : finish({ code: 1000, reason: '' })),
  }
}

let ioLib = null
/** Socket.IO client (loaded on first use). Every incoming event is logged via onAny. */
export async function connectSocketIo({ url, headers, path, auth, transports }, cb) {
  if (!ioLib) ioLib = (await import('socket.io-client')).io
  const socket = ioLib(url, {
    path: path || '/socket.io',
    auth: auth || undefined,
    transports,
    extraHeaders: Object.fromEntries(headers.map((h) => [h.key, h.value])), // used by the polling transport
    reconnection: false,
    forceNew: true,
    timeout: 15000,
  })
  socket.on('connect', () => cb.onOpen({ protocol: `id ${socket.id}` }))
  socket.on('connect_error', (err) => {
    cb.onError(err.message)
    cb.onClose({ code: 0, reason: err.message })
    socket.close()
  })
  socket.on('disconnect', (reason) => cb.onClose({ code: 0, reason }))
  socket.onAny((event, ...args) => cb.onMessage({ event, data: args.length === 1 ? args[0] : args }))
  return {
    send({ event, args, ack }) {
      if (ack) socket.timeout(15000).emit(event, ...args, (err, ...res) => cb.onMessage({ event: `${event} (ack)`, data: err ? { error: err.message } : res.length === 1 ? res[0] : res }))
      else socket.emit(event, ...args)
    },
    close: () => socket.close(),
  }
}
