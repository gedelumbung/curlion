// Netlify Edge Function: public mock endpoint.
//   GET|POST|... /mock/<collection_id>/<sample_id>
// Returns the status, headers and body of a saved sample from Supabase.
//
// Env vars (Netlify site settings):
//   SUPABASE_URL, SUPABASE_ANON_KEY            required
//   SUPABASE_SERVICE_ROLE_KEY                  optional; without it only public collections (is_public = true) can be mocked

const env = (k) => globalThis.Netlify?.env.get(k) ?? globalThis.Deno?.env.get(k)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
}

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

function findSample(items, sampleId) {
  for (const n of items || []) {
    if (n.type === 'folder') {
      const hit = findSample(n.items, sampleId)
      if (hit) return hit
    } else if (n.type === 'request') {
      const s = (n.samples || []).find((x) => x.id === sampleId)
      if (s) return s
    }
  }
  return null
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  const [, , collectionId, sampleId] = new URL(request.url).pathname.split('/')
  if (!UUID.test(collectionId || '') || !UUID.test(sampleId || '')) {
    return json(400, { error: 'Mock URL must look like /mock/<collection_id>/<sample_id>' })
  }

  const base = env('SUPABASE_URL')
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY')
  const key = serviceKey || env('SUPABASE_ANON_KEY')
  if (!base || !key) return json(500, { error: 'Mock server is not configured (SUPABASE_URL / key missing)' })

  // With the service role key: live data of any synced collection.
  // With only the anon key: the published docs snapshot (collection must be published).
  const endpoint = serviceKey
    ? `${base}/rest/v1/collections?id=eq.${collectionId}&select=items:tree_data->items`
    : `${base}/rest/v1/published_docs?collection_id=eq.${collectionId}&select=items:data->items`
  const res = await fetch(endpoint, { headers: { apikey: key, Authorization: `Bearer ${key}` } })
  if (!res.ok) return json(502, { error: 'Could not load collection', detail: await res.text() })
  const rows = await res.json()
  if (!rows.length) {
    return json(404, { error: serviceKey ? 'Collection not found' : 'Collection not found or not published (publish its docs to enable mocks)' })
  }

  const sample = findSample(rows[0].items, sampleId)
  if (!sample) return json(404, { error: 'Sample not found' })

  const headers = new Headers(CORS)
  for (const h of sample.headers || []) {
    if (h.enabled === false || !h.key) continue
    try {
      headers.set(h.key, h.value ?? '')
    } catch {}
  }
  headers.set('X-Beacon-Mock', sample.name || 'sample')

  const status = Number(sample.status) || 200
  const noBody = request.method === 'HEAD' || [204, 205, 304].includes(status)
  return new Response(noBody ? null : sample.body ?? '', { status, headers })
}
