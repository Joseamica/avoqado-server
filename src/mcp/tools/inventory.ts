import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { serializedInventoryService } from '@/services/serialized-inventory/serializedInventory.service'
import { auditMcpWrite } from '../audit'

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

  server.tool(
    'mark_serialized_item',
    'Mark a serialized item (SIM / ICCID / barcode) as RETURNED (reverses a sale and frees it back up the custody chain) or DAMAGED (removes it from the sellable chain). Identify it by serial number within a venue you can access. This WRITES — it changes inventory state; requires inventory:adjust.',
    {
      venueId: z.string().describe('Venue that owns the item (must be in your scope)'),
      serialNumber: z.string().min(1).describe('Serial number / ICCID / barcode of the item'),
      action: z.enum(['returned', 'damaged']).describe("'returned' reverses a sale; 'damaged' marks it unsellable"),
    },
    async ({ venueId, serialNumber, action }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('inventory:adjust', venueId) // write gate (per-venue role)
      try {
        const item =
          action === 'returned'
            ? await serializedInventoryService.markAsReturned(venueId, serialNumber)
            : await serializedInventoryService.markAsDamaged(venueId, serialNumber)
        await auditMcpWrite(scope, {
          action: 'SERIALIZED_ITEM_MARKED',
          entity: 'SerializedItem',
          entityId: item.id,
          venueId,
          data: { serialNumber: item.serialNumber, status: item.status, action },
        })
        return text({ ok: true, item: { serialNumber: item.serialNumber, status: item.status, custodyState: item.custodyState } })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
