// gRPC (through the Curlion Agent): the browser parses the .proto, encodes the request
// message and decodes the replies; the agent carries the raw frames over HTTP/2.
// protobufjs is loaded on first use.

let pb = null
async function protobuf() {
  if (!pb) pb = (await import('protobufjs')).default
  return pb
}

export const GRPC_STATUS = [
  'OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS',
  'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE',
  'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED',
]

const cache = new Map() // proto text -> parsed result

/**
 * Parse .proto source. Imports of Google's well-known types (google/protobuf/*.proto) are
 * resolved from protobufjs; other imports must be pasted into the same text.
 * @returns {{ root, services: { name, fullName, methods: { name, path, requestType, responseType, requestStream, responseStream }[] }[] }}
 */
export async function parseProto(text) {
  if (cache.has(text)) return cache.get(text)
  const protobufjs = await protobuf()
  const root = new protobufjs.Root()
  const parsed = protobufjs.parse(text, root, { keepCase: true })
  for (const imp of parsed.imports || []) {
    const common = protobufjs.common.get?.(imp) || protobufjs.common[imp.replace(/^google\/protobuf\//, '')]
    if (common?.nested) root.addJSON(common.nested)
    else if (!imp.startsWith('google/protobuf/')) {
      // unknown import: fine as long as the types it provides are not used
    }
  }
  root.resolveAll()
  const services = []
  const walk = (ns) => {
    for (const obj of ns.nestedArray || []) {
      if (obj instanceof protobufjs.Service) {
        const fullName = obj.fullName.replace(/^\./, '')
        services.push({
          name: obj.name,
          fullName,
          methods: obj.methodsArray.map((m) => ({
            name: m.name,
            path: `/${fullName}/${m.name}`,
            requestType: m.resolvedRequestType.fullName.replace(/^\./, ''),
            responseType: m.resolvedResponseType.fullName.replace(/^\./, ''),
            requestStream: !!m.requestStream,
            responseStream: !!m.responseStream,
          })),
        })
      } else if (obj.nestedArray) walk(obj)
    }
  }
  walk(root)
  const result = { root, services }
  cache.set(text, result)
  return result
}

/** Find a method by "pkg.Service/Method" in a parsed proto. */
export function findMethod(parsed, service, method) {
  const s = parsed.services.find((x) => x.fullName === service)
  return s?.methods.find((m) => m.name === method) || null
}

/** Example JSON for a message type, with default values (used for "Example message"). */
export function exampleMessage(root, typeName, depth = 0) {
  const T = root.lookupType(typeName)
  const out = {}
  for (const f of T.fieldsArray) {
    f.resolve()
    let v
    if (f.resolvedType && f.resolvedType.values) v = Object.keys(f.resolvedType.values)[0] // enum
    else if (f.resolvedType) v = depth < 3 ? exampleMessage(root, f.resolvedType.fullName, depth + 1) : {}
    else if (f.type === 'string') v = ''
    else if (f.type === 'bool') v = false
    else if (f.type === 'bytes') v = ''
    else if (/int64|fixed64/.test(f.type)) v = '0'
    else v = 0
    out[f.name] = f.repeated ? [v] : f.map ? {} : v
  }
  return out
}

const toB64 = (bytes) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

const NUMERIC = /^(double|float|u?int32|u?int64|s?fixed32|s?fixed64|sint32|sint64)$/

/** Type-check plain JSON against a message type (protobufjs silently coerces bad values). */
function checkJson(T, obj, path) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${path || T.name}: expected an object`)
  for (const [key, value] of Object.entries(obj)) {
    const f = T.fields[key] || T.fieldsArray.find((x) => x.jsonName === key)
    if (!f) throw new Error(`${path ? path + '.' : ''}${key}: no such field in ${T.name}`)
    f.resolve()
    const where = `${path ? path + '.' : ''}${key}`
    const values = f.repeated ? (Array.isArray(value) ? value : (() => { throw new Error(`${where}: expected an array`) })()) : f.map ? Object.values(value || {}) : [value]
    for (const v of values) {
      if (v === null || v === undefined) continue
      if (f.resolvedType?.fields) checkJson(f.resolvedType, v, where)
      else if (f.resolvedType?.values) {
        if (!(v in f.resolvedType.values) && !Object.values(f.resolvedType.values).includes(v)) throw new Error(`${where}: unknown enum value ${JSON.stringify(v)}`)
      } else if (NUMERIC.test(f.type) && !(typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))))) {
        throw new Error(`${where}: expected a number, got ${JSON.stringify(v)}`)
      } else if (f.type === 'bool' && typeof v !== 'boolean') throw new Error(`${where}: expected true or false`)
      else if (f.type === 'string' && typeof v !== 'string') throw new Error(`${where}: expected a string`)
    }
  }
}

/** JSON → protobuf bytes (base64). Throws with a readable message on invalid input. */
export function encodeMessage(root, typeName, json) {
  const T = root.lookupType(typeName)
  try {
    checkJson(T, json, '')
  } catch (e) {
    throw new Error(`Invalid ${typeName}: ${e.message}`)
  }
  return toB64(T.encode(T.fromObject(json)).finish())
}

/** protobuf bytes (base64) → plain JSON. */
export function decodeMessage(root, typeName, b64) {
  const T = root.lookupType(typeName)
  return T.toObject(T.decode(fromB64(b64)), { longs: String, enums: String, bytes: String, defaults: true, arrays: true, objects: true })
}
