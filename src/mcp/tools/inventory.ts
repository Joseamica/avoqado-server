import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

export function registerInventoryTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'serialized_inventory',
    'Inventory of serialized items (SIMs, barcoded units, certificates) across your venues, counted by status: AVAILABLE, SOLD, RETURNED, DAMAGED. Pass venueId to focus one venue. (Org-level items not tied to a venue are not counted here.)',
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
    },
    async ({ venueId }) => {
      const where = guard.venueFilter(venueId) // throws if out of scope
      const grouped = await prisma.serializedItem.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      })
      const byStatus: Record<string, number> = {}
      for (const g of grouped) byStatus[g.status] = g._count._all
      const total = Object.values(byStatus).reduce((a, b) => a + b, 0)
      return text({
        venuesInScope: venueId ? 1 : scope.allowedVenueIds.length,
        available: byStatus.AVAILABLE ?? 0,
        sold: byStatus.SOLD ?? 0,
        total,
        byStatus,
      })
    },
  )
}
