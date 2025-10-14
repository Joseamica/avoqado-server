import { RawMaterial, RawMaterialMovementType, Prisma, Unit, UnitType } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import AppError from '../../errors/AppError'
import { CreateRawMaterialDto, UpdateRawMaterialDto, AdjustStockDto } from '../../schemas/dashboard/inventory.schema'
import { createStockBatch, deductStockFIFO } from './fifoBatch.service'
import { sendLowStockAlertNotification } from './notification.service'

/**
 * Helper function to get UnitType from Unit
 */
export function getUnitType(unit: Unit): UnitType {
  const unitStr = unit as string

  const weightUnits = ['GRAM', 'KILOGRAM', 'MILLIGRAM', 'POUND', 'OUNCE', 'TON'] as const
  const volumeUnits = ['MILLILITER', 'LITER', 'GALLON', 'QUART', 'PINT', 'CUP', 'FLUID_OUNCE', 'TABLESPOON', 'TEASPOON'] as const
  const countUnits = ['UNIT', 'PIECE', 'DOZEN', 'CASE', 'BOX', 'BAG', 'BOTTLE', 'CAN', 'JAR'] as const
  const lengthUnits = ['METER', 'CENTIMETER', 'MILLIMETER', 'INCH', 'FOOT'] as const
  const tempUnits = ['CELSIUS', 'FAHRENHEIT'] as const
  const timeUnits = ['MINUTE', 'HOUR', 'DAY'] as const

  if (weightUnits.includes(unitStr as any)) return UnitType.WEIGHT
  if (volumeUnits.includes(unitStr as any)) return UnitType.VOLUME
  if (countUnits.includes(unitStr as any)) return UnitType.COUNT
  if (lengthUnits.includes(unitStr as any)) return UnitType.LENGTH
  if (tempUnits.includes(unitStr as any)) return UnitType.TEMPERATURE
  if (timeUnits.includes(unitStr as any)) return UnitType.TIME

  // Default fallback
  return UnitType.COUNT
}

/**
 * Get all raw materials for a venue
 */
export async function getRawMaterials(
  venueId: string,
  filters?: {
    category?: string
    lowStock?: boolean
    active?: boolean
    search?: string
  },
): Promise<RawMaterial[]> {
  const where: Prisma.RawMaterialWhereInput = {
    venueId,
    deletedAt: null, // Exclude soft-deleted records
    ...(filters?.category && { category: filters.category as any }),
    ...(filters?.active !== undefined && { active: filters.active }),
    ...(filters?.search && {
      OR: [{ name: { contains: filters.search, mode: 'insensitive' } }, { sku: { contains: filters.search, mode: 'insensitive' } }],
    }),
  }

  // Handle low stock filter separately
  let rawMaterials = await prisma.rawMaterial.findMany({
    where,
    include: {
      _count: {
        select: {
          recipeLines: true,
        },
      },
      lowStockAlerts: {
        where: {
          status: 'ACTIVE',
        },
      },
    },
    orderBy: { name: 'asc' },
  })

  if (filters?.lowStock) {
    rawMaterials = rawMaterials.filter(rm => rm.currentStock <= rm.reorderPoint)
  }

  return rawMaterials as any
}

/**
 * Get a single raw material by ID
 */
export async function getRawMaterial(venueId: string, rawMaterialId: string): Promise<RawMaterial | null> {
  const rawMaterial = await prisma.rawMaterial.findFirst({
    where: {
      id: rawMaterialId,
      venueId,
    },
    include: {
      recipeLines: {
        include: {
          recipe: {
            include: {
              product: true,
            },
          },
        },
      },
      movements: {
        orderBy: {
          createdAt: 'desc',
        },
        take: 20,
      },
      supplierPricing: {
        where: {
          active: true,
        },
        include: {
          supplier: true,
        },
      },
      lowStockAlerts: {
        where: {
          status: 'ACTIVE',
        },
      },
    },
  })

  return rawMaterial as any
}

/**
 * Create a new raw material
 */
export async function createRawMaterial(venueId: string, data: CreateRawMaterialDto): Promise<RawMaterial> {
  // Check for duplicate SKU
  const existing = await prisma.rawMaterial.findFirst({
    where: {
      venueId,
      sku: data.sku,
    },
  })

  if (existing) {
    throw new AppError(`Raw material with SKU ${data.sku} already exists`, 400)
  }

  // Extract unit from data and convert to typed enum
  const { unit: unitFromDto, ...restData } = data
  const unit = unitFromDto as Unit
  const unitType = getUnitType(unit)

  const rawMaterial = await prisma.rawMaterial.create({
    data: {
      ...restData,
      venueId,
      unit,
      unitType,
      avgCostPerUnit: data.avgCostPerUnit || data.costPerUnit,
    },
  })

  // Create initial movement record
  await prisma.rawMaterialMovement.create({
    data: {
      rawMaterialId: rawMaterial.id,
      venueId,
      type: RawMaterialMovementType.ADJUSTMENT,
      quantity: data.currentStock,
      unit,
      previousStock: 0,
      newStock: data.currentStock,
      reason: 'Initial stock',
    },
  })

  return rawMaterial
}

