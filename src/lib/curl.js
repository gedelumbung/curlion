// Parse a `curl` command into a Curlion request.
import { kv, newRequest } from './model.js'
import { parseQuery } from './url.js'

/** Split a shell command into argv, honouring quotes, escapes and line continuations. */
export function tokenize(input) {
  const s = input.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ') // bash + cmd continuations
  const out = []
  let cur = ''
  let inToken = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "'" ) {
      inToken = true
      const end = s.indexOf("'", i + 1)
      cur += s.slice(i + 1, end === -1 ? s.length : end)
      i = end === -1 ? s.length : end
    } else if (c === '$' && s[i + 1] === "'") {
      // ANSI-C quoting $'...'
      inToken = true
      i += 2
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[++i]
          cur += { n: '\n', t: '\t', r: '\r', "'": "'", '\\': '\\', '"': '"' }[n] ?? '\\' + n
        } else cur += s[i]
        i++
      }
    } else if (c === '"') {
      inToken = true
      i++
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && '"\\$`'.includes(s[i + 1])) i++
        cur += s[i]
        i++
      }
    } else if (c === '\\' && i + 1 < s.length) {
      inToken = true
      cur += s[++i]
    } else if (/\s/.test(c)) {
      if (inToken) out.push(cur)
      cur = ''
      inToken = false
    } else {
      inToken = true
      cur += c
    }
  }
  if (inToken) out.push(cur)
  return out
}

export const looksLikeCurl = (text) => /^\s*curl(\.exe)?\s/i.test(text)

const DATA_FLAGS = ['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json']
const FORM_FLAGS = ['-F', '--form', '--form-string']
const IGNORED_WITH_VALUE = ['-o', '--output', '-m', '--max-time', '--connect-timeout', '-w', '--write-out', '-x', '--proxy', '--retry', '-e', '--referer']

export function parseCurl(command) {
  const argv = tokenize(command.trim())
  if (!argv.length || !/^curl(\.exe)?$/i.test(argv[0])) throw new Error('Command must start with "curl"')

  let method = null
  let url = ''
  let forceGet = false
  const headers = []
  const data = []
  const form = []
  let user = null
  let isJsonFlag = false

  for (let i = 1; i < argv.length; i++) {
    let a = argv[i]
    let val = null
    // --flag=value
    const eq = a.startsWith('--') ? a.indexOf('=') : -1
    if (eq > 0) {
      val = a.slice(eq + 1)
      a = a.slice(0, eq)
    }
    const next = () => (val !== null ? val : argv[++i])

    if (a === '-X' || a === '--request') method = next().toUpperCase()
    else if (/^-X[A-Z]+$/.test(a)) method = a.slice(2)
    else if (a === '-H' || a === '--header') headers.push(next())
    else if (DATA_FLAGS.includes(a)) {
      if (a === '--json') isJsonFlag = true
      data.push({ flag: a, value: next() })
    } else if (FORM_FLAGS.includes(a)) form.push(next())
    else if (a === '-u' || a === '--user') user = next()
    else if (a === '--url') url = next()
    else if (a === '-G' || a === '--get') forceGet = true
    else if (a === '-I' || a === '--head') method = 'HEAD'
    else if (a === '-A' || a === '--user-agent') headers.push(`User-Agent: ${next()}`)
    else if (a === '-b' || a === '--cookie') headers.push(`Cookie: ${next()}`)
    else if (IGNORED_WITH_VALUE.includes(a)) next()
    else if (a.startsWith('-')) continue // --compressed, -k, -L, -s, -v ...
    else if (!url) url = a
  }

  if (!url) throw new Error('No URL found in cURL command')
  if (!/^[a-z]+:\/\//i.test(url) && !url.startsWith('{{')) url = 'http://' + url

  const req = newRequest(nameFromUrl(url))

  for (const h of headers) {
    const idx = h.indexOf(':')
    if (idx === -1) continue
    req.headers.push(kv(h.slice(0, idx).trim(), h.slice(idx + 1).trim()))
  }
  if (isJsonFlag) {
    if (!hasHeader(req.headers, 'content-type')) req.headers.push(kv('Content-Type', 'application/json'))
    if (!hasHeader(req.headers, 'accept')) req.headers.push(kv('Accept', 'application/json'))
  }

  if (user !== null) {
    const idx = user.indexOf(':')
    req.auth.type = 'basic'
    req.auth.basic.username = idx === -1 ? user : user.slice(0, idx)
    req.auth.basic.password = idx === -1 ? '' : user.slice(idx + 1)
  }

  // Bearer token header -> auth tab
  const authIdx = req.headers.findIndex((h) => /^authorization$/i.test(h.key) && /^bearer\s+/i.test(h.value))
  if (authIdx !== -1 && req.auth.type === 'none') {
    req.auth.type = 'bearer'
    req.auth.bearer.token = req.headers[authIdx].value.replace(/^bearer\s+/i, '')
    req.headers.splice(authIdx, 1)
  }

  if (forceGet && data.length) {
    const qs = data.map((d) => d.value).join('&')
    url += (url.includes('?') ? '&' : '?') + qs
    data.length = 0
  }

  if (form.length) {
    req.body.mode = 'form-data'
    for (const f of form) {
      const idx = f.indexOf('=')
      const key = idx === -1 ? f : f.slice(0, idx)
      const value = idx === -1 ? '' : f.slice(idx + 1)
      if (value.startsWith('@')) {
        req.body.formData.push(kv(key, '', { type: 'file', fileName: value.slice(1).split(';')[0].replace(/^"|"$/g, '') }))
      } else {
        req.body.formData.push(kv(key, value.replace(/^"|"$/g, ''), { type: 'text' }))
      }
    }
  } else if (data.length) {
    const body = data.map((d) => d.value).join('&')
    const ct = headerValue(req.headers, 'content-type') || ''
    const trimmed = body.trim()
    const looksJson = /^[[{]/.test(trimmed) && isJson(trimmed)
    if (/json/i.test(ct) || isJsonFlag || (!ct && looksJson)) {
      req.body.mode = 'raw'
      req.body.rawType = 'json'
      req.body.raw = looksJson ? JSON.stringify(JSON.parse(trimmed), null, 2) : body
    } else if (/x-www-form-urlencoded/i.test(ct) || (!ct && /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(trimmed))) {
      req.body.mode = 'urlencoded'
      req.body.urlencoded = parseQuery(trimmed)
    } else {
      req.body.mode = 'raw'
      req.body.rawType = /xml/i.test(ct) ? 'xml' : /html/i.test(ct) ? 'html' : 'text'
      req.body.raw = body
    }
    // Content-Type is implied by the body mode; drop the duplicate header for urlencoded/json
    if (req.body.mode === 'urlencoded') removeHeader(req.headers, 'content-type')
  }

  req.method = method || (data.length || form.length ? 'POST' : 'GET')
  req.url = url
  req.params = parseQuery(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '')
  return req
}

function nameFromUrl(url) {
  try {
    const u = new URL(url.replace(/\{\{[^}]+\}\}/g, 'x'))
    return u.pathname === '/' ? u.host : u.pathname
  } catch {
    return 'Imported cURL'
  }
}
const isJson = (s) => {
  try {
    JSON.parse(s)
    return true
  } catch {
    return false
  }
}
const hasHeader = (list, name) => list.some((h) => h.key.toLowerCase() === name)
const headerValue = (list, name) => list.find((h) => h.key.toLowerCase() === name)?.value
const removeHeader = (list, name) => {
  const i = list.findIndex((h) => h.key.toLowerCase() === name)
  if (i !== -1) list.splice(i, 1)
}
