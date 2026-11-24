// Server-Sent Events: a parser for the text/event-stream format (WHATWG HTML spec,
// "event stream interpretation") and a client built on fetch streaming, so it can send
// custom headers, auth and a body (EventSource can do none of these) and run in
// Direct, Proxy or Agent mode.
import { openStream } from './http.js'

/**
 * Incremental parser. Feed it decoded text chunks; it calls onEvent({ event, data, id })
 * for every dispatched event and onRetry(ms) for `retry:` fields. Comments (`: ...`) are
 * reported through onComment (servers send them as heartbeats).
 */
export function createSseParser({ onEvent, onRetry = () => {}, onComment = () => {} }) {
  let buffer = ''
  let data = []
  let event = ''
  let lastId = ''
  let first = true

  function dispatch() {
    if (data.length) onEvent({ event: event || 'message', data: data.join('\n'), id: lastId })
    data = []
    event = ''
  }

  function line(l) {
    if (l === '') return dispatch()
    if (l.startsWith(':')) return onComment(l.slice(1).replace(/^ /, ''))
    const i = l.indexOf(':')
    const field = i === -1 ? l : l.slice(0, i)
    const value = i === -1 ? '' : l.slice(i + 1).replace(/^ /, '')
    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
    else if (field === 'id') {
      if (!value.includes('\0')) lastId = value
    } else if (field === 'retry') {
      if (/^\d+$/.test(value)) onRetry(Number(value))
    }
  }

  return {
    push(chunk) {
      buffer += chunk
      if (first && buffer.length) {
        if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1) // BOM
        first = false
      }
      let start = 0
      for (let i = 0; i < buffer.length; i++) {
        const c = buffer[i]
        if (c !== '\n' && c !== '\r') continue
        if (c === '\r' && i === buffer.length - 1) break // may be the first half of \r\n: wait for more
        line(buffer.slice(start, i))
        if (c === '\r' && buffer[i + 1] === '\n') i++
        start = i + 1
      }
      buffer = buffer.slice(start)
    },
    /** End of stream: an unterminated last event is dropped, as the spec says. */
    end() {
      if (buffer.endsWith('\r')) line(buffer.slice(0, -1))
      buffer = ''
      data = []
      event = ''
    },
    get lastEventId() {
      return lastId
    },
  }
}

/**
 * Connect to an event stream.
 * @param resolved output of resolveRequest()
 * @param opts { mode, agentPort, reconnect: boolean, lastEventId }
 * @param cb onOpen({ protocol }), onMessage({ event, data, id }), onInfo(text), onError(text), onClose({ code, reason })
 * @returns {{ close(), send() }}
 */
export function connectSse(resolved, opts, cb) {
  const controller = new AbortController()
  let lastEventId = opts.lastEventId || ''
  let retry = 3000
  let opened = false
  let stopped = false

  const finish = (reason) => {
    if (stopped) return
    stopped = true
    cb.onClose({ code: 0, reason })
  }

  const wait = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms)
      controller.signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
    })

  async function once() {
    const headers = resolved.headers.filter((h) => h.key.toLowerCase() !== 'last-event-id')
    if (lastEventId) headers.push({ key: 'Last-Event-ID', value: lastEventId })
    const res = await openStream({ ...resolved, headers }, { mode: opts.mode, agentPort: opts.agentPort, signal: controller.signal })
    const ct = res.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value || ''
    if (res.status < 200 || res.status >= 300 || !/text\/event-stream/i.test(ct)) {
      const text = await res.text().catch(() => '')
      const why = res.status >= 300 ? `${res.status} ${res.statusText}`.trim() : `Content-Type is "${ct || 'missing'}", not text/event-stream`
      throw Object.assign(new Error(`Not an event stream: ${why}${text ? `\n${text.slice(0, 500)}` : ''}`), { fatal: true })
    }
    if (!opened) {
      opened = true
      cb.onOpen({ protocol: `${res.status} ${res.statusText || ''}`.trim() })
    } else cb.onInfo(`Reconnected${lastEventId ? ` (Last-Event-ID: ${lastEventId})` : ''}`)

    const parser = createSseParser({
      onEvent: (e) => {
        lastEventId = e.id
        cb.onMessage(e)
      },
      onRetry: (ms) => (retry = ms),
    })
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      parser.push(value)
    }
    parser.end()
  }

  ;(async () => {
    for (;;) {
      try {
        await once()
        if (controller.signal.aborted) return finish('closed')
        if (!opts.reconnect) return finish('stream ended by the server')
        cb.onInfo(`Stream ended by the server. Reconnecting in ${(retry / 1000).toFixed(1)} s…`)
      } catch (e) {
        if (controller.signal.aborted || e.name === 'AbortError') return finish('closed')
        cb.onError(e.message)
        if (e.fatal || !opts.reconnect || !opened) return finish(e.fatal ? 'not an event stream' : 'connection failed')
        cb.onInfo(`Connection lost. Reconnecting in ${(retry / 1000).toFixed(1)} s…`)
      }
      await wait(retry)
      if (controller.signal.aborted) return finish('closed')
    }
  })()

  return {
    send() {},
    close() {
      controller.abort()
      finish('closed')
    },
  }
}
