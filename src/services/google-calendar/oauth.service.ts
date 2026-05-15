/**
 * Google Calendar OAuth core service.
 *
 * Pure helpers around `googleapis` + `google-auth-library`:
 *   - buildAuthUrl(state, forceConsent): builds the consent-screen URL the
 *     dashboard sends the user to.
 *   - signState(payload) / verifyState(token): HMAC-signed CSRF/intent envelope
 *     (separate secret from JWT_SECRET — rotate independently).
 *   - exchangeCodeForTokens(code): redeems the authorization code.
 *   - verifyGoogleIdToken(idToken): cryptographically validates the OIDC id_token
 *     against Google's keyset (audience pinning prevents token confusion).
 *   - refreshAccessToken(refreshToken): refresh-flow used by both the pull
 *     worker and the renewal cron.
 *   - buildOAuthClient(): factory used by watch/pull services to set per-call
 *     credentials.
 */
import jwt, { SignOptions } from 'jsonwebtoken'
import { OAuth2Client } from 'google-auth-library'

/**
 * Google scopes the dashboard requests. Order matters for human-readable
 * consent screens; we put `openid email` first so the user sees we want their
 * email before any calendar permission.
 */
export const GOOGLE_CALENDAR_OAUTH_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
].join(' ')

const STATE_TTL_SECONDS = 600 // 10 min — must outlast the redirect roundtrip

export interface OAuthState {
  intent: 'staff_personal' | 'venue_master'
  authUserId: string
  staffId?: string
  venueId?: string
  csrfNonce: string
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is not set`)
  }
  return value
}

export function buildAuthUrl(state: string, forceConsent: boolean): string {
  const params = new URLSearchParams({
    client_id: requireEnv('GOOGLE_OAUTH_CLIENT_ID'),
    redirect_uri: requireEnv('GOOGLE_OAUTH_REDIRECT_URI'),
    response_type: 'code',
    scope: GOOGLE_CALENDAR_OAUTH_SCOPES,
    access_type: 'offline',
    include_granted_scopes: 'true',
    state,
  })
  if (forceConsent) {
    params.set('prompt', 'consent')
  }
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

export function signState(payload: OAuthState): string {
  const opts: SignOptions = { expiresIn: STATE_TTL_SECONDS }
  return jwt.sign(payload, requireEnv('OAUTH_STATE_SECRET'), opts)
}

export function verifyState(token: string): OAuthState {
  return jwt.verify(token, requireEnv('OAUTH_STATE_SECRET')) as OAuthState
}

/**
 * Builds a fresh OAuth2Client. Each call returns a new instance because
 * `setCredentials` mutates per-call state — using a shared singleton would
 * race when the watch/pull services run concurrently for different connections.
 */
export function buildOAuthClient(): OAuth2Client {
  return new OAuth2Client(
    requireEnv('GOOGLE_OAUTH_CLIENT_ID'),
    requireEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
    requireEnv('GOOGLE_OAUTH_REDIRECT_URI'),
  )
}

/**
 * Redeems the auth code for {access_token, refresh_token, id_token}. The
 * id_token MUST be present (we requested `openid email`); if Google didn't
 * return it, the user did not consent to email and we cannot identify them.
 */
export async function exchangeCodeForTokens(code: string) {
  const client = buildOAuthClient()
  const { tokens } = await client.getToken(code)
  if (!tokens.id_token) {
    throw new Error('oidc_id_token_missing')
  }
  if (!tokens.access_token) {
    throw new Error('oauth_access_token_missing')
  }
  return tokens
}

/**
 * Cryptographically validates an id_token against Google's published keyset.
 * `audience` MUST be set to our client ID — otherwise an attacker could replay
 * an id_token issued for a different app ("token confusion").
 *
 * `email_verified` must be true: a user who has not verified their Google
 * email cannot reliably prove they own the address, and we use email as one
 * of the keys that links a Google account back to an Avoqado Staff row.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<{ sub: string; email: string }> {
  const client = buildOAuthClient()
  const ticket = await client.verifyIdToken({
    idToken,
    audience: requireEnv('GOOGLE_OAUTH_CLIENT_ID'),
  })
  const payload = ticket.getPayload()
  if (!payload?.sub || !payload?.email) {
    throw new Error('oidc_missing_claims')
  }
  if (!payload.email_verified) {
    throw new Error('google_email_not_verified')
  }
  return { sub: payload.sub, email: payload.email }
}

/**
 * Uses an existing refresh_token to mint a new access_token. The OAuth2 client
 * itself decides if Google rotated the refresh token; callers should inspect
 * the returned `credentials.refresh_token` and re-encrypt + persist it if so.
 */
export async function refreshAccessToken(refreshToken: string) {
  const client = buildOAuthClient()
  client.setCredentials({ refresh_token: refreshToken })
  const { credentials } = await client.refreshAccessToken()
  return credentials
}
