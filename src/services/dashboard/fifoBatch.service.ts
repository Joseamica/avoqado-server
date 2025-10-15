import { Prisma, BatchStatus, RawMaterialMovementType, Unit } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import AppError from '../../errors/AppError'
import { Decimal } from '@prisma/client/runtime/library'

/**
 * Generate unique batch number for a raw material
 * Format: BATCH-YYYYMMDD-XXX
 */
async function generateBatchNumber(venueId: string, rawMaterialId: string): Promise<string> {
  const today = new Date()
  const datePrefix = `BATCH-${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`

  const lastBatch = await prisma.stockBatch.findFirst({
    where: {
      venueId,
      rawMaterialId,
      batchNumber: {
        startsWith: datePrefix,
      },
    },
    orderBy: {
      batchNumber: 'desc',
    },
  })

  if (!lastBatch) {
    return `${datePrefix}-001`
  }

  const lastSequence = parseInt(lastBatch.batchNumber.split('-')[3])
  const nextSequence = String(lastSequence + 1).padStart(3, '0')
  return `${datePrefix}-${nextSequence}`
}

/**
 * Create a new stock batch (typically when receiving a purchase order)
 */
export async function createStockBatch(
  venueId: string,
  rawMaterialId: string,
  data: {
    purchaseOrderItemId?: string
    quantity: number
    unit: Unit
    costPerUnit: number
    receivedDate: Date
    expirationDate?: Date
  },
): Promise<any> {
  // Verify raw material exists
  const rawMaterial = await prisma.rawMaterial.findFirst({
    where: {
      id: rawMaterialId,
      venueId,
    },
  })

  if (!rawMaterial) {
    throw new AppError(`Raw material with ID ${rawMaterialId} not found`, 404)
  }

  // Generate unique batch number
  const batchNumber = await generateBatchNumber(venueId, rawMaterialId)

  // Create batch
  const batch = await prisma.stockBatch.create({
    data: {
      venueId,
      rawMaterialId,
      purchaseOrderItemId: data.purchaseOrderItemId,
      batchNumber,
      initialQuantity: new Decimal(data.quantity),
      remainingQuantity: new Decimal(data.quantity),
      unit: data.unit,
      costPerUnit: new Decimal(data.costPerUnit),
      receivedDate: data.receivedDate,
      expirationDate: data.expirationDate,
      status: BatchStatus.ACTIVE,
    },
    include: {
      rawMaterial: {
        select: {
          id: true,
          name: true,
          sku: true,
          unit: true,
        },
      },
      purchaseOrderItem: {
        select: {
          id: true,
          purchaseOrder: {
            select: {
              orderNumber: true,
            },
          },
        },
      },
    },
  })

  return batch
}

/**
 * Get active batches for a raw material ordered by FIFO (oldest first)
 */
export async function getActiveBatchesFIFO(venueId: string, rawMaterialId: string): Promise<any[]> {
  const batches = await prisma.stockBatch.findMany({
    where: {
      venueId,
      rawMaterialId,
      status: BatchStatus.ACTIVE,
      remainingQuantity: {
        gt: 0,
      },
    },
    orderBy: {
      receivedDate: 'asc', // FIFO: oldest first
    },
    include: {
      rawMaterial: {
        select: {
          id: true,
          name: true,
          sku: true,
          unit: true,
        },
      },
    },
  })

  return batches
}

/**
 * Allocate quantity from batches using FIFO method
 * Returns array of { batch, quantityToDeduct, costImpact }
 */
export async function allocateStockFIFO(
  venueId: string,
  rawMaterialId: string,
  quantityNeeded: number,
): Promise<
  Array<{
    batchId: string
    batchNumber: string
    quantityToDeduct: Decimal
    costImpact: Decimal
    remainingAfter: Decimal
  }>
> {
  const batches = await getActiveBatchesFIFO(venueId, rawMaterialId)

  if (batches.length === 0) {
    throw new AppError(`No active batches available for raw material ${rawMaterialId}`, 400)
  }

  const allocations: Array<{
    batchId: string
    batchNumber: string
    quantityToDeduct: Decimal
    costImpact: Decimal
    remainingAfter: Decimal
  }> = []

  let remainingToAllocate = new Decimal(quantityNeeded)

  for (const batch of batches) {
    if (remainingToAllocate.lessThanOrEqualTo(0)) {
      break
    }

    const quantityFromThisBatch = Decimal.min(batch.remainingQuantity, remainingToAllocate)

    const costImpact = quantityFromThisBatch.mul(batch.costPerUnit)
    const remainingAfter = batch.remainingQuantity.sub(quantityFromThisBatch)

    allocations.push({
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      quantityToDeduct: quantityFromThisBatch,
      costImpact,
      remainingAfter,
    })

    remainingToAllocate = remainingToAllocate.sub(quantityFromThisBatch)
  }

  // Check if we could fulfill the entire quantity
  if (remainingToAllocate.greaterThan(0)) {
    const totalAvailable = batches.reduce((sum, b) => sum.add(b.remainingQuantity), new Decimal(0))
    throw new AppError(`Insufficient stock. Needed: ${quantityNeeded}, Available: ${totalAvailable.toNumber()}`, 400)
  }

  return allocations
}

