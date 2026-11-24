// OAuth 2.0 helpers: authorization code (+ PKCE), client credentials and refresh tokens.
// Pure functions; the store sends the token requests (Direct / Proxy / Agent) and keeps the
// tokens in this browser only (they are never synced or published).

export const OAUTH_GRANTS = [
  { value: 'authorization_code', label: 'Authorization Code' },
  { value: 'client_credentials', label: 'Client Credentials' },
]

/** Where the provider sends the browser back after sign-in (public/oauth-callback.html). */
export const defaultRedirectUri = (origin = globalThis.location?.origin || '') => `${origin}/oauth-callback.html`

/** BroadcastChannel the callback page reports the redirect URL on. */
export const OAUTH_CHANNEL = 'curlion-oauth'

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function randomString(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

/**
 * PKCE verifier and challenge. S256 needs crypto.subtle, which browsers only offer in secure
 * contexts (https, localhost); elsewhere the "plain" method is used.
 */
export async function pkcePair() {
  const verifier = randomString(48)
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    return { verifier, challenge: b64url(new Uint8Array(digest)), method: 'S256' }
  }
  return { verifier, challenge: verifier, method: 'plain' }
}

/** Authorization endpoint URL for the authorization code grant. cfg values are already interpolated. */
export function authorizeUrl(cfg, { state, redirectUri, pkce }) {
  const u = new URL(cfg.authUrl)
  const p = u.searchParams
  p.set('response_type', 'code')
  p.set('client_id', cfg.clientId)
  p.set('redirect_uri', redirectUri)
  if (cfg.scope) p.set('scope', cfg.scope)
  if (cfg.audience) p.set('audience', cfg.audience)
  p.set('state', state)
  if (pkce) {
    p.set('code_challenge', pkce.challenge)
    p.set('code_challenge_method', pkce.method)
  }
  return u.toString()
}

/** { code, state, error } from the URL the provider redirected to (query or fragment). */
export function parseRedirect(url) {
  const u = new URL(url)
  const p = new URLSearchParams(u.search)
  if (!p.has('code') && !p.has('error') && u.hash) for (const [k, v] of new URLSearchParams(u.hash.slice(1))) p.set(k, v)
  const error = p.get('error')
  return {
    code: p.get('code'),
    state: p.get('state'),
    error: error ? `${error}${p.get('error_description') ? `: ${p.get('error_description')}` : ''}` : null,
  }
}

/**
 * A resolved request (see resolveRequest) for the token endpoint.
 * @param params grant-specific fields, e.g. { grant_type: 'authorization_code', code, redirect_uri }
 */
export function tokenRequest(cfg, params) {
  const fields = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  const headers = [
    { key: 'Content-Type', value: 'application/x-www-form-urlencoded' },
    { key: 'Accept', value: 'application/json' },
  ]
  if (cfg.clientAuth !== 'body' && cfg.clientSecret) {
    const raw = `${cfg.clientId}:${cfg.clientSecret}`
    headers.push({ key: 'Authorization', value: `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(raw)))}` })
  } else {
    fields.push(['client_id', cfg.clientId])
    if (cfg.clientSecret) fields.push(['client_secret', cfg.clientSecret])
  }
  if (cfg.audience && !params.refresh_token) fields.push(['audience', cfg.audience])
  return {
    method: 'POST',
    url: cfg.tokenUrl,
    headers,
    body: { mode: 'urlencoded', fields: fields.map(([key, value]) => ({ key, value: String(value) })) },
    protocol: 'http',
  }
}

export const clientCredentialsParams = (cfg) => ({ grant_type: 'client_credentials', scope: cfg.scope })
export const authorizationCodeParams = (cfg, { code, redirectUri, verifier }) => ({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier })
export const refreshParams = (cfg, refreshToken) => ({ grant_type: 'refresh_token', refresh_token: refreshToken, scope: cfg.scope })

/**
 * Token record from a token endpoint response ({ status, body, json } from sendRequest).
 * Accepts JSON and form-encoded bodies. Throws with the provider's error message.
 * @param previous the token being refreshed: its refresh token is kept when no new one is issued
 */
export function parseTokenResponse(res, previous = null, now = Date.now()) {
  let data = res.json
  if (data === undefined && typeof res.body === 'string' && res.body.includes('=')) data = Object.fromEntries(new URLSearchParams(res.body))
  if (!data || typeof data !== 'object') throw new Error(`Token endpoint answered ${res.status} without a token (${String(res.body || '').slice(0, 120) || 'empty body'})`)
  if (data.error) throw new Error(`Token endpoint: ${data.error}${data.error_description ? `: ${data.error_description}` : ''}`)
  if (res.status >= 400) throw new Error(`Token endpoint answered ${res.status}`)
  if (!data.access_token) throw new Error('The token endpoint response has no access_token.')
  const expiresIn = Number(data.expires_in)
  return {
    accessToken: String(data.access_token),
    tokenType: data.token_type || 'Bearer',
    refreshToken: data.refresh_token || previous?.refreshToken || null,
    scope: data.scope || previous?.scope || '',
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
    obtainedAt: now,
  }
}

/** True when the token has expired or will within `skewMs`. Tokens without an expiry never expire here. */
export const isExpired = (token, now = Date.now(), skewMs = 30_000) => !!token?.expiresAt && token.expiresAt - skewMs <= now
