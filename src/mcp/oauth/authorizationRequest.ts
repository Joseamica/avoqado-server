import { createHash } from 'crypto'
import { z } from 'zod'
import { InvalidClientError, InvalidRequestError, InvalidScopeError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js'
import { prismaClientsStore } from './clientsStore'
import { MCP_DIRECTORY_RESOURCE_URL, MCP_RESOURCE_URL, MCP_SCOPES_SUPPORTED } from './config'

const requestSchema = z.object({
  client_id: z.string().min(1).max(2048),
  redirect_uri: z.string().url().max(4096),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  scope: z.string().max(512).optional(),
  state: z.string().max(4096).optional(),
  resource: z.string().url().optional(),
})

/** Validate again at consent: hidden form fields and the org-picker query are untrusted input. */
export async function validateAuthorizationRequest(input: unknown) {
  const parsed = requestSchema.safeParse(input)
  if (!parsed.success) throw new InvalidRequestError('Invalid OAuth parameters')
  const data = parsed.data
  const client = await prismaClientsStore.getClient(data.client_id)
  if (!client) throw new InvalidClientError('Unknown OAuth client')
  if (!client.redirect_uris.some(uri => redirectUriMatches(data.redirect_uri, uri)) || new URL(data.redirect_uri).hash) {
    throw new InvalidRequestError('Unregistered redirect_uri')
  }
  const scopes = [...new Set((data.scope ?? 'mcp:read').split(' ').filter(Boolean))]
  if (!scopes.length || scopes.some(scope => !MCP_SCOPES_SUPPORTED.includes(scope))) {
    throw new InvalidScopeError('Unsupported scope')
  }
  if (data.resource !== undefined && ![MCP_RESOURCE_URL.href, MCP_DIRECTORY_RESOURCE_URL.href].includes(data.resource)) {
    throw new InvalidRequestError('Invalid resource')
  }
  // Fixed key order + sorted scopes make the binding independent of form field order.
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify([
        data.client_id,
        data.redirect_uri,
        data.code_challenge,
        data.state ?? '',
        [...scopes].sort(),
        data.resource ?? MCP_RESOURCE_URL.href,
      ]),
    )
    .digest('hex')
  return { ...data, scopes, client, requestHash }
}
