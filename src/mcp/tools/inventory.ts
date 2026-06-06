import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { serializedInventoryService } from '@/services/serialized-inventory/serializedInventory.service'
import { auditMcpWrite } from '../audit'
import { adjustInventoryStock } from '@/services/dashboard/productInventory.service'
import { MovementType } from '@prisma/client'

const MOVEMENT_TYPE = {
  adjustment: MovementType.ADJUSTMENT,
  purchase: MovementType.PURCHASE,
  loss: MovementType.LOSS,
} as const

export function registerInventoryTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'low_stock',
    'Products running low in a venue you can access: items whose current stock is at or below their minimum (reorder) level. Returns the product, current vs minimum stock, how short it is, and when it was last restocked — most depleted first. Answers "¿qué se me está acabando? ¿qué necesito reordenar?". Pass venueId.',
    {
      venueId: z.string().describe('Venue whose inventory to check (must be in your scope)'),
      limit: z.number().int().positive().max(100).optional().describe('Max items to return (default 50)'),
    },
    async ({ venueId, limit }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      // Only items with a configured minimum (> 0). Prisma can't compare two columns in `where`,
      // so fetch the tracked set and filter currentStock <= minimumStock in memory.
      const tracked = await prisma.inventory.findMany({
        where: { ...where, minimumStock: { gt: 0 } },
        select: {
          currentStock: true,
          minimumStock: true,
          lastRestockedAt: true,
          product: { select: { name: true, sku: true } },
        },
      })
      const lowStock = tracked
        .filter(i => Number(i.currentStock) <= Number(i.minimumStock))
        .map(i => ({
          product: i.product?.name ?? null,
          sku: i.product?.sku ?? null,
          currentStock: Number(i.currentStock),
          minimumStock: Number(i.minimumStock),
          shortBy: Math.round((Number(i.minimumStock) - Number(i.currentStock)) * 100) / 100,
          lastRestockedAt: i.lastRestockedAt?.toISOString() ?? null,
        }))
        .sort((a, b) => b.shortBy - a.shortBy)
        .slice(0, limit ?? 50)
      return text({ venueId, count: lowStock.length, lowStock })
    },
  )

  server.tool(
    'adjust_stock',
    'Adjust the stock of a QUANTITY-tracked product in a venue you can access, found by name. `delta` is the CHANGE (not the new total): positive adds (e.g. 50 = stock received), negative subtracts (e.g. -10 = waste/correction). Cannot push stock below 0. This WRITES — changes inventory; requires inventory:adjust. If the name matches several products it returns them so you can be specific.',
    {
      venueId: z.string().describe('Venue that owns the product (must be in your scope)'),
      name: z.string().min(1).describe('Product name or part of it'),
      delta: z.number().describe('Stock CHANGE: positive adds (50 received), negative subtracts (-10 waste). NOT the new total.'),
      type: z
        .enum(['adjustment', 'purchase', 'loss'])
        .optional()
        .describe("Reason category: 'adjustment' (default), 'purchase' (stock received), 'loss' (waste/damage)"),
      reason: z.string().optional().describe('Free-text reason (e.g. "merma", "recepción de mercancía")'),
    },
    async ({ venueId, name, delta, type, reason }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if out of scope
      guard.requirePermission('inventory:adjust', venueId) // write gate (per-venue role)
      const matches = await prisma.product.findMany({
        where: { ...where, name: { contains: name, mode: 'insensitive' as const }, trackInventory: true, inventoryMethod: 'QUANTITY' },
        select: { id: true, name: true },
        take: 10,
      })
      if (matches.length === 0) {
        return text({ ok: false, error: `No encontré un producto con inventario por cantidad que coincida con "${name}".` })
      }
      if (matches.length > 1) {
        return text({
          ok: false,
          ambiguous: true,
          error: `"${name}" coincide con varios productos — sé más específico.`,
          matches: matches.map(m => m.name),
        })
      }
      try {
        const result = await adjustInventoryStock(
          venueId,
          matches[0].id,
          { quantity: delta, type: MOVEMENT_TYPE[type ?? 'adjustment'], reason },
          scope.staffId,
        )
        await auditMcpWrite(scope, {
          action: 'INVENTORY_STOCK_ADJUSTED',
          entity: 'Product',
          entityId: matches[0].id,
          venueId,
          data: { name: matches[0].name, delta, type: type ?? 'adjustment', reason, newStock: result.currentStock },
        })
        return text({ ok: true, product: matches[0].name, newStock: result.currentStock, minimumStock: result.minimumStock })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

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
