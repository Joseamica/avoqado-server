import { RawMaterial, RawMaterialMovementType, Prisma, Unit, UnitType, ModifierInventoryMode } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import prisma from '../../utils/prismaClient'
import AppError, { BadRequestError, NotFoundError } from '../../errors/AppError'
import { CreateRawMaterialDto, UpdateRawMaterialDto, AdjustStockDto } from '../../schemas/dashboard/inventory.schema'
import { createStockBatch, deductStockFIFO } from './fifoBatch.service'
import { sendLowStockAlertNotification } from './notification.service'
import { logAction } from './activity-log.service'
import { areUnitsCompatible, convertUnit } from '../../utils/unitConversion'
import { calculateRecipeCostV1, RecipeCostCalculationError } from './recipe-cost-calculator'
import { acquireRecipeCostGraphVenueLockV1, lockRecipeCostGraphsForRawMaterialUpdateV1 } from './recipe-cost-graph-lock'

function calculateRawMaterialRecipeCostV1(input: Parameters<typeof calculateRecipeCostV1>[0]) {
  try {
    return calculateRecipeCostV1(input)
  } catch (error) {
    // WHY: A cost edit must roll back cleanly when historical Recipe inputs are
    // invalid; exposing a stable 422 avoids committing a partially fresh graph.
    if (error instanceof RecipeCostCalculationError) {
      throw new AppError('Recipe cost inputs are invalid', 422, true, 'RECIPE_COST_INPUT_INVALID', {
        reason: error.code,
        lineId: error.lineId,
      })
    }
    throw error
  }
}

/**
 * Convert a quantity to a raw material's storage unit. Recipes and modifiers can
 * declare their own unit (e.g. "0.062 KILOGRAM" of a protein stored in GRAM);
 * deductStockFIFO expects the value already in rawMaterial.unit, so callers must
 * normalize first or stock will diverge by a factor of 1000.
 *
 * Throws BadRequestError if the units are dimensionally incompatible (mass vs
 * volume) — that's a misconfigured recipe, not something to silently coerce.
 */
function toRawMaterialUnit(quantity: Decimal | number, fromUnit: Unit, rawMaterial: { id: string; name: string; unit: Unit }): number {
  if (fromUnit === rawMaterial.unit) {
    return new Decimal(quantity).toNumber()
  }
  if (!areUnitsCompatible(fromUnit, rawMaterial.unit)) {
    throw new BadRequestError(
      `Recipe/modifier unit ${fromUnit} is incompatible with raw material "${rawMaterial.name}" stored in ${rawMaterial.unit}`,
    )
  }
  return convertUnit(quantity, fromUnit, rawMaterial.unit).toNumber()
}

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

/** Filters a raw-material listing can be narrowed by. Shared by the screen and its export. */
export interface RawMaterialFilters {
  category?: string
  /** Applied IN MEMORY (`currentStock <= reorderPoint` compares two columns). See below. */
  lowStock?: boolean
  active?: boolean
  search?: string
}

/**
 * The one place the raw-material filter is written. The screen listing and the export count
 * both read from here on purpose: a second where-clause built for the export drifts from the
 * one behind the screen, and then the file quietly disagrees with what the user is looking at.
 *
 * `lowStock` is deliberately NOT here — it compares two columns of the same row, which Prisma
 * cannot express, so the listing applies it after the query. Anything counting with this
 * clause therefore gets an UPPER BOUND when `lowStock` is on.
 */
function buildRawMaterialsWhereClause(venueId: string, filters?: RawMaterialFilters): Prisma.RawMaterialWhereInput {
  return {
    venueId,
    deletedAt: null, // Exclude soft-deleted records
    ...(filters?.category && { category: filters.category as any }),
    ...(filters?.active !== undefined && { active: filters.active }),
    ...(filters?.search && {
      OR: [{ name: { contains: filters.search, mode: 'insensitive' } }, { sku: { contains: filters.search, mode: 'insensitive' } }],
    }),
  }
}

/**
 * Get all raw materials for a venue
 */
