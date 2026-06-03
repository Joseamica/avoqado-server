import type { Response } from 'express'
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { issueMcpToken, verifyMcpToken } from '../mcpToken'
import { prismaClientsStore } from './clientsStore'
import { consumeAuthCode, peekAuthCodeChallenge, createRefreshToken, consumeRefreshToken, revokeRefreshToken } from './tokenStore'
import { renderLoginPage } from './loginPage'
import { ACCESS_TTL_SECONDS, MCP_RESOURCE_URL, MCP_SCOPES_SUPPORTED } from './config'

class InvalidGrant extends Error {}

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
    if (!challenge) throw new InvalidGrant('invalid or expired authorization code')
    return challenge
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const data = await consumeAuthCode(authorizationCode)
    if (!data) throw new InvalidGrant('invalid or expired authorization code')
    if (data.clientId !== client.client_id) throw new InvalidGrant('code was issued to a different client')
    if (redirectUri !== undefined && redirectUri !== data.redirectUri) throw new InvalidGrant('redirect_uri mismatch')

    const access_token = issueMcpToken(data.staffId, data.activeOrg, ACCESS_TTL_SECONDS, client.client_id)
    const { token: refresh_token } = await createRefreshToken({
      clientId: client.client_id,
      staffId: data.staffId,
      activeOrg: data.activeOrg,
      scopes: data.scopes,
    })
    return { access_token, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, scope: data.scopes.join(' ') || undefined, refresh_token }
  },

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const data = await consumeRefreshToken(refreshToken)
    if (!data) throw new InvalidGrant('invalid or expired refresh token')
    if (data.clientId !== client.client_id) throw new InvalidGrant('refresh token was issued to a different client')

    const grantedScopes = scopes && scopes.length ? scopes.filter(s => data.scopes.includes(s)) : data.scopes
    const access_token = issueMcpToken(data.staffId, data.activeOrg, ACCESS_TTL_SECONDS, client.client_id)
    // Rotate the refresh token (revoke old, issue new) — refresh-token rotation best practice.
    await revokeRefreshToken(refreshToken)
    const { token: refresh_token } = await createRefreshToken({
      clientId: client.client_id,
      staffId: data.staffId,
      activeOrg: data.activeOrg,
      scopes: grantedScopes,
    })
    return { access_token, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, scope: grantedScopes.join(' ') || undefined, refresh_token }
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { sub, org, cid } = verifyMcpToken(token) // throws on bad/expired/wrong-audience
    return {
      token,
      clientId: cid ?? sub, // dev-server tokens have no cid; fall back to the subject
      scopes: MCP_SCOPES_SUPPORTED,
      resource: MCP_RESOURCE_URL,
      extra: { staffId: sub, activeOrg: org },
    }
  },

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    // Access tokens are stateless JWTs (expire in 1h); we revoke refresh tokens only.
    await revokeRefreshToken(request.token)
  },
}