/**
 * Update an existing raw material
 */
export async function updateRawMaterial(venueId: string, rawMaterialId: string, data: UpdateRawMaterialDto): Promise<RawMaterial> {
  const existing = await prisma.rawMaterial.findFirst({
    where: { id: rawMaterialId, venueId },
  })

  if (!existing) {
    throw new AppError(`Raw material with ID ${rawMaterialId} not found`, 404)
  }

  // Handle unit update with unitType
  const updateData: any = {
    ...data,
  }

  if (data.unit) {
    const unit = data.unit as Unit
    updateData.unit = unit
    updateData.unitType = getUnitType(unit)
  }

  const rawMaterial = await prisma.rawMaterial.update({
    where: { id: rawMaterialId },
    data: updateData,
  })

  return rawMaterial
}

/**
 * Delete a raw material (soft delete)
 */
export async function deleteRawMaterial(venueId: string, rawMaterialId: string, staffId?: string): Promise<void> {
  const existing = await prisma.rawMaterial.findFirst({
    where: { id: rawMaterialId, venueId, deletedAt: null },
    include: {
      recipeLines: true,
    },
  })

  if (!existing) {
    throw new AppError(`Raw material with ID ${rawMaterialId} not found`, 404)
  }

  if (existing.recipeLines.length > 0) {
    throw new AppError(`Cannot delete raw material ${existing.name} - it is used in ${existing.recipeLines.length} recipe(s)`, 400)
  }

  // Soft delete: set deletedAt timestamp instead of actually deleting
  await prisma.rawMaterial.update({
    where: { id: rawMaterialId },
    data: {
      deletedAt: new Date(),
      deletedBy: staffId,
      active: false, // Also mark as inactive
    },
  })
}

/**
 * Adjust stock for a raw material (manual adjustment)
 * Uses FIFO batch tracking for deductions
 */
export async function adjustStock(venueId: string, rawMaterialId: string, data: AdjustStockDto, staffId?: string): Promise<RawMaterial> {
  const rawMaterial = await prisma.rawMaterial.findFirst({
    where: { id: rawMaterialId, venueId },
  })

  if (!rawMaterial) {
    throw new AppError(`Raw material with ID ${rawMaterialId} not found`, 404)
  }

  const previousStock = rawMaterial.currentStock
  const newStock = previousStock.add(data.quantity)

  if (newStock.lessThan(0)) {
    throw new AppError(`Insufficient stock. Current: ${previousStock}, Requested: ${data.quantity}`, 400)
  }

  let updatedRawMaterial: RawMaterial

  // Handle stock deductions using FIFO
  if (data.quantity < 0) {
    const deductionAmount = Math.abs(data.quantity)

    // Use FIFO to deduct from oldest batches
    await deductStockFIFO(venueId, rawMaterialId, deductionAmount, data.type, {
      reason: data.reason,
      reference: data.reference,
      createdBy: staffId,
    })

    // Fetch updated raw material
    updatedRawMaterial = (await prisma.rawMaterial.findUnique({
      where: { id: rawMaterialId },
    }))!
  }
  // Handle stock additions by creating a new batch
  else if (data.quantity > 0) {
    // Create a new batch for manual additions
    const batch = await createStockBatch(venueId, rawMaterialId, {
      quantity: data.quantity,
      unit: rawMaterial.unit,
      costPerUnit: rawMaterial.costPerUnit.toNumber(), // Use current cost
      receivedDate: new Date(),
      expirationDate:
        rawMaterial.perishable && rawMaterial.shelfLifeDays
          ? new Date(Date.now() + rawMaterial.shelfLifeDays * 24 * 60 * 60 * 1000)
          : undefined,
    })

    // Update raw material stock
    const operations = [
      prisma.rawMaterial.update({
        where: { id: rawMaterialId },
        data: {
          currentStock: newStock,
          lastCountAt: data.type === RawMaterialMovementType.COUNT ? new Date() : rawMaterial.lastCountAt,
        },
      }),
      prisma.rawMaterialMovement.create({
        data: {
          rawMaterialId,
          venueId,
          batchId: batch.id,
          type: data.type,
          quantity: data.quantity,
          unit: rawMaterial.unit,
          previousStock,
          newStock,
          costImpact: batch.costPerUnit.mul(data.quantity),
          reason: data.reason || `Manual addition (Batch: ${batch.batchNumber})`,
          reference: data.reference,
          createdBy: staffId,
        },
      }),
    ]

    const [updated] = await prisma.$transaction(operations)
    updatedRawMaterial = updated as RawMaterial
  }
  // Zero quantity adjustment (e.g., COUNT with no change)
  else {
    updatedRawMaterial = await prisma.rawMaterial.update({
      where: { id: rawMaterialId },
      data: {
        lastCountAt: data.type === RawMaterialMovementType.COUNT ? new Date() : rawMaterial.lastCountAt,
      },
    })
  }

  // Check if we need to create a low stock alert
  const finalStock = updatedRawMaterial.currentStock
  if (finalStock.lessThanOrEqualTo(rawMaterial.reorderPoint)) {
    const existingAlert = await prisma.lowStockAlert.findFirst({
      where: {
        rawMaterialId,
        status: 'ACTIVE',
      },
    })

    if (!existingAlert) {
      const alertType = finalStock.equals(0) ? 'OUT_OF_STOCK' : 'LOW_STOCK'

      await prisma.lowStockAlert.create({
        data: {
          venueId,
          rawMaterialId,
          alertType,
          threshold: rawMaterial.reorderPoint,
          currentLevel: finalStock,
        },
      })

      // Send notification
      await sendLowStockAlertNotification(
        venueId,
        rawMaterialId,
        alertType,
        finalStock.toNumber(),
        rawMaterial.unit,
        rawMaterial.reorderPoint.toNumber(),
      )
    }
  }

  return updatedRawMaterial
}