/**
 * Deduct stock from batches using FIFO and create movement records
 */
export async function deductStockFIFO(
  venueId: string,
  rawMaterialId: string,
  quantityToDeduct: number,
  movementType: RawMaterialMovementType,
  metadata: {
    reason?: string
    reference?: string
    createdBy?: string
  },
): Promise<any[]> {
  // Get FIFO allocations
  const allocations = await allocateStockFIFO(venueId, rawMaterialId, quantityToDeduct)

  // Get current raw material stock for movement records
  const rawMaterial = await prisma.rawMaterial.findUnique({
    where: { id: rawMaterialId },
  })

  if (!rawMaterial) {
    throw new AppError(`Raw material not found`, 404)
  }

  const operations: Prisma.PrismaPromise<any>[] = []
  const movements: any[] = []

  let cumulativeStock = rawMaterial.currentStock

  // Process each allocation
  for (const allocation of allocations) {
    const previousStock = cumulativeStock
    const newStock = previousStock.sub(allocation.quantityToDeduct)
    cumulativeStock = newStock

    // Update batch remaining quantity
    operations.push(
      prisma.stockBatch.update({
        where: { id: allocation.batchId },
        data: {
          remainingQuantity: allocation.remainingAfter,
          status: allocation.remainingAfter.equals(0) ? BatchStatus.DEPLETED : BatchStatus.ACTIVE,
          depletedAt: allocation.remainingAfter.equals(0) ? new Date() : undefined,
        },
      }),
    )

    // Create movement record for this batch allocation
    const movement = await prisma.rawMaterialMovement.create({
      data: {
        rawMaterialId,
        venueId,
        batchId: allocation.batchId,
        type: movementType,
        quantity: allocation.quantityToDeduct.neg(), // Negative for deductions
        unit: rawMaterial.unit,
        previousStock,
        newStock,
        costImpact: allocation.costImpact.neg(), // Negative cost impact for deductions
        reason: metadata.reason,
        reference: metadata.reference,
        createdBy: metadata.createdBy,
      },
      include: {
        batch: {
          select: {
            batchNumber: true,
          },
        },
      },
    })

    movements.push(movement)
  }

  // Update raw material total stock
  operations.push(
    prisma.rawMaterial.update({
      where: { id: rawMaterialId },
      data: {
        currentStock: cumulativeStock,
      },
    }),
  )

  // Execute all operations in a transaction
  await prisma.$transaction(operations)

  return movements
}

/**
 * Get batch details with remaining quantity
 */
export async function getBatch(venueId: string, batchId: string): Promise<any> {
  const batch = await prisma.stockBatch.findFirst({
    where: {
      id: batchId,
      venueId,
    },
    include: {
      rawMaterial: true,
      purchaseOrderItem: {
        include: {
          purchaseOrder: {
            select: {
              orderNumber: true,
              supplier: {
                select: {
                  name: true,
                },
              },
            },
          },
        },
      },
      movements: {
        orderBy: {
          createdAt: 'desc',
        },
        take: 10,
      },
    },
  })

  if (!batch) {
    throw new AppError(`Batch not found`, 404)
  }

  return batch
}

/**
 * Get all batches for a raw material
 */
export async function getBatchesForRawMaterial(
  venueId: string,
  rawMaterialId: string,
  filters?: {
    status?: BatchStatus
    includeExpired?: boolean
  },
): Promise<any[]> {
  const where: Prisma.StockBatchWhereInput = {
    venueId,
    rawMaterialId,
    ...(filters?.status && { status: filters.status }),
  }

  const batches = await prisma.stockBatch.findMany({
    where,
    orderBy: {
      receivedDate: 'asc',
    },
    include: {
      rawMaterial: {
        select: {
          id: true,
          name: true,
          sku: true,
          unit: true,
        },
      },
      purchaseOrderItem: {
        select: {
          id: true,
          purchaseOrder: {
            select: {
              orderNumber: true,
            },
          },
        },
      },
    },
  })

  return batches
}

/**
 * Mark expired batches as EXPIRED status
 * Should be run as a scheduled job
 */
export async function markExpiredBatches(venueId?: string): Promise<number> {
  const now = new Date()

  const result = await prisma.stockBatch.updateMany({
    where: {
      ...(venueId && { venueId }),
      status: BatchStatus.ACTIVE,
      expirationDate: {
        lte: now,
      },
    },
    data: {
      status: BatchStatus.EXPIRED,
    },
  })

  return result.count
}

/**
 * Quarantine a batch (quality issue, damage, etc.)
 */
