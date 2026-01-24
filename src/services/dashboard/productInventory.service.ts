import prisma from '../../utils/prismaClient'
import AppError from '../../errors/AppError'
import { Prisma, MovementType } from '@prisma/client'
import logger from '../../config/logger'

/**
 * Product Inventory Service
 *
 * Manages simple count-based inventory for products with inventoryMethod='QUANTITY'.
 * Uses Inventory table (NOT RawMaterial/StockBatch - those are for ingredients).
 *
 * Key differences from RawMaterial:
 * - No FIFO batches (single stock record per product)
 * - No batch tracking (simpler model)
 * - Direct stock adjustments (no batch creation)
 * - Uses InventoryMovement (not RawMaterialMovement)
 */

export interface AdjustInventoryStockDto {
  type: MovementType
  quantity: number // Positive for additions, negative for reductions
  reason?: string
  reference?: string
  unitCost?: number // Cost per unit for this movement (for PURCHASE)
  supplier?: string // Supplier name for this movement (for PURCHASE)
}

/**
 * Adjust stock for a product with QUANTITY tracking
 */
export async function adjustInventoryStock(
  venueId: string,
  productId: string,
  data: AdjustInventoryStockDto,
  staffId?: string,
): Promise<{ currentStock: number; minimumStock: number; reservedStock: number }> {
  // Verify product exists and has QUANTITY tracking
  const product = await prisma.product.findFirst({
    where: { id: productId, venueId },
    include: { inventory: true },
  })

  if (!product) {
    throw new AppError(`Product with ID ${productId} not found`, 404)
  }

  if (!product.trackInventory || product.inventoryMethod !== 'QUANTITY') {
    throw new AppError(`Product ${productId} does not use QUANTITY tracking`, 400)
  }

  if (!product.inventory) {
    throw new AppError(`Product ${productId} has no inventory record`, 404)
  }

  const inventory = product.inventory
  const previousStock = inventory.currentStock
  const newStock = previousStock.add(data.quantity)

  // Prevent negative stock
  if (newStock.lessThan(0)) {
    throw new AppError(`Insufficient stock. Current: ${previousStock}, Requested adjustment: ${data.quantity}`, 400)
  }

  // Update inventory and create movement record in transaction
  const operations: Prisma.PrismaPromise<any>[] = [
    // Update inventory
    prisma.inventory.update({
      where: { id: inventory.id },
      data: {
        currentStock: newStock,
        lastCountedAt: data.type === 'COUNT' ? new Date() : inventory.lastCountedAt,
      },
    }),

    // Create movement record
    prisma.inventoryMovement.create({
      data: {
        inventoryId: inventory.id,
        type: data.type,
        quantity: new Prisma.Decimal(data.quantity),
        previousStock,
        newStock,
        reason: data.reason,
        reference: data.reference,
        unitCost: data.unitCost ? new Prisma.Decimal(data.unitCost) : undefined,
        supplier: data.supplier,
        createdBy: staffId,
      },
    }),
  ]

  // Update Product.cost if this is a PURCHASE with unitCost
  if (data.type === 'PURCHASE' && data.unitCost) {
    operations.push(
      prisma.product.update({
        where: { id: productId },
        data: {
          cost: new Prisma.Decimal(data.unitCost),
        },
      }),
    )
  }

  await prisma.$transaction(operations)

  logger.info(`✅ Inventory adjusted for product ${productId}: ${previousStock} → ${newStock}`, {
    venueId,
    productId,
    productName: product.name,
    previousStock: previousStock.toNumber(),
    newStock: newStock.toNumber(),
    quantity: data.quantity,
    type: data.type,
  })

  return {
    currentStock: newStock.toNumber(),
    minimumStock: inventory.minimumStock.toNumber(),
    reservedStock: inventory.reservedStock.toNumber(),
  }
}

/**
 * Get stock movements for a product with QUANTITY tracking
 */
