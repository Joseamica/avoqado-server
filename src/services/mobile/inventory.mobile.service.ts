/**
 * Mobile Inventory Service
 *
 * Stock overview and stock count management for iOS/Android apps.
 */

import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { MovementType, RawMaterialMovementType } from '@prisma/client'
import { adjustStock as adjustRawMaterialStock } from '../dashboard/rawMaterial.service'
import { logAction } from '../dashboard/activity-log.service'

// NOTE: When full inventory management is implemented in mobile (iOS/Android),
// all CRUD operations (products, raw materials, recipes, suppliers, POs) must
// include logAction calls matching the dashboard pattern. See:
// - product.dashboard.service.ts (PRODUCT_CREATED/UPDATED/DELETED)
// - rawMaterial.service.ts (RAW_MATERIAL_CREATED/UPDATED/DELETED, STOCK_ADJUSTED)
// - recipe.service.ts (RECIPE_CREATED/UPDATED/DELETED)
// - supplier.service.ts (SUPPLIER_CREATED/UPDATED/DELETED)
// - purchaseOrder.service.ts (PURCHASE_ORDER_* actions)

export interface StockOverviewFilters {
  search?: string
  categoryId?: string
  sortBy?: 'name_asc' | 'name_desc' | 'stock_low' | 'stock_high'
}

/**
 * Get stock overview for a venue - products with inventory tracking enabled.
 */
export async function getStockOverview(venueId: string, page: number, pageSize: number, filters?: StockOverviewFilters) {
  const skip = (page - 1) * pageSize
  const take = pageSize

  const whereClause: any = {
    venueId,
    trackInventory: true,
    active: true,
    deletedAt: null,
  }

  if (filters?.search) {
    const term = filters.search.trim()
    whereClause.OR = [
      { name: { contains: term, mode: 'insensitive' } },
      { sku: { contains: term, mode: 'insensitive' } },
      { gtin: { contains: term, mode: 'insensitive' } },
    ]
  }

  if (filters?.categoryId) {
    whereClause.categoryId = filters.categoryId
  }

  // Determine ordering
  let orderBy: any = { name: 'asc' }
  if (filters?.sortBy === 'name_desc') orderBy = { name: 'desc' }
  // stock_low/stock_high will be sorted after query since stock is in a relation

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where: whereClause,
      include: {
        inventory: true,
        category: { select: { id: true, name: true } },
      },
      orderBy,
      skip,
      take,
    }),
    prisma.product.count({ where: whereClause }),
  ])

  const items = products.map(p => {
    const inv = p.inventory
    const currentStock = inv ? Number(inv.currentStock) : 0
    const reservedStock = inv ? Number(inv.reservedStock) : 0
    return {
      id: p.id,
      name: p.name,
      sku: p.sku,
      gtin: p.gtin,
      imageUrl: p.imageUrl,
      categoryName: p.category?.name ?? null,
      unit: p.unit,
      onHand: currentStock,
      available: currentStock - reservedStock,
      onOrder: 0, // TODO: implement purchase orders
    }
  })

  // Sort by stock if requested
  if (filters?.sortBy === 'stock_low') {
    items.sort((a, b) => a.onHand - b.onHand)
  } else if (filters?.sortBy === 'stock_high') {
    items.sort((a, b) => b.onHand - a.onHand)
  }

  return {
    items,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  }
}

/**
 * Get stock counts for a venue.
 */
