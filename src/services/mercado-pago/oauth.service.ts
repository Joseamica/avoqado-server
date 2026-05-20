/**
 * Mercado Pago OAuth core service.
 *
 * Pure helpers around MP's OAuth2 endpoints:
 *   - signState(payload) / verifyState(token): HMAC-signed state envelope
 *     using OAUTH_STATE_SECRET (the same secret Google Calendar OAuth uses).
 *     Stateless, no DB row required. 10-min TTL outlasts the redirect roundtrip.
 *   - buildAuthUrl(state): constructs the MP-MX consent URL the dashboard
 *     redirects sellers to.
 *   - exchangeCodeForTokens(code): redeems an authorization code at /oauth/token.
 *   - refreshAccessToken(refreshToken): mints a new access_token before the
 *     180-day expiry — used by the cron job and on-demand by services.
 *
 * MP API hosts default to Mexico (`auth.mercadopago.com.mx` /
 * `api.mercadopago.com`). Override via MP_AUTH_BASE_URL / MP_API_BASE_URL for
 * regional variants or tests.
 *
 * Note: We use raw axios for OAuth because the official `mercadopago` SDK
 * doesn't expose OAuth helpers — it assumes you already have an access_token.
 */
import axios, { AxiosError } from 'axios'
import jwt, { SignOptions } from 'jsonwebtoken'
import type { MercadoPagoOAuthState, MercadoPagoTokenResponse } from './types'

const STATE_TTL_SECONDS = 600 // 10 min — must outlast the OAuth redirect roundtrip

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is not set`)
  }
  return value
}

export function signState(payload: MercadoPagoOAuthState): string {
  const opts: SignOptions = { expiresIn: STATE_TTL_SECONDS }
  return jwt.sign(payload, requireEnv('OAUTH_STATE_SECRET'), opts)
}

export function verifyState(token: string): MercadoPagoOAuthState {
  return jwt.verify(token, requireEnv('OAUTH_STATE_SECRET')) as MercadoPagoOAuthState
}

/**
 * Builds the MP OAuth consent URL the seller is redirected to. The seller
 * approves Avoqado's access, then MP redirects back to `MP_REDIRECT_URI` with
 * a `code` query param the backend exchanges for tokens.
 *
 * Defaults to the Mexico host. Override via MP_AUTH_BASE_URL for other sites.
 */
export function buildAuthUrl(state: string): string {
  const base = process.env.MP_AUTH_BASE_URL || 'https://auth.mercadopago.com.mx'
  const params = new URLSearchParams({
    client_id: requireEnv('MP_CLIENT_ID'),
    response_type: 'code',
    platform_id: 'mp',
    redirect_uri: requireEnv('MP_REDIRECT_URI'),
    state,
  })
  return `${base}/authorization?${params.toString()}`
}

/**
 * Redeems an authorization code for {access_token, refresh_token, public_key,
 * user_id, expires_in}. MP rotates the refresh_token on each redemption.
 */
export async function exchangeCodeForTokens(code: string): Promise<MercadoPagoTokenResponse> {
  return await postOAuthToken({
    client_id: requireEnv('MP_CLIENT_ID'),
    client_secret: requireEnv('MP_CLIENT_SECRET'),
    grant_type: 'authorization_code',
    code,
    redirect_uri: requireEnv('MP_REDIRECT_URI'),
  })
}

/**
 * Uses an existing refresh_token to mint a new access_token (and a NEW refresh
 * token, which MP also rotates). Callers must persist the new refresh_token.
 */
export async function refreshAccessToken(refreshToken: string): Promise<MercadoPagoTokenResponse> {
  return await postOAuthToken({
    client_id: requireEnv('MP_CLIENT_ID'),
    client_secret: requireEnv('MP_CLIENT_SECRET'),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
}

/**
 * Internal: POST to /oauth/token with the given body. Surfaces MP's
 * `error_description` in the thrown Error message so callers can log it.
 */
async function postOAuthToken(body: Record<string, string>): Promise<MercadoPagoTokenResponse> {
  const apiBase = process.env.MP_API_BASE_URL || 'https://api.mercadopago.com'
  try {
    const { data } = await axios.post<MercadoPagoTokenResponse>(`${apiBase}/oauth/token`, body, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      timeout: 15000,
    })
    return data
  } catch (err) {
    if (err instanceof AxiosError && err.response?.data) {
      const { error, error_description } = err.response.data as { error?: string; error_description?: string }
      throw new Error(
        `MP OAuth ${body.grant_type} failed: ${error || err.message} — ${error_description || ''}`.trim(),
      )
    }
    throw err
  }
}
