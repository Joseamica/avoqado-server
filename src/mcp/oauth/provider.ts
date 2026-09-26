import type { Response } from 'express'
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { issueMcpToken, verifyMcpToken } from '../mcpToken'
import { prismaClientsStore } from './clientsStore'
import { consumeAuthCode, peekAuthCodeChallenge, createRefreshToken, consumeRefreshToken, revokeRefreshToken } from './tokenStore'
import { renderLoginPage } from './loginPage'
import { ACCESS_TTL_SECONDS, MCP_RESOURCE_URL, MCP_SCOPES_SUPPORTED } from './config'
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { motivoDeConcesionInvalidada, motivoDeSesionInvalidada } from '../../utils/passwordChangeGuard'

// Codex S4: cambiar la contraseña o «cerrar sesión en todos mis dispositivos» mata también lo que el
// asistente tiene guardado — el código sin canjear y el refresh de 30 días —, no sólo el dashboard.
const SESION_CORTADA = 'la sesión se cerró (cambio de contraseña o cierre de sesiones); vuelve a conectar'

export const provider: OAuthServerProvider = {
  get clientsStore() {
    return prismaClientsStore
  },

  // Render the bcrypt consent page. The form POSTs to /mcp-oauth/approve (our route),
  // which is where the redirect-with-code actually happens.
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).send(
      renderLoginPage({
        clientId: client.client_id,
        clientName: client.client_name,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state,
        scope: (params.scopes ?? []).join(' ') || undefined,
        resource: params.resource?.href,
      }),
    )
  },

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const challenge = await peekAuthCodeChallenge(authorizationCode)
    if (!challenge) throw new InvalidGrantError('invalid or expired authorization code')
    return challenge
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const data = await consumeAuthCode(authorizationCode)
    if (!data) throw new InvalidGrantError('invalid or expired authorization code')
    if (data.clientId !== client.client_id) throw new InvalidGrantError('code was issued to a different client')
    if (redirectUri !== undefined && redirectUri !== data.redirectUri) throw new InvalidGrantError('redirect_uri mismatch')
    if (await motivoDeConcesionInvalidada(data.staffId, data.issuedAt)) throw new InvalidGrantError(SESION_CORTADA)

    const access_token = issueMcpToken(data.staffId, data.activeOrg, ACCESS_TTL_SECONDS, client.client_id, data.scopes, data.issuedAt)
    const { token: refresh_token } = await createRefreshToken({
      clientId: client.client_id,
      staffId: data.staffId,
      activeOrg: data.activeOrg,
      scopes: data.scopes,
      // La cadena nace con la fecha del código: ése es el momento en que el dueño autorizó.
      grantedAt: data.issuedAt,
    })
    return { access_token, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, scope: data.scopes.join(' ') || undefined, refresh_token }
  },

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const data = await consumeRefreshToken(refreshToken)
    if (!data) throw new InvalidGrantError('invalid or expired refresh token')
    if (data.clientId !== client.client_id) throw new InvalidGrantError('refresh token was issued to a different client')
    if (await motivoDeConcesionInvalidada(data.staffId, data.issuedAt)) throw new InvalidGrantError(SESION_CORTADA)

    const grantedScopes = scopes && scopes.length ? scopes.filter(s => data.scopes.includes(s)) : data.scopes
    const access_token = issueMcpToken(data.staffId, data.activeOrg, ACCESS_TTL_SECONDS, client.client_id, grantedScopes, data.issuedAt)
    // Rotate: consumeRefreshToken already atomically revoked the presented token (single-use);
    // just issue the replacement. (No separate revoke call — that would be a redundant no-op now.)
    // 🔴 El reemplazo HEREDA la fecha original (Codex ronda 8): validar y emitir no son atómicos, y un
    // cambio de contraseña en medio no puede dejar viva una cadena que ya se autorizó antes del corte.
    const { token: refresh_token } = await createRefreshToken({
      clientId: client.client_id,
      staffId: data.staffId,
      activeOrg: data.activeOrg,
      scopes: grantedScopes,
      grantedAt: data.issuedAt,
    })
    return {
      access_token,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
      scope: grantedScopes.join(' ') || undefined,
      refresh_token,
    }
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { sub, org, cid, scp, exp, iat, gat } = verifyMcpToken(token) // throws on bad/expired/wrong-audience
    // Mismo corte y mismo margen que cualquier token de acceso (segundos). Se juzga con la fecha MÁS
    // VIEJA que trae: la de la autorización original de su cadena, si la tiene (Codex ronda 8).
    const emision = typeof gat === 'number' && typeof iat === 'number' ? Math.min(iat, gat) : iat
    if (await motivoDeSesionInvalidada(sub, emision)) throw new InvalidTokenError(SESION_CORTADA)
    return {
      token,
      clientId: cid ?? sub, // dev-server tokens have no cid; fall back to the subject
      // Report the token's REAL granted scopes (was hardcoded to the full supported set — the bug
      // that made a mcp:read grant behave like read+write). Legacy/dev tokens without `scp` fall
      // back to full so they keep working until they refresh into a scoped token.
      scopes: scp && scp.length ? scp : MCP_SCOPES_SUPPORTED,
      expiresAt: exp, // required by the SDK bearer middleware
      resource: MCP_RESOURCE_URL,
      extra: { staffId: sub, activeOrg: org, scopes: scp && scp.length ? scp : undefined },
    }
  },

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    // Access tokens are stateless JWTs (expire in 1h); we revoke refresh tokens only.
    await revokeRefreshToken(request.token)
  },
}