export async function getRawMaterials(venueId: string, filters?: RawMaterialFilters): Promise<RawMaterial[]> {
  const where = buildRawMaterialsWhereClause(venueId, filters)

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
    // `id` is the tie-breaker, not decoration: two raw materials can share a name, and a
    // non-unique sort hands back a different arrangement per call — two exports taken minutes
    // apart stop being comparable, and any future pagination would drop rows outright.
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
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

  // Create the raw material and (when there is initial stock) its backing batch +
  // movement atomically. Previously the RM was created, then createStockBatch ran
  // OUTSIDE any transaction, then the movement in a third step — so a failure in
  // the batch/movement left the RM claiming currentStock with no batch to back it
  // (the same atomicity flaw that orphaned a batch in adjustStock, firma #27).
  const { rawMaterial, batch } = await prisma.$transaction(async tx => {
    const createdRm = await tx.rawMaterial.create({
      data: {
        ...restData,
        venueId,
        unit,
        unitType,
        avgCostPerUnit: data.avgCostPerUnit || data.costPerUnit,
      },
    })

    let createdBatch: Awaited<ReturnType<typeof createStockBatch>> | null = null
    if (data.currentStock > 0) {
      createdBatch = await createStockBatch(
        venueId,
        createdRm.id,
        {
          quantity: data.currentStock,
          unit,
          costPerUnit: data.costPerUnit || 0,
          receivedDate: new Date(),
          expirationDate:
            data.perishable && data.shelfLifeDays ? new Date(Date.now() + data.shelfLifeDays * 24 * 60 * 60 * 1000) : undefined,
        },
        undefined, // createRawMaterial has no staffId in its signature
        tx,
        { skipAudit: true },
      )

      await tx.rawMaterialMovement.create({
        data: {
          rawMaterialId: createdRm.id,
          venueId,
          batchId: createdBatch.id,
          type: RawMaterialMovementType.ADJUSTMENT,
          quantity: data.currentStock,
          unit,
          previousStock: 0,
          newStock: data.currentStock,
          reason: 'Initial stock',
        },
      })
    }

    return { rawMaterial: createdRm, batch: createdBatch }
  })

  // Audit AFTER commit (fire-and-forget) — createStockBatch skipped its internal
  // log so a rolled-back batch leaves no phantom STOCK_BATCH_CREATED entry.
  if (batch) {
    void logAction({
      venueId,
      action: 'STOCK_BATCH_CREATED',
      entity: 'StockBatch',
      entityId: batch.id,
      data: {
        batchNumber: batch.batchNumber,
        rawMaterialId: rawMaterial.id,
        quantity: data.currentStock,
        costPerUnit: data.costPerUnit || 0,
      },
    })
  }

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
export async function updateRawMaterial(
  venueId: string,
  rawMaterialId: string,
  data: UpdateRawMaterialDto,
  staffId?: string,
): Promise<RawMaterial> {
  // Strip currentStock from update — stock changes must go through adjustStock()
  // to maintain StockBatch consistency
  const { currentStock: _stripStock, ...safeData } = data as any

  const updateData: any = {
    ...safeData,
  }

  if (data.unit) {
    const unit = data.unit as Unit
    updateData.unit = unit
    updateData.unitType = getUnitType(unit)
  }

  const mutation = await prisma.$transaction(async tx => {
    let lockedRecipeIds: string[] = []
    let recomputedRecipes: Array<{ productName: string; oldTotal: number; newTotal: number }> = []
    if (data.costPerUnit !== undefined || data.unit !== undefined) {
      await acquireRecipeCostGraphVenueLockV1(tx, venueId)
      const candidates = await tx.recipe.findMany({
        where: { lines: { some: { rawMaterialId } }, product: { venueId } },
        select: { id: true },
        orderBy: { id: 'asc' },
      })
      lockedRecipeIds = await lockRecipeCostGraphsForRawMaterialUpdateV1(
        tx,
        venueId,
        candidates.map(recipe => recipe.id),
        rawMaterialId,
      )
    }

    // WHY: This live read follows the target RM UPDATE lock whenever either
    // graph input is supplied, so cost/unit decisions never use a stale snapshot.
    const existing = await tx.rawMaterial.findFirst({ where: { id: rawMaterialId, venueId } })
    if (!existing) throw new AppError(`Raw material with ID ${rawMaterialId} not found`, 404)
    const costChanging = data.costPerUnit !== undefined && !new Decimal(data.costPerUnit).equals(existing.costPerUnit)
    const unitChanging = data.unit !== undefined && data.unit !== existing.unit
    const updated = await tx.rawMaterial.update({
      where: { id: rawMaterialId },
      data: updateData,
    })

    if (costChanging || unitChanging) {
      recomputedRecipes = await recomputeRecipesUsingRawMaterial(tx, venueId, rawMaterialId, lockedRecipeIds)
    }

    return { rawMaterial: updated, costChanging, unitChanging, oldCost: existing.costPerUnit, oldUnit: existing.unit, recomputedRecipes }
  })
  const { rawMaterial, costChanging, unitChanging, oldCost, oldUnit, recomputedRecipes } = mutation

  if (recomputedRecipes.length > 0) {
    // WHY: The operational activity log uses the global best-effort logger, so
    // it is emitted only after the graph transaction has committed successfully.
    logAction({
      venueId,
      staffId,
      action: 'RECIPES_RECOMPUTED',
      entity: 'RawMaterial',
      entityId: rawMaterialId,
      data: {
        trigger: 'raw_material_cost_or_unit_change',
        oldCost: oldCost.toNumber(),
        newCost: rawMaterial.costPerUnit.toNumber(),
        oldUnit,
        newUnit: rawMaterial.unit,
        recipesAffected: recomputedRecipes.length,
        recipes: recomputedRecipes,
      },
    })
  }

  logAction({
    venueId,
    staffId,
    action: 'RAW_MATERIAL_UPDATED',
    entity: 'RawMaterial',
    entityId: rawMaterial.id,
    data: {
      name: rawMaterial.name,
      costChanged: costChanging,
      unitChanged: unitChanging,
      oldCostPerUnit: costChanging ? oldCost.toNumber() : undefined,
      newCostPerUnit: costChanging ? rawMaterial.costPerUnit.toNumber() : undefined,
      oldUnit: unitChanging ? oldUnit : undefined,
      newUnit: unitChanging ? rawMaterial.unit : undefined,
    },
  })

  return rawMaterial
}

/**
 * Recompute Recipe.totalCost + RecipeLine.costPerServing for locked, valid
 * graphs changed through this dashboard editor. Non-cooperating transfer and
 * offline recovery writers may still make readiness report H1 STALE; they are
 * explicitly inventoried follow-up rather than a claimed global invariant.
 *
 * Returns the committed-delta summary so the caller can log after transaction.
 */
async function recomputeRecipesUsingRawMaterial(
  tx: Prisma.TransactionClient,
  venueId: string,
  rawMaterialId: string,
  lockedRecipeIds: readonly string[],
): Promise<Array<{ productName: string; oldTotal: number; newTotal: number }>> {
  const recipes = await tx.recipe.findMany({
    where: { id: { in: [...lockedRecipeIds] }, lines: { some: { rawMaterialId } }, product: { venueId } },
    include: {
      product: { select: { id: true, name: true, venueId: true } },
      lines: { include: { rawMaterial: true }, orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }] },
    },
    orderBy: { id: 'asc' },
  })

  const recipeUpdates: Array<{ productName: string; oldTotal: number; newTotal: number }> = []

  for (const recipe of recipes) {
    if (recipe.lines.some(line => line.rawMaterial.venueId !== venueId)) {
      throw new AppError('Recipe contains an ingredient from another venue', 422, true, 'RECIPE_COST_INPUT_INVALID')
    }
    const calculated = calculateRawMaterialRecipeCostV1({ portionYield: recipe.portionYield, lines: recipe.lines })
    for (const line of calculated.lines) {
      await tx.recipeLine.update({ where: { id: line.id }, data: { costPerServing: line.costPerServing } })
    }
    await tx.recipe.update({ where: { id: recipe.id }, data: { totalCost: calculated.costPerPortion } })
    if (!calculated.costPerPortion.equals(recipe.totalCost)) {
      recipeUpdates.push({
        productName: recipe.product.name,
        oldTotal: recipe.totalCost.toNumber(),
        newTotal: calculated.costPerPortion.toNumber(),
      })
    }
  }

  return recipeUpdates
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
  const movementType = data.type as RawMaterialMovementType
  if (movementType === RawMaterialMovementType.TRANSFER_OUT || movementType === RawMaterialMovementType.TRANSFER_IN) {
    throw new AppError('Los movimientos de traslado solo pueden generarse desde el flujo de traslados entre sucursales', 400)
  }
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
    // Guard: RawMaterialMovement.costImpact is Decimal(10,4) — it caps at < 1e6.
    // A user typo (extra zeros) produces a costImpact that overflows and throws a
    // cryptic Postgres 22003 AFTER the batch is written. Validate BEFORE any write
    // so we fail cleanly with a 400 instead of leaving an orphan batch behind.
    // (Same unit here → createStockBatch does not re-normalize the cost, so this
    // projection matches the movement's costImpact exactly.)
    const projectedCostImpact = rawMaterial.costPerUnit.mul(data.quantity).abs()
    if (projectedCostImpact.greaterThanOrEqualTo(1_000_000)) {
      throw new AppError(
        `La cantidad ingresada (${data.quantity}) genera un impacto de costo de ${projectedCostImpact.toFixed(
          2,
        )} que excede el máximo permitido. Verifica la cantidad — es posible que tenga ceros de más.`,
        400,
      )
    }

    // Create the batch, update currentStock and record the movement atomically.
    // Previously createStockBatch ran OUTSIDE this transaction, so any later
    // failure (this overflow, a timeout, etc.) left an orphan batch in FIFO.
    const { batch, updated } = await prisma.$transaction(async tx => {
      const created = await createStockBatch(
        venueId,
        rawMaterialId,
        {
          quantity: data.quantity,
          unit: rawMaterial.unit,
          costPerUnit: rawMaterial.costPerUnit.toNumber(), // Use current cost
          receivedDate: new Date(),
          expirationDate:
            rawMaterial.perishable && rawMaterial.shelfLifeDays
              ? new Date(Date.now() + rawMaterial.shelfLifeDays * 24 * 60 * 60 * 1000)
              : undefined,
        },
        staffId,
        tx,
        { skipAudit: true },
      )

      const updatedRm = await tx.rawMaterial.update({
        where: { id: rawMaterialId },
        data: {
          currentStock: newStock,
          lastCountAt: data.type === RawMaterialMovementType.COUNT ? new Date() : rawMaterial.lastCountAt,
        },
      })

      await tx.rawMaterialMovement.create({
        data: {
          rawMaterialId,
          venueId,
          batchId: created.id,
          type: data.type,
          quantity: data.quantity,
          unit: rawMaterial.unit,
          previousStock,
          newStock,
          costImpact: created.costPerUnit.mul(data.quantity),
          reason: data.reason || `Manual addition (Batch: ${created.batchNumber})`,
          reference: data.reference,
          createdBy: staffId,
        },
      })

      return { batch: created, updated: updatedRm }
    })

    // Audit AFTER commit (fire-and-forget, outside the tx) so a rolled-back batch
    // never leaves a phantom STOCK_BATCH_CREATED log — createStockBatch skipped it.
    void logAction({
      staffId,
      venueId,
      action: 'STOCK_BATCH_CREATED',
      entity: 'StockBatch',
      entityId: batch.id,
      data: { batchNumber: batch.batchNumber, rawMaterialId, quantity: data.quantity, costPerUnit: rawMaterial.costPerUnit.toNumber() },
    })

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