export async function getStockCounts(venueId: string) {
  const counts = await prisma.stockCount.findMany({
    where: { venueId },
    include: {
      items: {
        include: {
          product: { select: { id: true, name: true, sku: true, gtin: true, imageUrl: true } },
          rawMaterial: { select: { id: true, name: true, sku: true, gtin: true, unit: true } },
        },
      },
      createdByUser: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  return counts.map(c => ({
    id: c.id,
    type: c.type,
    status: c.status,
    note: c.note,
    createdAt: c.createdAt.toISOString(),
    createdBy: c.createdByUser ? `${c.createdByUser.firstName} ${c.createdByUser.lastName}` : null,
    itemCount: c.items.length,
    items: c.items.map(mapCountItem),
  }))
}

/**
 * Map a StockCountItem (product OR raw-material line) to the wire shape.
 * Compat: `productId` falls back to the raw material id so pre-ingredient
 * app versions (which decode it as non-optional) keep parsing; they can
 * still count the line because updates go by item.id. New clients switch
 * on `itemType` / `rawMaterialId`.
 */
function mapCountItem(item: {
  id: string
  productId: string | null
  rawMaterialId: string | null
  expected: unknown
  counted: unknown
  product: { name: string; sku: string | null; gtin: string | null; imageUrl: string | null } | null
  rawMaterial: { name: string; sku: string | null; gtin: string | null; unit: string } | null
}) {
  return {
    id: item.id,
    productId: item.productId ?? item.rawMaterialId,
    rawMaterialId: item.rawMaterialId,
    itemType: item.rawMaterialId ? 'RAW_MATERIAL' : 'PRODUCT',
    productName: item.product?.name ?? item.rawMaterial?.name ?? '',
    sku: item.product?.sku ?? item.rawMaterial?.sku ?? null,
    gtin: item.product?.gtin ?? item.rawMaterial?.gtin ?? null,
    imageUrl: item.product?.imageUrl ?? null,
    unit: item.rawMaterial?.unit ?? null,
    expected: Number(item.expected),
    counted: Number(item.counted),
    difference: Number(item.counted) - Number(item.expected),
  }
}

/**
 * Create a new stock count.
 */
export async function createStockCount(
  venueId: string,
  userId: string,
  type: 'CYCLE' | 'FULL',
  productIds?: string[],
  // Opt-in (additive): only clients that understand ingredient lines send
  // these — old app versions keep getting product-only counts.
  includeRawMaterials?: boolean,
  rawMaterialIds?: string[],
) {
  // For FULL count, get all products with inventory tracking
  let productsToCount: { id: string; currentStock: number }[] = []
  let rawMaterialsToCount: { id: string; currentStock: number }[] = []

  if (type === 'FULL') {
    // RECIPE products are excluded: their stock derives from ingredient
    // consumption, so physically counting the finished product is meaningless
    // (Square Recipes parity: counts cover QUANTITY products + ingredients).
    const products = await prisma.product.findMany({
      where: { venueId, trackInventory: true, active: true, deletedAt: null, inventoryMethod: { not: 'RECIPE' } },
      include: { inventory: true },
    })
    productsToCount = products.map(p => ({
      id: p.id,
      currentStock: p.inventory ? Number(p.inventory.currentStock) : 0,
    }))

    if (includeRawMaterials) {
      const rawMaterials = await prisma.rawMaterial.findMany({
        where: { venueId, active: true, deletedAt: null },
        select: { id: true, currentStock: true },
      })
      rawMaterialsToCount = rawMaterials.map(rm => ({ id: rm.id, currentStock: Number(rm.currentStock) }))
    }
  } else {
    if (productIds && productIds.length > 0) {
      const products = await prisma.product.findMany({
        where: { id: { in: productIds }, venueId, active: true, deletedAt: null, inventoryMethod: { not: 'RECIPE' } },
        include: { inventory: true },
      })
      productsToCount = products.map(p => ({
        id: p.id,
        currentStock: p.inventory ? Number(p.inventory.currentStock) : 0,
      }))
    }
    if (rawMaterialIds && rawMaterialIds.length > 0) {
      const rawMaterials = await prisma.rawMaterial.findMany({
        where: { id: { in: rawMaterialIds }, venueId, active: true, deletedAt: null },
        select: { id: true, currentStock: true },
      })
      rawMaterialsToCount = rawMaterials.map(rm => ({ id: rm.id, currentStock: Number(rm.currentStock) }))
    }
  }

  const count = await prisma.stockCount.create({
    data: {
      venueId,
      type,
      status: 'IN_PROGRESS',
      createdById: userId,
      items: {
        create: [
          ...productsToCount.map(p => ({
            productId: p.id,
            expected: p.currentStock,
            counted: 0,
          })),
          ...rawMaterialsToCount.map(rm => ({
            rawMaterialId: rm.id,
            expected: rm.currentStock,
            counted: 0,
          })),
        ],
      },
    },
    include: {
      items: {
        include: {
          product: { select: { id: true, name: true, sku: true, gtin: true, imageUrl: true } },
          rawMaterial: { select: { id: true, name: true, sku: true, gtin: true, unit: true } },
        },
      },
    },
  })

  logAction({
    staffId: userId,
    venueId,
    action: 'STOCK_COUNT_CREATED',
    entity: 'StockCount',
    entityId: count.id,
    data: { type, itemCount: count.items.length, rawMaterialCount: rawMaterialsToCount.length, source: 'MOBILE' },
  })

  return {
    id: count.id,
    type: count.type,
    status: count.status,
    note: count.note,
    createdAt: count.createdAt.toISOString(),
    createdBy: null,
    itemCount: count.items.length,
    items: count.items.map(mapCountItem),
  }
}

/**
 * Update stock count items (set counted quantities).
 */
export async function updateStockCount(countId: string, venueId: string, items: { id: string; counted: number }[], note?: string) {
  const count = await prisma.stockCount.findFirst({
    where: { id: countId, venueId, status: 'IN_PROGRESS' },
  })

  if (!count) {
    throw new NotFoundError('Conteo no encontrado o ya completado')
  }

  // Update each item's counted quantity
  await Promise.all(
    items.map(item =>
      prisma.stockCountItem.update({
        where: { id: item.id },
        data: { counted: item.counted, countedAt: new Date() },
      }),
    ),
  )

  // Optionally update note
  if (note !== undefined) {
    await prisma.stockCount.update({
      where: { id: countId },
      data: { note },
    })
  }

  return { success: true }
}

/**
 * Confirm a stock count - applies inventory adjustments.
 */
export async function confirmStockCount(countId: string, venueId: string, userId: string) {
  const count = await prisma.stockCount.findFirst({
    where: { id: countId, venueId, status: 'IN_PROGRESS' },
    include: {
      items: {
        include: {
          product: { include: { inventory: true } },
          rawMaterial: { select: { id: true, name: true, currentStock: true, unit: true } },
        },
      },
    },
  })

  if (!count) {
    throw new NotFoundError('Conteo no encontrado o ya completado')
  }

  // Only lines the cashier actually counted are applied: an untouched line
  // sits at the default counted=0, and applying it would zero out real stock
  // (this bit the E2E test — 46 untouched ingredients started wiping stock).
  const countedItems = count.items.filter(item => item.countedAt !== null)

  // Ingredient lines: the physical count is the truth, so compute the delta
  // against the CURRENT stock (not `expected`, which may be stale if sales
  // happened mid-count) and delegate to adjustStock — it handles FIFO batch
  // deduction/creation, the COUNT movement and low-stock alerts. Seed/legacy
  // ingredients may have stock but NO active batches, where FIFO deduction
  // throws — fall back to a direct set + COUNT movement (no batch link).
  const ingredientFailures: { rawMaterialId: string; name: string; error: string }[] = []
  for (const item of countedItems) {
    if (!item.rawMaterialId || !item.rawMaterial) continue
    const current = Number(item.rawMaterial.currentStock)
    const counted = Number(item.counted)
    const delta = counted - current
    try {
      await adjustRawMaterialStock(
        venueId,
        item.rawMaterialId,
        { quantity: delta, type: RawMaterialMovementType.COUNT, reason: `Conteo de inventario #${countId}` },
        userId,
      )
    } catch {
      try {
        await prisma.$transaction([
          prisma.rawMaterial.update({
            where: { id: item.rawMaterialId },
            data: { currentStock: counted, lastCountAt: new Date() },
          }),
          prisma.rawMaterialMovement.create({
            data: {
              rawMaterialId: item.rawMaterialId,
              venueId,
              type: RawMaterialMovementType.COUNT,
              quantity: delta,
              unit: (item.rawMaterial as any).unit ?? 'PIECE',
              previousStock: current,
              newStock: counted,
              reason: `Conteo de inventario #${countId} (ajuste directo, sin lotes)`,
              createdBy: userId,
            },
          }),
        ])
      } catch (fallbackError) {
        ingredientFailures.push({
          rawMaterialId: item.rawMaterialId,
          name: (item.rawMaterial as any).name ?? item.rawMaterialId,
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        })
      }
    }
  }

  if (ingredientFailures.length > 0) {
    // Leave the count IN_PROGRESS so the cashier can retry; already-applied
    // lines are safe to re-confirm (delta is computed against CURRENT stock).
    throw new Error(`No se pudo ajustar ${ingredientFailures.length} insumo(s): ${ingredientFailures.map(f => f.name).join(', ')}`)
  }

  // Apply adjustments for each product item
  for (const item of countedItems) {
    if (!item.product) continue
    const difference = Number(item.counted) - Number(item.expected)
    if (difference === 0) continue

    const inventory = item.product.inventory
    if (!inventory) continue

    const previousStock = Number(inventory.currentStock)
    const newStock = Number(item.counted)

    await prisma.$transaction([
      prisma.inventory.update({
        where: { id: inventory.id },
        data: {
          currentStock: newStock,
          lastCountedAt: new Date(),
        },
      }),
      prisma.inventoryMovement.create({
        data: {
          inventoryId: inventory.id,
          type: MovementType.COUNT,
          quantity: difference,
          previousStock,
          newStock,
          reason: `Conteo de inventario #${countId}`,
          createdBy: userId,
        },
      }),
    ])
  }

  // Mark count as completed
  await prisma.stockCount.update({
    where: { id: countId },
    data: { status: 'COMPLETED', completedAt: new Date() },
  })

  // Log adjustments applied
  const adjustments = count.items
    .filter(item => Number(item.counted) - Number(item.expected) !== 0)
    .map(item => ({
      productId: item.productId ?? item.rawMaterialId,
      productName: (item.product as any)?.name ?? (item.rawMaterial as any)?.name ?? item.productId,
      expected: Number(item.expected),
      counted: Number(item.counted),
      difference: Number(item.counted) - Number(item.expected),
    }))

  logAction({
    staffId: userId,
    venueId,
    action: 'STOCK_COUNT_CONFIRMED',
    entity: 'StockCount',
    entityId: countId,
    data: { adjustmentsCount: adjustments.length, adjustments, source: 'MOBILE' },
  })

  return { success: true }
}
