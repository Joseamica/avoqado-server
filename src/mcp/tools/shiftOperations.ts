import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpScope } from '../scope'
import { z } from 'zod'
import { createGuard } from '../guard'
import { text } from '../respond'
import { getShiftOperationForVenue } from '@/services/tpv/shift.tpv.service'

export function registerShiftOperationTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'get_shift_operation',
    'Read the exact outcome of one cash-register opening or closing for a venue you can access. Distinguishes pending, applied and conflict; a submitted cash count is evidence and is applied only when countApplied is true. Reports whether the linked physical drawer still needs repair. Never substitutes the currently open shift. Read-only financial operation; pass the operation identifier from the terminal and venueId.',
    {
      venueId: z.string().describe('Venue whose cash-register operation to read'),
      operationId: z
        .string()
        .regex(/^c[a-z0-9]{24}$/, 'La operación debe ser un cuid v1 válido')
        .describe('Exact identifier of the opening or closing gesture'),
    },
    async ({ venueId, operationId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('shifts:read', venueId)
      return text(await getShiftOperationForVenue(venueId, operationId, undefined, scope.staffId))
    },
  )
}
