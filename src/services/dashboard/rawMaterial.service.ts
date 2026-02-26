import { RawMaterial, RawMaterialMovementType, Prisma, Unit, UnitType, ModifierInventoryMode } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import prisma from '../../utils/prismaClient'
import AppError, { BadRequestError, NotFoundError } from '../../errors/AppError'
import { CreateRawMaterialDto, UpdateRawMaterialDto, AdjustStockDto } from '../../schemas/dashboard/inventory.schema'
import { createStockBatch, deductStockFIFO } from './fifoBatch.service'
import { sendLowStockAlertNotification } from './notification.service'
import { logAction } from './activity-log.service'

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

  logAction({
    venueId,
    action: 'RAW_MATERIAL_CREATED',
    entity: 'RawMaterial',
    entityId: rawMaterial.id,
    data: { name: rawMaterial.name },
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

  logAction({
    venueId,
    action: 'RAW_MATERIAL_UPDATED',
    entity: 'RawMaterial',
    entityId: rawMaterial.id,
    data: { name: rawMaterial.name },
  })

  return rawMaterial
}

/**
 * Delete a raw material (soft delete)
 * Throws BadRequestError with detailed recipe information if the material is in use
 */
export async function deleteRawMaterial(venueId: string, rawMaterialId: string, staffId?: string): Promise<void> {
  const existing = await prisma.rawMaterial.findFirst({
    where: { id: rawMaterialId, venueId, deletedAt: null },
    include: {
      recipeLines: {
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
            },
          },
        },
      },
    },
  })

  if (!existing) {
    throw new NotFoundError(`Raw material with ID ${rawMaterialId} not found`)
  }

  // Check if material is used in any recipes
  if (existing.recipeLines.length > 0) {
    // Build detailed recipe information for better UX
    const recipesUsing = existing.recipeLines.map(line => ({
      id: line.recipe.id,
      productId: line.recipe.product.id,
      productName: line.recipe.product.name,
      productPrice: line.recipe.product.price,
      quantity: line.quantity,
      unit: line.unit,
      isOptional: line.isOptional,
    }))

    // Throw BadRequestError with detailed data (following FAANG pattern)
    const error = new BadRequestError(
      `Cannot delete raw material "${existing.name}" - it is used in ${existing.recipeLines.length} recipe(s). ` +
        `Please remove it from all recipes first, or deactivate it instead to preserve usage history.`,
    )

    // Attach structured data for frontend to display
    ;(error as any).data = {
      materialId: existing.id,
      materialName: existing.name,
      recipeCount: existing.recipeLines.length,
      recipes: recipesUsing,
      suggestion: 'deactivate', // Suggest alternative action
    }

    throw error
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

  logAction({
    staffId,
    venueId,
    action: 'RAW_MATERIAL_DELETED',
    entity: 'RawMaterial',
    entityId: rawMaterialId,
    data: { name: existing.name },
  })
}

/**
 * Deactivate a raw material (without deleting)
 * Use this when a material is still referenced in recipes but you want to stop using it
 * This preserves all historical data and relationships
 */
export async function deactivateRawMaterial(venueId: string, rawMaterialId: string): Promise<RawMaterial> {
  const existing = await prisma.rawMaterial.findFirst({
    where: { id: rawMaterialId, venueId, deletedAt: null },
  })

  if (!existing) {
    throw new NotFoundError(`Raw material with ID ${rawMaterialId} not found`)
  }

  if (!existing.active) {
    throw new BadRequestError(`Raw material "${existing.name}" is already deactivated`)
  }

  // Deactivate without deleting - preserves all usage history
  const deactivated = await prisma.rawMaterial.update({
    where: { id: rawMaterialId },
    data: {
      active: false,
    },
  })

  logAction({
    venueId,
    action: 'RAW_MATERIAL_DEACTIVATED',
    entity: 'RawMaterial',
    entityId: deactivated.id,
    data: { name: deactivated.name },
  })

  return deactivated
}

/**
 * Reactivate a previously deactivated raw material
 */
