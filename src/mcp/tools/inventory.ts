import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { serializedInventoryService } from '@/services/serialized-inventory/serializedInventory.service'
import { auditMcpWrite } from '../audit'
import { adjustInventoryStock } from '@/services/dashboard/productInventory.service'
import { createRawMaterial } from '@/services/dashboard/rawMaterial.service'
import { getReorderSuggestions, getAutoReorderConfig, setAutoReorderConfig } from '@/services/dashboard/autoReorder.service'
import { planGateMessage } from '../planGate'
import { venuesWithFeatureAccess } from '@/services/access/basePlan.service'
import { MovementType, RawMaterialCategory, Unit } from '@prisma/client'

const MOVEMENT_TYPE = {
  adjustment: MovementType.ADJUSTMENT,
  purchase: MovementType.PURCHASE,
  loss: MovementType.LOSS,
} as const

const round2 = (n: number): number => Math.round(n * 100) / 100

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
      const gate = await planGateMessage(venueId, 'INVENTORY_TRACKING', 'El control de inventario') // PREMIUM tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
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
    'reorder_suggestions',
    'What to re-order right now in a venue you can access: raw materials at/below their reorder point, with the suggested quantity, the best supplier (by price/lead-time/rating), estimated cost and urgency. Also returns whether auto-reorder is enabled. Answers "¿qué pido y a quién?". Pass venueId. Requires the PREMIUM auto-reorder feature.',
    {
      venueId: z.string().describe('Venue whose reorder suggestions to compute (must be in your scope)'),
    },
    async ({ venueId }) => {
      guard.venueFilter(venueId) // throws if out of scope
      const entitled = [...(await venuesWithFeatureAccess([venueId], 'AUTO_REORDER'))]
      if (entitled.length === 0) {
        return text({ ok: false, planRequired: true, error: 'El re-orden automático requiere el plan PREMIUM (AUTO_REORDER).' })
      }
      const config = await getAutoReorderConfig(venueId)
      const { suggestions, totalSuggestions, criticalCount } = await getReorderSuggestions(venueId)
      return text({
        venueId,
        autoReorderEnabled: config.enabled,
        totalSuggestions,
        criticalCount,
        suggestions: suggestions.slice(0, 50).map(s => ({
          name: s.rawMaterial.name,
          currentStock: s.rawMaterial.currentStock,
          reorderPoint: s.rawMaterial.reorderPoint,
          urgency: s.suggestion.urgency,
          suggestedQuantity: s.suggestion.suggestedQuantity,
          estimatedCost: s.suggestion.estimatedCost,
          supplier: s.suggestion.recommendedSupplier?.name ?? null,
        })),
      })
    },
  )

  server.tool(
    'configure_auto_reorder',
    'Turn automatic supplier re-ordering ON or OFF for a venue you can access, and set the optional daily spend cap (MXN) and minimum urgency. When ON, the nightly job creates approved purchase orders for low-stock ingredients and EMAILS the supplier automatically. This WRITES — requires inventory:update and the PREMIUM AUTO_REORDER feature.',
    {
      venueId: z.string().describe('Venue to configure (must be in your scope)'),
      enabled: z.boolean().describe('true = turn auto-reorder ON (will email suppliers automatically), false = OFF'),
      dailyCapMxn: z.number().positive().nullable().optional().describe('Optional daily auto-spend cap in MXN. null/omit = no cap.'),
      minUrgency: z
        .enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
        .optional()
        .describe("Only auto-order items at/above this urgency. Default 'LOW' (everything below reorder point)."),
    },
    async ({ venueId, enabled, dailyCapMxn, minUrgency }) => {
      guard.venueFilter(venueId) // throws if out of scope
      guard.requirePermission('inventory:update', venueId) // write gate
      const entitled = [...(await venuesWithFeatureAccess([venueId], 'AUTO_REORDER'))]
      if (entitled.length === 0) {
        return text({ ok: false, planRequired: true, error: 'El re-orden automático requiere el plan PREMIUM (AUTO_REORDER).' })
      }
      const current = await getAutoReorderConfig(venueId)
      try {
        const config = await setAutoReorderConfig(venueId, {
          enabled,
          dailyCapMxn: dailyCapMxn !== undefined ? dailyCapMxn : current.dailyCapMxn,
          minUrgency: minUrgency ?? current.minUrgency,
        })
        await auditMcpWrite(scope, {
          action: 'AUTO_REORDER_CONFIG_UPDATED',
          entity: 'Venue',
          entityId: venueId,
          venueId,
          data: { enabled: config.enabled, dailyCapMxn: config.dailyCapMxn, minUrgency: config.minUrgency },
        })
        return text({ ok: true, config })
      } catch (err) {
        // e.g. enabling without a venue delivery address (blocked by setAutoReorderConfig)
        return text({ ok: false, error: (err as Error).message })
      }
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
      const gate = await planGateMessage(venueId, 'INVENTORY_TRACKING', 'El control de inventario') // PREMIUM tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
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
      // SERIALIZED_INVENTORY is a PREMIUM capability — filter to entitled venues (cfdi_status pattern).
      const requestedIds = venueId ? [venueId] : scope.allowedVenueIds
      const entitledIds = [...(await venuesWithFeatureAccess(requestedIds, 'SERIALIZED_INVENTORY'))]
      if (entitledIds.length === 0) {
        return text({
          ok: false,
          planRequired: true,
          error: 'El inventario serializado no está incluido en el plan actual (requiere SERIALIZED_INVENTORY).',
        })
      }
      where.venueId = { in: entitledIds }
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
      const gate = await planGateMessage(venueId, 'SERIALIZED_INVENTORY', 'El inventario serializado') // PREMIUM tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
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

  server.tool(
    'stock_value',
    'The value of a venue\'s QUANTITY-tracked inventory: total cost value (current stock × unit cost) and total retail value (current stock × price), the potential margin between them, and how many in-stock items are missing a cost. Lists the top items by cost value. Only items WITH a cost set count toward the cost total — never estimated. Answers "¿cuánto vale mi inventario? ¿cuánto tengo invertido en stock?". Pass venueId. (Serialized items — SIMs/barcodes — are not included; use serialized_inventory.)',
    {
      venueId: z.string().describe('Venue whose inventory value to compute (must be in your scope)'),
      limit: z.number().int().positive().max(100).optional().describe('How many top items (by cost value) to list (default 20)'),
    },
    async ({ venueId, limit }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const gate = await planGateMessage(venueId, 'INVENTORY_TRACKING', 'El control de inventario') // PREMIUM tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      // currentStock × cost can't be multiplied in a SQL aggregate; fetch in-stock items and compute in memory.
      const rows = await prisma.inventory.findMany({
        where: { ...where, currentStock: { gt: 0 } },
        select: { currentStock: true, product: { select: { name: true, sku: true, cost: true, price: true } } },
      })

      let costValue = 0
      let retailValue = 0
      let itemsWithoutCost = 0
      const items = rows.map(r => {
        const stock = Number(r.currentStock)
        const cost = r.product?.cost == null ? null : Number(r.product.cost)
        const price = r.product?.price == null ? 0 : Number(r.product.price)
        const itemCost = cost == null ? null : round2(stock * cost)
        if (itemCost == null) itemsWithoutCost += 1
        else costValue += itemCost
        retailValue += stock * price
        return {
          product: r.product?.name ?? null,
          sku: r.product?.sku ?? null,
          stock,
          unitCost: cost, // null if no cost set on the product
          costValue: itemCost,
          retailValue: round2(stock * price),
        }
      })
      items.sort((a, b) => (b.costValue ?? 0) - (a.costValue ?? 0))

      return text({
        venueId,
        productsInStock: rows.length,
        itemsWithoutCost,
        totalCostValue: round2(costValue), // items that have a cost only
        totalRetailValue: round2(retailValue),
        potentialMargin: round2(retailValue - costValue),
        topItems: items.slice(0, limit ?? 20),
      })
    },
  )

  server.tool(
    'create_raw_material',
    'Create a NEW raw material / ingredient (for recipe-based inventory) in a venue you can access: name, category, unit of measure, current stock, minimum stock, reorder point and cost per unit. Recipes consume these. This WRITES — requires inventory:create. category ∈ {MEAT, POULTRY, SEAFOOD, DAIRY, CHEESE, EGGS, VEGETABLES, FRUITS, GRAINS, BREAD, PASTA, RICE, BEANS, SPICES, HERBS, OILS, SAUCES, CONDIMENTS, BEVERAGES, ALCOHOL, CLEANING, PACKAGING, OTHER}. unit ∈ {KILOGRAM, GRAM, POUND, OUNCE, LITER, MILLILITER, GALLON, CUP, TABLESPOON, TEASPOON, PIECE, UNIT, DOZEN, BOX, BAG, BOTTLE, CAN, JAR, …}.',
    {
      venueId: z.string().describe('Venue to create the raw material in (must be in your scope)'),
      name: z.string().min(1).describe('Ingredient name, e.g. "Harina"'),
      category: z.string().min(1).describe('Category (see list in the tool description)'),
      unit: z.string().min(1).describe('Unit of measure (see list in the tool description)'),
      currentStock: z.number().min(0).describe('Current stock on hand (in the chosen unit)'),
      minimumStock: z.number().min(0).describe('Minimum stock before it is "low" (must be ≤ reorderPoint)'),
      reorderPoint: z.number().min(0).describe('Stock level at which to reorder'),
      costPerUnit: z.number().positive().describe('Cost per unit (money)'),
      sku: z.string().optional().describe('Stock code (auto-generated from the name if omitted)'),
      description: z.string().optional().describe('Description'),
      perishable: z.boolean().optional().describe('Whether it is perishable'),
    },
    async ({ venueId, name, category, unit, currentStock, minimumStock, reorderPoint, costPerUnit, sku, description, perishable }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('inventory:create', venueId) // write gate (per-venue role)
      const gate = await planGateMessage(venueId, 'INVENTORY_TRACKING', 'El control de inventario') // PREMIUM tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      const catU = category.trim().toUpperCase()
      const unitU = unit.trim().toUpperCase()
      if (!(Object.values(RawMaterialCategory) as string[]).includes(catU)) {
        return text({ ok: false, error: `Categoría "${category}" inválida. Opciones: ${Object.values(RawMaterialCategory).join(', ')}` })
      }
      if (!(Object.values(Unit) as string[]).includes(unitU)) {
        return text({ ok: false, error: `Unidad "${unit}" inválida. Opciones: ${Object.values(Unit).join(', ')}` })
      }
      if (minimumStock > reorderPoint) return text({ ok: false, error: 'minimumStock debe ser menor o igual a reorderPoint.' })

      const finalSku =
        sku?.trim() ||
        `${
          name
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '')
            .slice(0, 8) || 'RAW'
        }-${Date.now().toString(36).slice(-5).toUpperCase()}`
      try {
        const rm = await createRawMaterial(venueId, {
          name,
          sku: finalSku,
          category: catU as RawMaterialCategory,
          unit: unitU as Unit,
          currentStock,
          minimumStock,
          reorderPoint,
          costPerUnit,
          perishable: perishable ?? false,
          ...(description ? { description } : {}),
        })
        await auditMcpWrite(scope, {
          action: 'RAW_MATERIAL_CREATED',
          entity: 'RawMaterial',
          entityId: rm.id,
          venueId,
          data: { name, category: catU, unit: unitU, currentStock, costPerUnit },
        })
        return text({ ok: true, rawMaterial: { id: rm.id, name: rm.name, sku: rm.sku, category: catU, unit: unitU, currentStock } })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