/** Date window a kardex query can be narrowed to. Shared by the screen and its export. */
export interface StockMovementFilters {
  startDate?: Date
  endDate?: Date
}

/**
 * The one place the kardex filter is written. The screen listing, the export count and the
 * export fetch all read from here on purpose: a second where-clause built for the export
 * drifts from the one behind the screen, and then the file quietly disagrees with what the
 * user is looking at.
 */
function buildStockMovementsWhereClause(venueId: string, rawMaterialId: string, filters?: StockMovementFilters) {
  return {
    rawMaterialId,
    venueId,
    ...((filters?.startDate || filters?.endDate) && {
      createdAt: {
        ...(filters?.startDate && { gte: filters.startDate }),
        ...(filters?.endDate && { lte: filters.endDate }),
      },
    }),
  }
}

/**
 * Get stock movements for a raw material
 */
export async function getStockMovements(
  venueId: string,
  rawMaterialId: string,
  options?: StockMovementFilters & {
    limit?: number
  },
) {
  const movements = await prisma.rawMaterialMovement.findMany({
    where: buildStockMovementsWhereClause(venueId, rawMaterialId, options),
    // `createdAt` alone is not unique — bulk movements written in the same transaction share a
    // timestamp to the millisecond, and a non-unique sort drops rows across pages silently.
    // `id` is the tiebreaker.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: options?.limit || 100,
  })

  return movements
}

