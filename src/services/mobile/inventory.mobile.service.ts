/**
 * Mobile Inventory Service
 *
 * Stock overview and stock count management for iOS/Android apps.
 */

import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { MovementType } from '@prisma/client'

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
    items: c.items.map(item => ({
      id: item.id,
      productId: item.productId,
      productName: item.product.name,
      sku: item.product.sku,
      gtin: item.product.gtin,
      imageUrl: item.product.imageUrl,
      expected: Number(item.expected),
      counted: Number(item.counted),
      difference: Number(item.counted) - Number(item.expected),
    })),
  }))
}

/**
 * Create a new stock count.
 */
export async function createStockCount(venueId: string, userId: string, type: 'CYCLE' | 'FULL', productIds?: string[]) {
  // For FULL count, get all products with inventory tracking
  let productsToCount: { id: string; currentStock: number }[] = []

  if (type === 'FULL') {
    const products = await prisma.product.findMany({
      where: { venueId, trackInventory: true, active: true, deletedAt: null },
      include: { inventory: true },
    })
    productsToCount = products.map(p => ({
      id: p.id,
      currentStock: p.inventory ? Number(p.inventory.currentStock) : 0,
    }))
  } else if (productIds && productIds.length > 0) {
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, venueId, active: true, deletedAt: null },
      include: { inventory: true },
    })
    productsToCount = products.map(p => ({
      id: p.id,
      currentStock: p.inventory ? Number(p.inventory.currentStock) : 0,
    }))
  }

  const count = await prisma.stockCount.create({
    data: {
      venueId,
      type,
      status: 'IN_PROGRESS',
      createdById: userId,
      items: {
        create: productsToCount.map(p => ({
          productId: p.id,
          expected: p.currentStock,
          counted: 0,
        })),
      },
    },
    include: {
      items: {
        include: {
          product: { select: { id: true, name: true, sku: true, gtin: true, imageUrl: true } },
        },
      },
    },
  })

  return {
    id: count.id,
    type: count.type,
    status: count.status,
    note: count.note,
    createdAt: count.createdAt.toISOString(),
    createdBy: null,
    itemCount: count.items.length,
    items: count.items.map(item => ({
      id: item.id,
      productId: item.productId,
      productName: item.product.name,
      sku: item.product.sku,
      gtin: item.product.gtin,
      imageUrl: item.product.imageUrl,
      expected: Number(item.expected),
      counted: Number(item.counted),
      difference: 0,
    })),
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
        data: { counted: item.counted },
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
        },
      },
    },
  })

  if (!count) {
    throw new NotFoundError('Conteo no encontrado o ya completado')
  }

  // Apply adjustments for each item
  for (const item of count.items) {
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

  return { success: true }
}