/**
 * Get recipes that use a specific raw material
 */
export async function getRawMaterialRecipes(venueId: string, rawMaterialId: string) {
  const rawMaterial = await prisma.rawMaterial.findFirst({
    where: {
      id: rawMaterialId,
      venueId,
      deletedAt: null,
    },
  })

  if (!rawMaterial) {
    throw new AppError(`Raw material with ID ${rawMaterialId} not found`, 404)
  }

  // Find all recipe lines that use this raw material
  const recipeLines = await prisma.recipeLine.findMany({
    where: {
      rawMaterialId,
      recipe: {
        product: {
          venue: {
            id: venueId,
          },
        },
      },
    },
    include: {
      recipe: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              price: true,
            },
          },
          lines: {
            select: {
              id: true,
              quantity: true,
              unit: true,
            },
          },
        },
      },
    },
  })

  // Transform to unique products with their recipes
  const productsMap = new Map()

  for (const line of recipeLines) {
    const productId = line.recipe.product.id

    if (!productsMap.has(productId)) {
      productsMap.set(productId, {
        id: line.recipe.product.id,
        name: line.recipe.product.name,
        price: line.recipe.product.price,
        recipe: {
          id: line.recipe.id,
          totalCost: line.recipe.totalCost,
          portionYield: line.recipe.portionYield,
          lines: line.recipe.lines,
        },
      })
    }
  }

  return Array.from(productsMap.values())
}

/**
 * Get stock movements for a raw material
 */
export async function getStockMovements(
  venueId: string,
  rawMaterialId: string,
  options?: {
    startDate?: Date
    endDate?: Date
    limit?: number
  },
) {
  const movements = await prisma.rawMaterialMovement.findMany({
    where: {
      rawMaterialId,
      venueId,
      ...(options?.startDate && { createdAt: { gte: options.startDate } }),
      ...(options?.endDate && { createdAt: { lte: options.endDate } }),
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: options?.limit || 100,
  })

  return movements
}

/**
 * Deduct stock based on recipe usage (called when order is completed)
 * Uses FIFO batch tracking for accurate cost tracking
 */
export async function deductStockForRecipe(venueId: string, productId: string, quantity: number, orderId: string, staffId?: string) {
  const recipe = await prisma.recipe.findUnique({
    where: { productId },
    include: {
      product: true,
      lines: {
        include: {
          rawMaterial: true,
        },
      },
    },
  })

  if (!recipe) {
    // No recipe = no deduction needed
    return
  }

  // Process each ingredient in the recipe using FIFO
  for (const line of recipe.lines) {
    if (line.isOptional) continue // Skip optional ingredients

    const deductionQuantity = line.quantity.mul(quantity).toNumber() // quantity per portion × portions sold

    // Use FIFO to deduct from oldest batches
    await deductStockFIFO(venueId, line.rawMaterialId, deductionQuantity, RawMaterialMovementType.USAGE, {
      reason: `Sold ${quantity}x ${recipe.product?.name || 'product'}`,
      reference: orderId,
      createdBy: staffId,
    })

    // Check for low stock after deduction
    const updatedRawMaterial = await prisma.rawMaterial.findUnique({
      where: { id: line.rawMaterialId },
    })

    if (updatedRawMaterial && updatedRawMaterial.currentStock.lessThanOrEqualTo(line.rawMaterial.reorderPoint)) {
      const existingAlert = await prisma.lowStockAlert.findFirst({
        where: {
          rawMaterialId: line.rawMaterialId,
          status: 'ACTIVE',
        },
      })

      if (!existingAlert) {
        const alertType = updatedRawMaterial.currentStock.equals(0) ? 'OUT_OF_STOCK' : 'LOW_STOCK'

        await prisma.lowStockAlert.create({
          data: {
            venueId,
            rawMaterialId: line.rawMaterialId,
            alertType,
            threshold: line.rawMaterial.reorderPoint,
            currentLevel: updatedRawMaterial.currentStock,
          },
        })

        // Send notification
        await sendLowStockAlertNotification(
          venueId,
          line.rawMaterialId,
          alertType,
          updatedRawMaterial.currentStock.toNumber(),
          line.rawMaterial.unit,
          line.rawMaterial.reorderPoint.toNumber(),
        )
      }
    }
  }
}