/**
 * Row count for the kardex export, using the SAME filter builder as the listing. The
 * controller counts before building so it can refuse a file that would be truncated — a
 * truncated export reads as complete, which is the failure nobody reports.
 */
export async function countStockMovementsForExport(
  venueId: string,
  rawMaterialId: string,
  filters?: StockMovementFilters,
): Promise<number> {
  return prisma.rawMaterialMovement.count({
    where: buildStockMovementsWhereClause(venueId, rawMaterialId, filters),
  })
}

/**
 * Kardex rows for the export: the SAME listing the screen calls, plus the two things the
 * report is actually read for — WHICH material and WHO moved it.
 *
 * Both need resolving here rather than through an `include`: the listing returns bare
 * movement rows, and `RawMaterialMovement.createdBy` is a plain staff id with no Prisma
 * relation behind it, so the names take their own scoped lookups. `limit` comes from the
 * caller's cap; leaving it out inherits the listing's default page size of 100 and hands
 * over a fraction of the year as if it were the year.
 */
export async function fetchStockMovementsForExport(
  venueId: string,
  rawMaterialId: string,
  filters: StockMovementFilters | undefined,
  limit: number,
) {
  const movements = await getStockMovements(venueId, rawMaterialId, { ...filters, limit })

  const staffIds = Array.from(new Set(movements.map(m => m.createdBy).filter((id): id is string => Boolean(id))))

  // Scoped to the venue like every other query: a staff id read off a movement row still gets
  // checked against this venue's roster before its name is printed. Skipped entirely when no
  // movement carries an author, so a system-generated kardex costs one query, not two.
  const staffPromise: Promise<{ id: string; firstName: string; lastName: string }[]> =
    staffIds.length > 0
      ? prisma.staff.findMany({
          where: { id: { in: staffIds }, venues: { some: { venueId } } },
          select: { id: true, firstName: true, lastName: true },
        })
      : Promise.resolve([])

  const [rawMaterial, staff] = await Promise.all([
    prisma.rawMaterial.findFirst({
      where: { id: rawMaterialId, venueId },
      select: { name: true },
    }),
    staffPromise,
  ])

  const staffNameById = new Map(staff.map(s => [s.id, `${s.firstName} ${s.lastName}`.trim()]))

  return movements.map(movement => ({
    ...movement,
    rawMaterialName: rawMaterial?.name ?? '',
    staffName: movement.createdBy ? (staffNameById.get(movement.createdBy) ?? '') : '',
  }))
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

    // Calculate total quantity: modifier.quantityPerUnit × orderItem.quantity × modifier selection qty.
    // Convert from modifier.unit → rawMaterial.unit before deducting.
    const modRawMaterial = await prisma.rawMaterial.findUniqueOrThrow({
      where: { id: modifier.rawMaterialId },
      select: { id: true, name: true, unit: true },
    })
    const modifierUnit = modifier.unit ?? modRawMaterial.unit
    const totalInModifierUnit = modifier.quantityPerUnit.mul(orderItemQuantity).mul(modifierQty)
    const totalQuantity = toRawMaterialUnit(totalInModifierUnit, modifierUnit, modRawMaterial)

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

      // Send notification only if the raw material has notifications enabled
      if (rawMaterial.notifyOnLowStock) {
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

  // Capture per-ingredient deductions for the audit log so the activity feed
  // can show "Sold 1x Hazelnut treat → 62g Proteina, 21g Sarais, 125g Dátiles".
  const deductionTrace: Array<{ rawMaterialId: string; ingredient: string; quantity: number; unit: string }> = []

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
        // Use modifier's ingredient instead of recipe default. Convert from
        // modifier.unit → rawMaterial.unit (modifier may declare grams while
        // the raw material is stored in kilograms or vice-versa).
        const subRawMaterial = await prisma.rawMaterial.findUniqueOrThrow({
          where: { id: substitutionModifier.modifier.rawMaterialId! },
          select: { id: true, name: true, unit: true },
        })
        const subModifierUnit = substitutionModifier.modifier.unit ?? subRawMaterial.unit
        const totalQtyInRecipeUnit = substitutionModifier.modifier.quantityPerUnit!.mul(quantity).mul(substitutionModifier.quantity)
        const totalQty = toRawMaterialUnit(totalQtyInRecipeUnit, subModifierUnit, subRawMaterial)

        await deductStockFIFO(venueId, substitutionModifier.modifier.rawMaterialId!, totalQty, RawMaterialMovementType.USAGE, {
          reason: `Substitution: ${substitutionModifier.modifier.name} for ${recipe.product?.name}`,
          reference: orderId,
          createdBy: staffId,
        })

        deductionTrace.push({
          rawMaterialId: substitutionModifier.modifier.rawMaterialId!,
          ingredient: `${subRawMaterial.name} (substituted via ${substitutionModifier.modifier.name})`,
          quantity: totalQty,
          unit: subRawMaterial.unit,
        })

        // Check for low stock on the substituted ingredient
        await checkAndCreateLowStockAlert(venueId, substitutionModifier.modifier.rawMaterialId!)

        continue // Skip default ingredient - it was substituted
      }
    }

    // Use default recipe ingredient (no substitution or not a variable ingredient).
    // Convert RecipeLine.unit → rawMaterial.unit so that "0.062 KILOGRAM"
    // becomes "62 GRAM" when the raw material is stored in grams.
    const deductionInRecipeUnit = line.quantity.mul(quantity) // quantity per portion × portions sold
    const deductionQuantity = toRawMaterialUnit(deductionInRecipeUnit, line.unit, line.rawMaterial)

    // Use FIFO to deduct from oldest batches
    await deductStockFIFO(venueId, line.rawMaterialId, deductionQuantity, RawMaterialMovementType.USAGE, {
      reason: `Sold ${quantity}x ${recipe.product?.name || 'product'}`,
      reference: orderId,
      createdBy: staffId,
    })

    deductionTrace.push({
      rawMaterialId: line.rawMaterialId,
      ingredient: line.rawMaterial.name,
      quantity: deductionQuantity,
      unit: line.rawMaterial.unit,
    })

    // Check for low stock after deduction
    await checkAndCreateLowStockAlert(venueId, line.rawMaterialId)
  }

  // Single audit entry per order/product for the whole deduction. This is the
  // bridge ActivityLog was missing for sale events — without it there's no
  // searchable trail of "what got consumed when this order was paid".
  if (deductionTrace.length > 0) {
    logAction({
      venueId,
      staffId,
      action: 'INVENTORY_DEDUCTED_FOR_SALE',
      entity: 'Order',
      entityId: orderId,
      data: {
        productId,
        productName: recipe.product?.name,
        portionsSold: quantity,
        ingredients: deductionTrace,
      },
    })
  }
}

/**
 * Row count for the export, using the SAME filter builder as `getRawMaterials`. The controller
 * counts before building so it can refuse a file that would be truncated — a truncated export
 * reads as complete, which is the failure nobody reports.
 *
 * ⚠️ With `lowStock` on this is an UPPER BOUND, not the row count: that filter is applied in
 * memory (it compares `currentStock` against `reorderPoint`, two columns of the same row, which
 * Prisma cannot express). Refusing on an upper bound would 413 a fifty-row file, so the caller
 * has to fall back to counting the fetched rows — see `exportRawMaterials`.
 */
export async function countRawMaterialsForExport(venueId: string, filters?: RawMaterialFilters): Promise<number> {
  return prisma.rawMaterial.count({ where: buildRawMaterialsWhereClause(venueId, filters) })
}
