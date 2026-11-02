import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpScope } from '../scope'
import { z } from 'zod'
import { createGuard } from '../guard'
import { text } from '../respond'
import { getCryptoOperationForVenue } from '@/services/b4bit/b4bit.service'

export function registerCryptoOperationTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'get_crypto_operation',
    'Read one exact cryptocurrency payment operation for an accessible venue, in pesos. Separates preparation and provider evidence from financially recorded money. A cancelled screen or unavailable provider does not prove no payment. Read-only; unresolved differences remain assigned to the venue manager.',
    {
      venueId: z.string().describe('Venue whose cryptocurrency operation to read'),
      idempotencyKey: z
        .string()
        .regex(/^c[a-z0-9]{24}$/, 'La operación debe ser un cuid v1 válido')
        .describe('Exact identifier of the payment gesture'),
    },
    async ({ venueId, idempotencyKey }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('payments:read', venueId)
      return text(await getCryptoOperationForVenue(venueId, idempotencyKey, undefined, scope.staffId))
    },
  )
}
