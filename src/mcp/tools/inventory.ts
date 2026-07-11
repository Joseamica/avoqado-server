import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { adjustInventoryStock } from '@/services/dashboard/productInventory.service'
import { createRawMaterial } from '@/services/dashboard/rawMaterial.service'
import { getReorderSuggestions, getAutoReorderConfig, setAutoReorderConfig } from '@/services/dashboard/autoReorder.service'
import { planGateMessage } from '../planGate'
import { venuesWithFeatureAccess } from '@/services/access/basePlan.service'
import { venueStartOfDay, venueEndOfDay } from '@/utils/datetime'
import { MovementType, RawMaterialMovementType, RawMaterialCategory, Unit } from '@prisma/client'

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
      guard.requirePermission('inventory:read', venueId) // WHY: mirror the dashboard's inventory:read gate — a low role shouldn't read stock/costs the dashboard 403s
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
    'What to re-order right now in a venue you can access: raw materials at/below their reorder point, with the suggested quantity, the best supplier (by price/lead-time/rating), estimated cost and urgency. Also returns whether auto-reorder is enabled. Answers "¿qué pido y a quién?". Pass venueId. The server enforces plan access and returns a clear message if the venue is not entitled — do NOT pre-judge plan eligibility yourself.',
    {
      venueId: z.string().describe('Venue whose reorder suggestions to compute (must be in your scope)'),
    },
    async ({ venueId }) => {
      guard.venueFilter(venueId) // throws if out of scope
      guard.requirePermission('inventory:read', venueId) // WHY: mirror the dashboard's inventory:read gate — reorder suggestions expose purchase costs
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
    'Turn automatic supplier re-ordering ON or OFF for a venue you can access, and set the optional daily spend cap (MXN) and minimum urgency. When ON, the nightly job creates approved purchase orders for low-stock ingredients and EMAILS the supplier automatically. This WRITES — requires the inventory:update permission; the server enforces plan access and returns a clear message if the venue is not entitled, so do NOT pre-judge plan eligibility yourself.',
    {
      venueId: z.string().describe('Venue to configure (must be in your scope)'),
      enabled: z.boolean().describe('true = turn auto-reorder ON (will email suppliers automatically), false = OFF'),
      dailyCapMxn: z.number().positive().nullable().optional().describe('Optional daily auto-spend cap in MXN. null/omit = no cap.'),
      minUrgency: z
        .enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
        .optional()
        .describe("Only auto-order items at/above this urgency. Default 'LOW' (everything below reorder point)."),
      confirm: z
        .boolean()
        .optional()
        .describe('Must be true to actually apply; without it you get a preview (auto-reorder emails suppliers)'),
    },
    async ({ venueId, enabled, dailyCapMxn, minUrgency, confirm }) => {
      guard.venueFilter(venueId) // throws if out of scope
      guard.requirePermission('inventory:update', venueId) // write gate
      const entitled = [...(await venuesWithFeatureAccess([venueId], 'AUTO_REORDER'))]
      if (entitled.length === 0) {
        return text({ ok: false, planRequired: true, error: 'El re-orden automático requiere el plan PREMIUM (AUTO_REORDER).' })
      }
      const current = await getAutoReorderConfig(venueId)
      if (!confirm) {
        // High-impact: turning this ON makes the nightly job auto-create POs and EMAIL suppliers. Never on a vague request.
        return text({
          ok: false,
          requiresConfirmation: true,
          change: { label: 'Auto-reorden', from: current.enabled ? 'ON' : 'OFF', to: enabled ? 'ON' : 'OFF' },
          message: `Esto ${enabled ? 'ENCENDERÁ' : 'apagará'} el re-orden automático${enabled ? ' — el job nocturno creará órdenes de compra y ENVIARÁ correos a proveedores solo' : ''}. Confirma con el operador; luego vuelve a llamar con confirm:true.`,
        })
      }
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
    'Adjust the stock of a QUANTITY-tracked product in a venue you can access, found by name. `delta` is the CHANGE (not the new total): positive adds (e.g. 50 = stock received), negative subtracts (e.g. -10 = waste/correction). Cannot push stock below 0. By DEFAULT this only PREVIEWS the change (current stock → new stock); call again with confirm:true to actually apply it. This WRITES — requires inventory:adjust. If the name matches several products it returns them so you can be specific.',
    {
      venueId: z.string().describe('Venue that owns the product (must be in your scope)'),
      name: z.string().min(1).describe('Product name or part of it'),
      delta: z.number().describe('Stock CHANGE: positive adds (50 received), negative subtracts (-10 waste). NOT the new total.'),
      type: z
        .enum(['adjustment', 'purchase', 'loss'])
        .optional()
        .describe("Reason category: 'adjustment' (default), 'purchase' (stock received), 'loss' (waste/damage)"),
      reason: z.string().optional().describe('Free-text reason (e.g. "merma", "recepción de mercancía")'),
      confirm: z.boolean().optional().describe('Must be true to actually apply the adjustment; without it you get a preview'),
    },
    async ({ venueId, name, delta, type, reason, confirm }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if out of scope
      guard.requirePermission('inventory:adjust', venueId) // write gate (per-venue role)
      const gate = await planGateMessage(venueId, 'INVENTORY_TRACKING', 'El control de inventario') // PREMIUM tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      const matches = await prisma.product.findMany({
        where: { ...where, name: { contains: name, mode: 'insensitive' as const }, trackInventory: true, inventoryMethod: 'QUANTITY' },
        select: { id: true, name: true, inventory: { select: { currentStock: true } } },
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
      const currentStock = Number(matches[0].inventory?.currentStock ?? 0)
      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          change: { product: matches[0].name, label: 'Stock', from: currentStock, delta, to: round2(currentStock + delta) },
          message: `Esto ajustará el stock de "${matches[0].name}": ${currentStock} ${delta >= 0 ? '+' : ''}${delta} → ${round2(currentStock + delta)}. Confirma con el operador; luego vuelve a llamar con confirm:true.`,
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
    'stock_value',
    'The value of a venue\'s QUANTITY-tracked inventory: total cost value (current stock × unit cost) and total retail value (current stock × price), the potential margin between them, and how many in-stock items are missing a cost. Lists the top items by cost value. Only items WITH a cost set count toward the cost total — never estimated. Answers "¿cuánto vale mi inventario? ¿cuánto tengo invertido en stock?". Pass venueId. (Serialized items — SIMs/barcodes — are not included; use serialized_inventory.)',
    {
      venueId: z.string().describe('Venue whose inventory value to compute (must be in your scope)'),
      limit: z.number().int().positive().max(100).optional().describe('How many top items (by cost value) to list (default 20)'),
    },
    async ({ venueId, limit }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('inventory:read', venueId) // WHY: mirror the dashboard's inventory:read gate — inventory valuation/margin is not free-for-all
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

  server.tool(
    'get_inventory_movements',
    'Movement history (kardex / bitácora) of a venue\'s inventory: every stock change — purchases, sales, manual ADJUSTMENTs, losses, counts, transfers — with WHO made it, WHEN, the change in quantity, the stock BEFORE and AFTER, and the reason. Covers BOTH QUANTITY-tracked products and raw materials/ingredients. Filter by `type` (use ADJUSTMENT to spot manual edits — e.g. someone lowering stock by hand), by item `name`, and by date range; newest first. Answers "¿quién bajó el inventario manualmente?", "¿qué ajustes se hicieron del 1 al 15?", "¿por qué cambió el stock de X?". A negative quantity = stock went DOWN. Pass venueId. PREMIUM (INVENTORY_TRACKING).',
    {
      venueId: z.string().describe('Venue whose movement history to read (must be in your scope)'),
      type: z
        .enum(['ADJUSTMENT', 'PURCHASE', 'SALE', 'USAGE', 'LOSS', 'SPOILAGE', 'TRANSFER', 'COUNT', 'RETURN'])
        .optional()
        .describe('Only this movement type. ADJUSTMENT = manual edit (best for spotting hand-lowered stock). Omit for all types.'),
      name: z.string().optional().describe('Only movements of products/ingredients whose name contains this text'),
      fromDate: z.string().optional().describe('Venue-local start date YYYY-MM-DD (inclusive). Omit for no lower bound.'),
      toDate: z.string().optional().describe('Venue-local end date YYYY-MM-DD (inclusive, whole day). Omit for no upper bound.'),
      limit: z.number().int().positive().max(200).optional().describe('Max movements to return (default 50)'),
    },
    async ({ venueId, type, name, fromDate, toDate, limit }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('inventory:read', venueId) // WHY: mirror the dashboard's inventory:read gate — the movement kardex (WHO adjusted stock) is sensitive anti-fraud data
      const gate = await planGateMessage(venueId, 'INVENTORY_TRACKING', 'El control de inventario') // PREMIUM tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      const take = limit ?? 50
      // Venue-local day window → real UTC instants (noon-anchor keeps the calendar day under any host TZ).
      const tz = (await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } }))?.timezone || 'America/Mexico_City'
      const gte = fromDate ? venueStartOfDay(tz, new Date(`${fromDate}T12:00:00`)) : undefined
      const lte = toDate ? venueEndOfDay(tz, new Date(`${toDate}T12:00:00`)) : undefined
      const createdAt = gte || lte ? { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } : undefined
      const nameFilter = name ? { contains: name, mode: 'insensitive' as const } : undefined

      // `type` is the union of both enums; only apply it to a source where it is a valid member,
      // so e.g. type=SALE returns only product movements and type=USAGE only raw-material ones.
      const productType = type && (Object.values(MovementType) as string[]).includes(type) ? (type as MovementType) : undefined
      const rawType =
        type && (Object.values(RawMaterialMovementType) as string[]).includes(type) ? (type as RawMaterialMovementType) : undefined
      const skipProducts = type !== undefined && productType === undefined
      const skipRaw = type !== undefined && rawType === undefined

      const [productMoves, rawMoves] = await Promise.all([
        skipProducts
          ? []
          : prisma.inventoryMovement.findMany({
              where: {
                inventory: { venueId, ...(nameFilter ? { product: { name: nameFilter } } : {}) },
                ...(productType ? { type: productType } : {}),
                ...(createdAt ? { createdAt } : {}),
              },
              select: {
                type: true,
                quantity: true,
                previousStock: true,
                newStock: true,
                reason: true,
                reference: true,
                createdBy: true,
                createdAt: true,
                inventory: { select: { product: { select: { name: true, sku: true } } } },
              },
              orderBy: { createdAt: 'desc' },
              take,
            }),
        skipRaw
          ? []
          : prisma.rawMaterialMovement.findMany({
              where: {
                venueId,
                ...(nameFilter ? { rawMaterial: { name: nameFilter } } : {}),
                ...(rawType ? { type: rawType } : {}),
                ...(createdAt ? { createdAt } : {}),
              },
              select: {
                type: true,
                quantity: true,
                unit: true,
                previousStock: true,
                newStock: true,
                reason: true,
                reference: true,
                createdBy: true,
                createdAt: true,
                rawMaterial: { select: { name: true, sku: true } },
              },
              orderBy: { createdAt: 'desc' },
              take,
            }),
      ])

      // Resolve every createdBy staffId → "First Last" in one query.
      const staffIds = [...new Set([...productMoves, ...rawMoves].map(m => m.createdBy).filter((id): id is string => !!id))]
      const staff = staffIds.length
        ? await prisma.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, firstName: true, lastName: true } })
        : []
      const staffName = new Map(staff.map(s => [s.id, `${s.firstName} ${s.lastName}`.trim()]))

      const merged = [
        ...productMoves.map(m => ({
          kind: 'product' as const,
          item: m.inventory?.product?.name ?? null,
          sku: m.inventory?.product?.sku ?? null,
          unit: 'unit',
          type: m.type as string,
          quantity: Number(m.quantity), // negative = stock went down
          previousStock: Number(m.previousStock),
          newStock: Number(m.newStock),
          reason: m.reason ?? null,
          reference: m.reference ?? null,
          by: m.createdBy ? (staffName.get(m.createdBy) ?? m.createdBy) : null,
          at: m.createdAt.toISOString(),
        })),
        ...rawMoves.map(m => ({
          kind: 'rawMaterial' as const,
          item: m.rawMaterial?.name ?? null,
          sku: m.rawMaterial?.sku ?? null,
          unit: m.unit as string,
          type: m.type as string,
          quantity: Number(m.quantity), // negative = stock went down
          previousStock: Number(m.previousStock),
          newStock: Number(m.newStock),
          reason: m.reason ?? null,
          reference: m.reference ?? null,
          by: m.createdBy ? (staffName.get(m.createdBy) ?? m.createdBy) : null,
          at: m.createdAt.toISOString(),
        })),
      ]
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)) // newest first
        .slice(0, take)

      // Quick anti-fraud summary: how many manual adjustments and the net hand-applied change.
      const adjustments = merged.filter(m => m.type === 'ADJUSTMENT')
      const netAdjustmentQuantity = round2(adjustments.reduce((sum, m) => sum + m.quantity, 0))

      return text({
        venueId,
        count: merged.length,
        filters: { type: type ?? null, name: name ?? null, fromDate: fromDate ?? null, toDate: toDate ?? null },
        adjustmentCount: adjustments.length,
        netAdjustmentQuantity, // sum of ADJUSTMENT deltas in this window; negative = net hand-removed
        movements: merged,
      })
    },
  )

  server.tool(
    'stock_counts',
    'Physical inventory counts (conteos de existencia) of a venue: each count with its status (IN_PROGRESS/COMPLETED), who created it, when, and every line — QUANTITY products AND raw materials/ingredients (RECIPE products are never counted; their stock derives from ingredients) — with expected vs physically-counted quantity and the variance. Answers "¿cuándo fue el último conteo?", "¿qué diferencias salieron?", "¿qué insumos faltaron contra sistema?". Newest first. Pass venueId. PREMIUM (INVENTORY_TRACKING).',
    {
      venueId: z.string().describe('Venue whose stock counts to read (must be in your scope)'),
      status: z.enum(['IN_PROGRESS', 'COMPLETED']).optional().describe('Only counts in this status. Omit for all.'),
      limit: z.number().int().positive().max(50).optional().describe('Max counts to return (default 10)'),
    },
    async ({ venueId, status, limit }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory:read', venueId)
      const gate = await planGateMessage(venueId, 'INVENTORY_TRACKING', 'El control de inventario')
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      const counts = await prisma.stockCount.findMany({
        where: { venueId, ...(status ? { status } : {}) },
        include: {
          items: {
            include: {
              product: { select: { name: true, sku: true } },
              rawMaterial: { select: { name: true, sku: true, unit: true } },
            },
          },
          createdByUser: { select: { firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit ?? 10,
      })

      return text({
        ok: true,
        counts: counts.map(c => ({
          id: c.id,
          type: c.type,
          status: c.status,
          note: c.note,
          createdAt: c.createdAt.toISOString(),
          completedAt: c.completedAt?.toISOString() ?? null,
          createdBy: c.createdByUser ? `${c.createdByUser.firstName} ${c.createdByUser.lastName}` : null,
          itemCount: c.items.length,
          countedLines: c.items.filter(i => i.countedAt !== null).length,
          items: c.items.map(i => ({
            kind: i.rawMaterialId ? 'INGREDIENT' : 'PRODUCT',
            name: i.product?.name ?? i.rawMaterial?.name ?? '',
            sku: i.product?.sku ?? i.rawMaterial?.sku ?? null,
            unit: i.rawMaterial?.unit ?? null,
            expected: Number(i.expected),
            counted: i.countedAt ? Number(i.counted) : null,
            variance: i.countedAt ? round2(Number(i.counted) - Number(i.expected)) : null,
          })),
        })),
      })
    },
  )

}