export async function reactivateRawMaterial(venueId: string, rawMaterialId: string): Promise<RawMaterial> {
  const existing = await prisma.rawMaterial.findFirst({
    where: { id: rawMaterialId, venueId, deletedAt: null },
  })

  if (!existing) {
    throw new NotFoundError(`Raw material with ID ${rawMaterialId} not found`)
  }

  if (existing.active) {
    throw new BadRequestError(`Raw material "${existing.name}" is already active`)
  }

  // Reactivate
  const reactivated = await prisma.rawMaterial.update({
    where: { id: rawMaterialId },
    data: {
      active: true,
    },
  })

  logAction({
    venueId,
    action: 'RAW_MATERIAL_REACTIVATED',
    entity: 'RawMaterial',
    entityId: reactivated.id,
    data: { name: reactivated.name },
  })

  return reactivated
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

  logAction({
    staffId,
    venueId,
    action: 'STOCK_ADJUSTED',
    entity: 'RawMaterial',
    entityId: rawMaterialId,
    data: { name: rawMaterial.name, quantity: data.quantity, type: data.type },
  })

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
 * Type for order item modifiers passed to inventory deduction functions
 * Contains the modifier details needed for inventory tracking
 */
export interface OrderModifierForInventory {
  quantity: number
  modifier: {
    id: string
    name: string
    groupId: string
    rawMaterialId: string | null
    quantityPerUnit: Decimal | null
    unit: Unit | null
    inventoryMode: ModifierInventoryMode
  }
}

/**
 * Deduct stock for ADDITION modifiers in an order item
 * ADDITION modifiers add extra ingredients on top of the recipe
 * Example: "Extra Bacon" adds 30g bacon to a burger
 *
 * Note: SUBSTITUTION modifiers are handled in deductStockForRecipe
 */
export async function deductStockForModifiers(
  venueId: string,
  orderItemQuantity: number,
  orderModifiers: OrderModifierForInventory[],
  orderId: string,
  staffId?: string,
): Promise<void> {
  for (const orderModifier of orderModifiers) {
    const { modifier, quantity: modifierQty } = orderModifier

    // Skip modifiers without inventory tracking
    if (!modifier.rawMaterialId || !modifier.quantityPerUnit) continue

    // Only process ADDITION modifiers here
    // SUBSTITUTION modifiers are handled in deductStockForRecipe
    if (modifier.inventoryMode !== 'ADDITION') continue

    // Calculate total quantity: modifier.quantityPerUnit × orderItem.quantity × modifier selection qty
    const totalQuantity = modifier.quantityPerUnit.mul(orderItemQuantity).mul(modifierQty).toNumber()

    await deductStockFIFO(venueId, modifier.rawMaterialId, totalQuantity, RawMaterialMovementType.USAGE, {
      reason: `Modifier: ${modifier.name}`,
      reference: orderId,
      createdBy: staffId,
    })

    // Check for low stock after deduction
    await checkAndCreateLowStockAlert(venueId, modifier.rawMaterialId)
  }
}

/**
 * Helper function to check and create low stock alerts
 */
async function checkAndCreateLowStockAlert(venueId: string, rawMaterialId: string): Promise<void> {
  const rawMaterial = await prisma.rawMaterial.findUnique({
    where: { id: rawMaterialId },
  })

  if (!rawMaterial) return

  if (rawMaterial.currentStock.lessThanOrEqualTo(rawMaterial.reorderPoint)) {
    const existingAlert = await prisma.lowStockAlert.findFirst({
      where: {
        rawMaterialId,
        status: 'ACTIVE',
      },
    })

    if (!existingAlert) {
      const alertType = rawMaterial.currentStock.equals(0) ? 'OUT_OF_STOCK' : 'LOW_STOCK'

      await prisma.lowStockAlert.create({
        data: {
          venueId,
          rawMaterialId,
          alertType,
          threshold: rawMaterial.reorderPoint,
          currentLevel: rawMaterial.currentStock,
        },
      })

      await sendLowStockAlertNotification(
        venueId,
        rawMaterialId,
        alertType,
        rawMaterial.currentStock.toNumber(),
        rawMaterial.unit,
        rawMaterial.reorderPoint.toNumber(),
      )
    }
  }
}

/**
 * Deduct stock based on recipe usage (called when order is completed)
 * Uses FIFO batch tracking for accurate cost tracking
 *
 * ✅ WORLD-CLASS: Supports variable ingredients that can be substituted by modifiers
 * Example: Recipe has "Whole Milk" but customer chose "Almond Milk" modifier
 */
export async function deductStockForRecipe(
  venueId: string,
  productId: string,
  quantity: number,
  orderId: string,
  staffId?: string,
  orderModifiers?: OrderModifierForInventory[],
) {
  const recipe = await prisma.recipe.findUnique({
    where: { productId },
    include: {
      product: true,
      lines: {
        include: {
          rawMaterial: true,
          linkedModifierGroup: true,
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

    // ✅ Check if this is a variable ingredient that can be substituted
    if (line.isVariable && line.linkedModifierGroupId && orderModifiers?.length) {
      // Find a SUBSTITUTION modifier from the linked group
      const substitutionModifier = orderModifiers.find(
        om =>
          om.modifier.groupId === line.linkedModifierGroupId &&
          om.modifier.inventoryMode === 'SUBSTITUTION' &&
          om.modifier.rawMaterialId &&
          om.modifier.quantityPerUnit,
      )

      if (substitutionModifier) {
        // Use modifier's ingredient instead of recipe default
        const totalQty = substitutionModifier.modifier.quantityPerUnit!.mul(quantity).mul(substitutionModifier.quantity).toNumber()

        await deductStockFIFO(venueId, substitutionModifier.modifier.rawMaterialId!, totalQty, RawMaterialMovementType.USAGE, {
          reason: `Substitution: ${substitutionModifier.modifier.name} for ${recipe.product?.name}`,
          reference: orderId,
          createdBy: staffId,
        })

        // Check for low stock on the substituted ingredient
        await checkAndCreateLowStockAlert(venueId, substitutionModifier.modifier.rawMaterialId!)

        continue // Skip default ingredient - it was substituted
      }
    }

    // Use default recipe ingredient (no substitution or not a variable ingredient)
    const deductionQuantity = line.quantity.mul(quantity).toNumber() // quantity per portion × portions sold

    // Use FIFO to deduct from oldest batches
    await deductStockFIFO(venueId, line.rawMaterialId, deductionQuantity, RawMaterialMovementType.USAGE, {
      reason: `Sold ${quantity}x ${recipe.product?.name || 'product'}`,
      reference: orderId,
      createdBy: staffId,
    })

    // Check for low stock after deduction
    await checkAndCreateLowStockAlert(venueId, line.rawMaterialId)
  }
}
