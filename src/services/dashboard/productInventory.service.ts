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
  await prisma.$transaction([
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
        createdBy: staffId,
      },
    }),
  ])

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
