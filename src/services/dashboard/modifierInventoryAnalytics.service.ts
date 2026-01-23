/**
 * Modifier Inventory Analytics Service
 *
 * Provides analytics for modifier inventory usage, cost tracking, and low stock alerts.
 * Implements Toast/Square pattern for comprehensive modifier inventory management.
 */

import { Prisma, ModifierInventoryMode } from '@prisma/client'
import prisma from '../../utils/prismaClient'

export interface ModifierUsageStats {
  modifierId: string
  modifierName: string
  groupId: string
  groupName: string
  timesUsed: number
  totalQuantityUsed: number
  totalCostImpact: number
  rawMaterial?: {
    id: string
    name: string
    unit: string
    currentStock: number
    costPerUnit: number
  }
  inventoryMode: ModifierInventoryMode | null
  quantityPerUnit: number | null
}

export interface ModifierLowStockItem {
  modifierId: string
  modifierName: string
  groupId: string
  groupName: string
  rawMaterialId: string
  rawMaterialName: string
  unit: string
  currentStock: number
  reorderPoint: number
  quantityPerUnit: number
  estimatedUsesRemaining: number
  inventoryMode: ModifierInventoryMode
}

export interface ModifierInventorySummary {
  totalModifiersWithInventory: number
  totalModifiersLowStock: number
  totalCostImpactPeriod: number
  topCostModifiers: ModifierUsageStats[]
  lowStockModifiers: ModifierLowStockItem[]
}

/**
 * Get modifier usage statistics for a venue within a date range
 */
export async function getModifierUsageStats(
  venueId: string,
  options?: {
    startDate?: Date
    endDate?: Date
    modifierGroupId?: string
    limit?: number
  },
): Promise<ModifierUsageStats[]> {
  const { startDate, endDate, modifierGroupId, limit = 50 } = options || {}

  // Build date filter for orders
  const createdAtFilter: Prisma.DateTimeFilter | undefined =
    startDate || endDate
      ? {
          ...(startDate && { gte: startDate }),
          ...(endDate && { lte: endDate }),
        }
      : undefined

  const orderDateFilter: Prisma.OrderWhereInput = {
    venueId,
    status: 'COMPLETED',
    ...(createdAtFilter && { createdAt: createdAtFilter }),
  }

  // Get all modifier usages with their order items
  const modifierUsages = await prisma.orderItemModifier.findMany({
    where: {
      orderItem: {
        order: orderDateFilter,
      },
      ...(modifierGroupId && {
        modifier: {
          groupId: modifierGroupId,
        },
      }),
    },
    include: {
      modifier: {
        include: {
          group: {
            select: { id: true, name: true },
          },
          rawMaterial: {
            select: {
              id: true,
              name: true,
              unit: true,
              currentStock: true,
              costPerUnit: true,
            },
          },
        },
      },
      orderItem: {
        select: { quantity: true },
      },
    },
  })

  // Aggregate usage by modifier
  const usageMap = new Map<string, ModifierUsageStats>()

  for (const usage of modifierUsages) {
    // Skip if modifier was deleted (Toast/Square pattern - denormalized data preserves history)
    if (!usage.modifier) continue

    const mod = usage.modifier
    const existing = usageMap.get(mod.id)

    const orderItemQty = usage.orderItem.quantity
    const modifierQty = usage.quantity
    const totalQtyUsed = orderItemQty * modifierQty

    // Calculate cost impact if raw material is linked
    let costImpact = 0
    if (mod.rawMaterial && mod.quantityPerUnit) {
      const qtyPerUnit = parseFloat(mod.quantityPerUnit.toString())
      const costPerUnit = parseFloat(mod.rawMaterial.costPerUnit.toString())
      costImpact = totalQtyUsed * qtyPerUnit * costPerUnit
    }

    if (existing) {
      existing.timesUsed += 1
      existing.totalQuantityUsed += totalQtyUsed
      existing.totalCostImpact += costImpact
    } else {
      usageMap.set(mod.id, {
        modifierId: mod.id,
        modifierName: mod.name,
        groupId: mod.group.id,
        groupName: mod.group.name,
        timesUsed: 1,
        totalQuantityUsed: totalQtyUsed,
        totalCostImpact: costImpact,
        rawMaterial: mod.rawMaterial
          ? {
              id: mod.rawMaterial.id,
              name: mod.rawMaterial.name,
              unit: mod.rawMaterial.unit,
              currentStock: parseFloat(mod.rawMaterial.currentStock.toString()),
              costPerUnit: parseFloat(mod.rawMaterial.costPerUnit.toString()),
            }
          : undefined,
        inventoryMode: mod.inventoryMode,
        quantityPerUnit: mod.quantityPerUnit ? parseFloat(mod.quantityPerUnit.toString()) : null,
      })
    }
  }

  // Sort by times used and apply limit
  const stats = Array.from(usageMap.values())
    .sort((a, b) => b.timesUsed - a.timesUsed)
    .slice(0, limit)

  return stats
}

/**
 * Get modifiers with low stock based on their linked raw materials
 */