export async function quarantineBatch(venueId: string, batchId: string, reason: string): Promise<any> {
  const batch = await prisma.stockBatch.findFirst({
    where: {
      id: batchId,
      venueId,
    },
  })

  if (!batch) {
    throw new AppError(`Batch not found`, 404)
  }

  const updatedBatch = await prisma.stockBatch.update({
    where: { id: batchId },
    data: {
      status: BatchStatus.QUARANTINED,
    },
    include: {
      rawMaterial: true,
    },
  })

  // Create a movement record for the quarantine
  await prisma.rawMaterialMovement.create({
    data: {
      rawMaterialId: batch.rawMaterialId,
      venueId,
      batchId,
      type: RawMaterialMovementType.SPOILAGE,
      quantity: new Decimal(0), // No quantity change yet, just status change
      unit: batch.unit,
      previousStock: updatedBatch.rawMaterial.currentStock,
      newStock: updatedBatch.rawMaterial.currentStock,
      reason: `Batch quarantined: ${reason}`,
      reference: batchId,
    },
  })

  return updatedBatch
}

/**
 * Get batch statistics for reporting
 */
export async function getBatchStatistics(venueId: string, rawMaterialId?: string) {
  const where: Prisma.StockBatchWhereInput = {
    venueId,
    ...(rawMaterialId && { rawMaterialId }),
  }

  const [totalBatches, activeBatches, depletedBatches, expiredBatches, quarantinedBatches] = await Promise.all([
    prisma.stockBatch.count({ where }),
    prisma.stockBatch.count({ where: { ...where, status: BatchStatus.ACTIVE } }),
    prisma.stockBatch.count({ where: { ...where, status: BatchStatus.DEPLETED } }),
    prisma.stockBatch.count({ where: { ...where, status: BatchStatus.EXPIRED } }),
    prisma.stockBatch.count({ where: { ...where, status: BatchStatus.QUARANTINED } }),
  ])

  const totalValue = await prisma.stockBatch.aggregate({
    where: { ...where, status: BatchStatus.ACTIVE },
    _sum: {
      remainingQuantity: true,
    },
  })

  return {
    totalBatches,
    statusBreakdown: {
      active: activeBatches,
      depleted: depletedBatches,
      expired: expiredBatches,
      quarantined: quarantinedBatches,
    },
    totalRemainingQuantity: totalValue._sum.remainingQuantity?.toNumber() || 0,
  }
}

/**
 * Calculate weighted average cost across all active batches for a raw material
 */
export async function calculateWeightedAverageCost(venueId: string, rawMaterialId: string): Promise<number> {
  const activeBatches = await getActiveBatchesFIFO(venueId, rawMaterialId)

  if (activeBatches.length === 0) {
    return 0
  }

  let totalCost = new Decimal(0)
  let totalQuantity = new Decimal(0)

  for (const batch of activeBatches) {
    const batchValue = batch.remainingQuantity.mul(batch.costPerUnit)
    totalCost = totalCost.add(batchValue)
    totalQuantity = totalQuantity.add(batch.remainingQuantity)
  }

  if (totalQuantity.equals(0)) {
    return 0
  }

  return totalCost.div(totalQuantity).toNumber()
}

/**
 * Get the costing method for a venue from its settings
 */
export async function getVenueCostingMethod(venueId: string): Promise<'FIFO' | 'WEIGHTED_AVERAGE' | 'STANDARD_COST'> {
  const settings = await prisma.venueSettings.findUnique({
    where: { venueId },
    select: { costingMethod: true },
  })

  return settings?.costingMethod || 'FIFO'
}

/**
 * Calculate cost impact for a quantity using the venue's costing method
 */
export async function calculateCostImpact(
  venueId: string,
  rawMaterialId: string,
  quantity: number,
  costingMethod?: 'FIFO' | 'WEIGHTED_AVERAGE' | 'STANDARD_COST',
): Promise<Decimal> {
  // Get costing method from venue settings if not provided
  const method = costingMethod || (await getVenueCostingMethod(venueId))

  const rawMaterial = await prisma.rawMaterial.findUnique({
    where: { id: rawMaterialId },
  })

  if (!rawMaterial) {
    throw new AppError('Raw material not found', 404)
  }

  switch (method) {
    case 'FIFO': {
      // For FIFO, we need to allocate from batches to get actual costs
      const allocations = await allocateStockFIFO(venueId, rawMaterialId, quantity)
      return allocations.reduce((sum, alloc) => sum.add(alloc.costImpact), new Decimal(0))
    }

    case 'WEIGHTED_AVERAGE': {
      // Calculate weighted average cost across all active batches
      const avgCost = await calculateWeightedAverageCost(venueId, rawMaterialId)
      return new Decimal(quantity).mul(avgCost)
    }

    case 'STANDARD_COST': {
      // Use the standard cost from raw material
      return new Decimal(quantity).mul(rawMaterial.costPerUnit)
    }

    default:
      throw new AppError(`Unknown costing method: ${method}`, 400)
  }
}