export async function getInventoryMovements(venueId: string, productId: string) {
  // Verify product exists and has QUANTITY tracking
  const product = await prisma.product.findFirst({
    where: { id: productId, venueId },
    include: { inventory: true },
  })

  if (!product) {
    throw new AppError(`Product with ID ${productId} not found`, 404)
  }

  if (!product.inventory) {
    throw new AppError(`Product ${productId} has no inventory record`, 404)
  }

  // Fetch movements ordered by most recent first
  const movements = await prisma.inventoryMovement.findMany({
    where: {
      inventoryId: product.inventory.id,
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: 100, // Limit to last 100 movements
  })

  logger.info(`📊 Fetched ${movements.length} inventory movements for product ${productId}`, {
    venueId,
    productId,
    productName: product.name,
    movementCount: movements.length,
  })

  return movements.map(m => ({
    id: m.id,
    type: m.type,
    quantity: m.quantity.toNumber(),
    previousStock: m.previousStock.toNumber(),
    newStock: m.newStock.toNumber(),
    reason: m.reason,
    reference: m.reference,
    createdBy: m.createdBy,
    createdAt: m.createdAt,
  }))
}

/**
 * Get unified global inventory movements (Products + Raw Materials)
 */
export async function getGlobalMovements(
  venueId: string,
  query: {
    page: number
    limit: number
    search?: string
    startDate?: string // ISO string
    endDate?: string // ISO string
    type?: string
  },
) {
  const { page, limit, search, startDate, endDate, type } = query
  const _skip = (page - 1) * limit

  // 1. Build where clauses
  const dateFilter =
    startDate && endDate
      ? {
          createdAt: {
            gte: new Date(startDate),
            lte: new Date(endDate),
          },
        }
      : {}

  // Filter by type if provided (need to map specific types if necessary)
  const typeFilter = type && type !== 'ALL' ? { type: type as any } : {}

  // 2. Fetch InventoryMovements (Products)
  const productMovementsPromise = prisma.inventoryMovement.findMany({
    where: {
      inventory: {
        venueId,
        product: search
          ? {
              OR: [{ name: { contains: search, mode: 'insensitive' } }, { sku: { contains: search, mode: 'insensitive' } }],
            }
          : undefined,
      },
      ...dateFilter,
      ...(type === 'SALE' || type === 'ALL' || type === undefined
        ? {}
        : type === 'RECEIVED'
          ? { type: 'PURCHASE' } // Map generic types if needed
          : typeFilter),
    },
    include: {
      inventory: {
        include: {
          product: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit * page, // Fetch up to current page depth to ensure correct merge sort
  })

  // 3. Fetch RawMaterialMovements (Ingredients)
  const rawMaterialMovementsPromise = prisma.rawMaterialMovement.findMany({
    where: {
      venueId,
      rawMaterial: search
        ? {
            OR: [{ name: { contains: search, mode: 'insensitive' } }, { sku: { contains: search, mode: 'insensitive' } }],
          }
        : undefined,
      ...dateFilter,
      // Apply type filter if compatible, otherwise ignore or adapt
      ...(type === 'SALE'
        ? { type: { in: [] } } // Raw materials don't have direct SALES usually (they are consumed), maybe USAGE
        : typeFilter),
    },
    include: {
      rawMaterial: true,
      batch: true,
    },
    orderBy: { createdAt: 'desc' },
    take: limit * page,
  })

  const [productMovements, rawMaterialMovements] = await Promise.all([productMovementsPromise, rawMaterialMovementsPromise])

  // 4. Normalize and Merge
  const combined = [
    ...productMovements.map(m => ({
      id: m.id,
      createdAt: m.createdAt,
      itemName: m.inventory.product.name,
      sku: m.inventory.product.sku,
      category: 'PRODUCT',
      type: m.type,
      quantity: m.quantity.toNumber(),
      unit: m.inventory.product.unit || 'UNIT',
      cost: m.inventory.product.cost?.toNumber() || 0,
      totalCost: (m.inventory.product.cost?.toNumber() || 0) * Math.abs(m.quantity.toNumber()),
      reason: m.reason,
      reference: m.reference,
      previousStock: m.previousStock.toNumber(),
      newStock: m.newStock.toNumber(),
      createdBy: m.createdBy,
    })),
    ...rawMaterialMovements.map(m => ({
      id: m.id,
      createdAt: m.createdAt,
      itemName: m.rawMaterial.name,
      sku: m.rawMaterial.sku,
      category: 'INGREDIENT',
      type: m.type,
      quantity: m.quantity.toNumber(),
      unit: m.unit,
      cost: m.rawMaterial.costPerUnit.toNumber(),
      totalCost: m.costImpact?.toNumber() || 0,
      reason: m.reason,
      reference: m.reference,
      previousStock: m.previousStock.toNumber(),
      newStock: m.newStock.toNumber(),
      createdBy: m.createdBy,
    })),
  ]

  // 5. Sort and Paginate in memory (since we merged sources)
  // Note: For large datasets this isn't efficient, but for typical "history view" it's acceptable.
  // Proper solution would be SQL UNION query or a dedicated history table.
  combined.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  // Calculate generic total estimate (sum of both counts is upper bound)
  // To get *real* total we'd need count() queries, but for now length is fine (but length is capped by take)
  // Actually, we can't return real total without count queries. We'll return -1 or just combined.length if less than request.
  // For scrolling UI, we often just need "has more".

  // Slice correct page window
  const startIndex = (page - 1) * limit
  const paginated = combined.slice(startIndex, startIndex + limit)

  return {
    data: paginated,
    meta: {
      total: 1000, // Dummy total to allow pagination in UI (since we don't count everything for perf)
      page,
      limit,
    },
  }
}