export async function getModifiersLowStock(venueId: string): Promise<ModifierLowStockItem[]> {
  // Get all modifiers with inventory tracking that have low stock raw materials
  const _modifiers = await prisma.modifier.findMany({
    where: {
      group: { venueId },
      rawMaterialId: { not: null },
      rawMaterial: {
        // Raw material stock is at or below reorder point
        currentStock: {
          lte: prisma.rawMaterial.fields.reorderPoint,
        },
      },
    },
    include: {
      group: {
        select: { id: true, name: true },
      },
      rawMaterial: {
        select: {
          id: true,
          name: true,
          unit: true,
          currentStock: true,
          reorderPoint: true,
        },
      },
    },
  })

  // Alternative: Use raw SQL for the comparison
  const lowStockModifiers = await prisma.$queryRaw<
    Array<{
      modifierId: string
      modifierName: string
      groupId: string
      groupName: string
      rawMaterialId: string
      rawMaterialName: string
      unit: string
      currentStock: number
      reorderPoint: number
      quantityPerUnit: number
      inventoryMode: ModifierInventoryMode
    }>
  >`
    SELECT
      m.id as "modifierId",
      m.name as "modifierName",
      mg.id as "groupId",
      mg.name as "groupName",
      rm.id as "rawMaterialId",
      rm.name as "rawMaterialName",
      rm.unit,
      rm."currentStock"::float as "currentStock",
      rm."reorderPoint"::float as "reorderPoint",
      COALESCE(m."quantityPerUnit"::float, 0) as "quantityPerUnit",
      m."inventoryMode"
    FROM "Modifier" m
    JOIN "ModifierGroup" mg ON m."groupId" = mg.id
    JOIN "RawMaterial" rm ON m."rawMaterialId" = rm.id
    WHERE mg."venueId" = ${venueId}
      AND rm."currentStock" <= rm."reorderPoint"
    ORDER BY (rm."currentStock" / NULLIF(rm."reorderPoint", 0)) ASC
  `

  return lowStockModifiers.map(mod => ({
    ...mod,
    estimatedUsesRemaining: mod.quantityPerUnit > 0 ? Math.floor(mod.currentStock / mod.quantityPerUnit) : 0,
  }))
}

/**
 * Get comprehensive modifier inventory summary
 */
export async function getModifierInventorySummary(
  venueId: string,
  options?: {
    startDate?: Date
    endDate?: Date
  },
): Promise<ModifierInventorySummary> {
  const { startDate, endDate } = options || {}

  // Count modifiers with inventory tracking
  const totalModifiersWithInventory = await prisma.modifier.count({
    where: {
      group: { venueId },
      rawMaterialId: { not: null },
    },
  })

  // Get low stock modifiers
  const lowStockModifiers = await getModifiersLowStock(venueId)

  // Get usage stats for cost calculation
  const usageStats = await getModifierUsageStats(venueId, {
    startDate,
    endDate,
    limit: 100,
  })

  // Calculate total cost impact
  const totalCostImpactPeriod = usageStats.reduce((sum, stat) => sum + stat.totalCostImpact, 0)

  // Get top cost modifiers (sorted by cost impact)
  const topCostModifiers = [...usageStats].sort((a, b) => b.totalCostImpact - a.totalCostImpact).slice(0, 10)

  return {
    totalModifiersWithInventory,
    totalModifiersLowStock: lowStockModifiers.length,
    totalCostImpactPeriod,
    topCostModifiers,
    lowStockModifiers,
  }
}

/**
 * Get all modifiers with their inventory configuration for a venue
 */
export async function getModifiersWithInventory(
  venueId: string,
  options?: {
    includeInactive?: boolean
    groupId?: string
  },
): Promise<
  Array<{
    id: string
    name: string
    groupId: string
    groupName: string
    rawMaterialId: string | null
    rawMaterialName: string | null
    quantityPerUnit: number | null
    unit: string | null
    inventoryMode: ModifierInventoryMode
    cost: number | null
    currentStock: number | null
    active: boolean
  }>
> {
  const { includeInactive = false, groupId } = options || {}

  const modifiers = await prisma.modifier.findMany({
    where: {
      group: {
        venueId,
        ...(groupId && { id: groupId }),
      },
      ...(includeInactive ? {} : { active: true }),
    },
    include: {
      group: {
        select: { id: true, name: true },
      },
      rawMaterial: {
        select: {
          id: true,
          name: true,
          unit: true,
          currentStock: true,
        },
      },
    },
    orderBy: [{ group: { displayOrder: 'asc' } }, { name: 'asc' }],
  })

  return modifiers.map(mod => ({
    id: mod.id,
    name: mod.name,
    groupId: mod.group.id,
    groupName: mod.group.name,
    rawMaterialId: mod.rawMaterialId,
    rawMaterialName: mod.rawMaterial?.name || null,
    quantityPerUnit: mod.quantityPerUnit ? parseFloat(mod.quantityPerUnit.toString()) : null,
    unit: mod.unit,
    inventoryMode: mod.inventoryMode,
    cost: mod.cost ? parseFloat(mod.cost.toString()) : null,
    currentStock: mod.rawMaterial ? parseFloat(mod.rawMaterial.currentStock.toString()) : null,
    active: mod.active,
  }))
}
