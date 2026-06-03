import { randomBytes, createHash } from 'crypto'
import prisma from '@/utils/prismaClient'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

function toClientInfo(row: {
  clientId: string
  clientSecretHash: string | null
  clientName: string | null
  redirectUris: string[]
  grantTypes: string[]
  scope: string | null
  tokenEndpointAuthMethod: string | null
  clientIdIssuedAt: number | null
  clientSecretExpiresAt: number | null
}): OAuthClientInformationFull {
  return {
    client_id: row.clientId,
    // We never return the secret hash; presence is signalled by client_secret_expires_at.
    redirect_uris: row.redirectUris as [string, ...string[]],
    client_name: row.clientName ?? undefined,
    grant_types: row.grantTypes.length ? row.grantTypes : undefined,
    scope: row.scope ?? undefined,
    token_endpoint_auth_method: row.tokenEndpointAuthMethod ?? undefined,
    client_id_issued_at: row.clientIdIssuedAt ?? undefined,
    client_secret_expires_at: row.clientSecretExpiresAt ?? undefined,
    logo_uri: undefined,
    tos_uri: undefined,
  }
}

export const prismaClientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const row = await prisma.mcpOAuthClient.findUnique({ where: { clientId } })
    return row ? toClientInfo(row) : undefined
  },

  async registerClient(client): Promise<OAuthClientInformationFull> {
    const clientId = `mcp_${randomBytes(16).toString('hex')}`
    const issuedAt = Math.floor(Date.now() / 1000)
    // Public clients (Claude Desktop) use PKCE with no secret. Issue a secret only if the
    // client asked for a confidential auth method.
    const isConfidential = client.token_endpoint_auth_method && client.token_endpoint_auth_method !== 'none'
    const secret = isConfidential ? randomBytes(32).toString('hex') : undefined
    await prisma.mcpOAuthClient.create({
      data: {
        clientId,
        clientSecretHash: secret ? sha256(secret) : null,
        clientName: client.client_name ?? null,
        redirectUris: client.redirect_uris,
        grantTypes: client.grant_types ?? [],
        scope: client.scope ?? null,
        tokenEndpointAuthMethod: client.token_endpoint_auth_method ?? 'none',
        clientIdIssuedAt: issuedAt,
        clientSecretExpiresAt: secret ? 0 : null, // 0 = never expires
      },
    })
    return {
      ...client,
      client_id: clientId,
      client_id_issued_at: issuedAt,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    }
  },
}
