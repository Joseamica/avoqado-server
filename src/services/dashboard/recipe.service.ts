import { Prisma, Recipe, Unit } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { CreateRecipeDto, UpdateRecipeDto } from '../../schemas/dashboard/inventory.schema'
import { Decimal } from '@prisma/client/runtime/library'
import AppError from '@/errors/AppError'
import { logAction } from './activity-log.service'
import { areUnitsCompatible } from '../../utils/unitConversion'
import { calculateRecipeCostV1, RecipeCostCalculationError } from './recipe-cost-calculator'
import {
  acquireRecipeCostGraphVenueLockV1,
  lockRecipeCostGraphRowsV1,
  lockRecipeCostProductForUpdateV1,
  lockRecipeCostRawMaterialsForShareV1,
} from './recipe-cost-graph-lock'

function calculateRecipeCostForMutationV1(input: Parameters<typeof calculateRecipeCostV1>[0]) {
  try {
    return calculateRecipeCostV1(input)
  } catch (error) {
    // WHY: Invalid historical graph data is actionable 422 state, never an
    // unexpected 500 leaking calculator internals from a mutation endpoint.
    if (error instanceof RecipeCostCalculationError) {
      throw new AppError('Recipe cost inputs are invalid', 422, true, 'RECIPE_COST_INPUT_INVALID', {
        reason: error.code,
        lineId: error.lineId,
      })
    }
    throw error
  }
}

async function findAndLockRecipeGraphByProductV1(
  tx: Prisma.TransactionClient,
  venueId: string,
  productId: string,
  additionalRawMaterialIds: readonly string[] = [],
) {
  // WHY: This first post-advisory lookup discovers the row id only; every
  // authoritative field is reread after the fixed Recipe/line/RM lock chain.
  const candidate = await tx.recipe.findFirst({
    where: { productId, product: { venueId } },
    select: { id: true },
  })
  if (!candidate || !(await lockRecipeCostGraphRowsV1(tx, venueId, candidate.id, additionalRawMaterialIds))) return null

  return tx.recipe.findFirst({
    where: { id: candidate.id, productId, product: { venueId } },
    include: {
      product: true,
      lines: { include: { rawMaterial: true }, orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }] },
    },
  })
}

function assertRecipeGraphVenueV1(recipe: { lines: Array<{ rawMaterial: { venueId: string } }> }, venueId: string): void {
  // WHY: A corrupt legacy cross-Venue FK must fail before any foreign cost can
  // be used to persist Recipe or RecipeLine values.
  if (recipe.lines.some(line => line.rawMaterial.venueId !== venueId)) {
    throw new AppError('Recipe contains an ingredient from another venue', 422, true, 'RECIPE_COST_INPUT_INVALID')
  }
}

/**
 * Validate every recipe line is dimensionally compatible with its raw material
 * (mass↔mass, volume↔volume) and reject otherwise. Without this guard a user
 * can save "1 LITER of Protein (stored in GRAM)" and break inventory deduction
 * silently. See deductStockForRecipe for the runtime conversion using the same
 * compatibility check.
 */
function assertRecipeLinesUnitsAreValid(
  lines: Array<{ rawMaterialId: string; unit: Unit | string }>,
  rawMaterials: Array<{ id: string; name: string; unit: Unit }>,
): void {
  for (const line of lines) {
    const rm = rawMaterials.find(r => r.id === line.rawMaterialId)
    if (!rm) continue // missing-ingredient error is raised elsewhere
    const lineUnit = line.unit as Unit
    if (lineUnit !== rm.unit && !areUnitsCompatible(lineUnit, rm.unit)) {
      throw new AppError(
        `Recipe line unit ${lineUnit} is incompatible with ingredient "${rm.name}" stored in ${rm.unit}. Use a compatible unit (mass↔mass, volume↔volume).`,
        400,
      )
    }
  }
}

/**
 * Get recipe for a product
 */
export async function getRecipe(venueId: string, productId: string) {
  const recipe = await prisma.recipe.findUnique({
    where: { productId },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          price: true,
          venueId: true,
        },
      },
      lines: {
        include: {
          rawMaterial: true,
        },
        orderBy: {
          displayOrder: 'asc',
        },
      },
    },
  })

  if (recipe && recipe.product.venueId !== venueId) {
    throw new AppError('Recipe not found', 404)
  }

  return recipe
}

/**
 * Create a new recipe for a product
 */
export async function createRecipe(venueId: string, productId: string, data: CreateRecipeDto): Promise<Recipe> {
  const requestedLineRawMaterialIds = data.lines.map(line => line.rawMaterialId)
  if (new Set(requestedLineRawMaterialIds).size !== requestedLineRawMaterialIds.length) {
    // WHY: RecipeLine is unique by recipe+RM; rejecting duplicates explicitly
    // keeps malformed input at stable 400 instead of surfacing Prisma P2002/500.
    throw new AppError('A recipe cannot contain the same ingredient twice', 400, true, 'RECIPE_DUPLICATE_INGREDIENT')
  }
  const { recipe, productName } = await prisma.$transaction(async tx => {
    await acquireRecipeCostGraphVenueLockV1(tx, venueId)

    // WHY: Product, duplicate Recipe, and RM cost inputs are all reread after
    // the shared Venue lock so cooperating graph writers cannot create phantoms.
    if (!(await lockRecipeCostProductForUpdateV1(tx, venueId, productId))) {
      throw new AppError(`Product with ID ${productId} not found in venue ${venueId}`, 404)
    }
    const product = await tx.product.findFirst({ where: { id: productId, venueId } })
    if (!product) throw new AppError(`Product with ID ${productId} not found in venue ${venueId}`, 404)
    if (await tx.recipe.findUnique({ where: { productId } })) {
      throw new AppError(`Recipe already exists for product ${product.name}`, 400)
    }

    const rawMaterialIds = [...new Set(requestedLineRawMaterialIds)]
    const lockedIds = await lockRecipeCostRawMaterialsForShareV1(tx, venueId, rawMaterialIds)
    const rawMaterials = await tx.rawMaterial.findMany({
      where: { id: { in: lockedIds }, venueId, active: true, deletedAt: null },
    })
    if (rawMaterials.length !== rawMaterialIds.length) {
      const foundIds = rawMaterials.map(rawMaterial => rawMaterial.id)
      const missingIds = rawMaterialIds.filter(id => !foundIds.includes(id))
      throw new AppError(
        'Some ingredients are inactive, deleted, or not found. ' +
          'Please reactivate them or choose alternatives. ' +
          `Missing IDs: ${missingIds.join(', ')}`,
        400,
      )
    }
    assertRecipeLinesUnitsAreValid(data.lines, rawMaterials)

    const calculated = calculateRecipeCostForMutationV1({
      portionYield: data.portionYield,
      lines: data.lines.map((line, index) => ({
        id: `new:${index}`,
        quantity: new Decimal(line.quantity),
        unit: line.unit as Unit,
        rawMaterial: rawMaterials.find(rawMaterial => rawMaterial.id === line.rawMaterialId)!,
      })),
    })
    const costsByIndex = new Map(calculated.lines.map(line => [Number(line.id.slice(4)), line.costPerServing]))

    const created = await tx.recipe.create({
      data: {
        productId,
        portionYield: data.portionYield,
        totalCost: calculated.costPerPortion,
        prepTime: data.prepTime,
        cookTime: data.cookTime,
        notes: data.notes,
        lines: {
          create: data.lines.map((line, index) => ({
            rawMaterialId: line.rawMaterialId,
            quantity: line.quantity,
            unit: line.unit as Unit,
            costPerServing: costsByIndex.get(index)!,
            displayOrder: index,
            isOptional: line.isOptional,
            substituteNotes: line.substituteNotes,
          })),
        },
      },
      include: { lines: { include: { rawMaterial: true } }, product: true },
    })
    return { recipe: created, productName: product.name }
  })

  logAction({
    venueId,
    action: 'RECIPE_CREATED',
    entity: 'Recipe',
    entityId: recipe.id,
    data: { productId, productName },
  })

  return recipe as any
}

/**
 * Update an existing recipe
 */
export async function updateRecipe(venueId: string, productId: string, data: UpdateRecipeDto): Promise<Recipe> {
  if (data.lines) {
    const requestedIds = data.lines.map(line => line.rawMaterialId)
    if (new Set(requestedIds).size !== requestedIds.length) {
      // WHY: Full-line replacement must reject duplicates before delete/create
      // so the old graph survives and no database uniqueness error leaks.
      throw new AppError('A recipe cannot contain the same ingredient twice', 400, true, 'RECIPE_DUPLICATE_INGREDIENT')
    }
  }
  const costGraphChanging = data.lines !== undefined || data.portionYield !== undefined
  const recipe = costGraphChanging
    ? await prisma.$transaction(async tx => {
        await acquireRecipeCostGraphVenueLockV1(tx, venueId)
        const requestedRawMaterialIds = data.lines ? [...new Set(data.lines.map(line => line.rawMaterialId))] : []
        const existingRecipe = await findAndLockRecipeGraphByProductV1(tx, venueId, productId, requestedRawMaterialIds)
        if (!existingRecipe) throw new AppError(`Recipe not found for product ${productId}`, 404)
        assertRecipeGraphVenueV1(existingRecipe, venueId)

        if (data.lines !== undefined) {
          // WHY: Candidate RMs were locked with the old graph in one sorted set;
          // this post-lock read is the only cost input used by the replacement.
          const rawMaterials = await tx.rawMaterial.findMany({
            where: { id: { in: requestedRawMaterialIds }, venueId, active: true, deletedAt: null },
          })
          if (rawMaterials.length !== requestedRawMaterialIds.length) {
            const foundIds = rawMaterials.map(rawMaterial => rawMaterial.id)
            const missingIds = requestedRawMaterialIds.filter(id => !foundIds.includes(id))
            throw new AppError(
              'Some ingredients are inactive, deleted, or not found. ' +
                'Please reactivate them or choose alternatives. ' +
                `Missing IDs: ${missingIds.join(', ')}`,
              400,
            )
          }
          assertRecipeLinesUnitsAreValid(data.lines, rawMaterials)

          const portionYield = data.portionYield ?? existingRecipe.portionYield
          const calculated = calculateRecipeCostForMutationV1({
            portionYield,
            lines: data.lines.map((line, index) => ({
              id: `new:${index}`,
              quantity: new Decimal(line.quantity),
              unit: line.unit as Unit,
              rawMaterial: rawMaterials.find(rawMaterial => rawMaterial.id === line.rawMaterialId)!,
            })),
          })
          const costsByIndex = new Map(calculated.lines.map(line => [Number(line.id.slice(4)), line.costPerServing]))

          await tx.recipeLine.deleteMany({ where: { recipeId: existingRecipe.id } })
          return tx.recipe.update({
            where: { id: existingRecipe.id },
            data: {
              portionYield: data.portionYield,
              totalCost: calculated.costPerPortion,
              prepTime: data.prepTime,
              cookTime: data.cookTime,
              notes: data.notes,
              lines: {
                create: data.lines.map((line, index) => ({
                  rawMaterialId: line.rawMaterialId,
                  quantity: line.quantity,
                  unit: line.unit as Unit,
                  costPerServing: costsByIndex.get(index)!,
                  displayOrder: index,
                  isOptional: line.isOptional,
                  substituteNotes: line.substituteNotes,
                })),
              },
            },
            include: { lines: { include: { rawMaterial: true } }, product: true },
          })
        }

        // WHY: Yield is the denominator for aggregate and line costs; the
        // calculation uses only the graph reread after every row lock.
        const calculated = calculateRecipeCostForMutationV1({
          portionYield: data.portionYield as number,
          lines: existingRecipe.lines,
        })
        for (const line of calculated.lines) {
          await tx.recipeLine.update({ where: { id: line.id }, data: { costPerServing: line.costPerServing } })
        }
        return tx.recipe.update({
          where: { id: existingRecipe.id },
          data: {
            portionYield: data.portionYield,
            totalCost: calculated.costPerPortion,
            prepTime: data.prepTime,
            cookTime: data.cookTime,
            notes: data.notes,
          },
          include: { lines: { include: { rawMaterial: true } }, product: true },
        })
      })
    : await prisma.$transaction(async tx => {
        await acquireRecipeCostGraphVenueLockV1(tx, venueId)
        // WHY: Metadata changes affect readiness/updatedAt, and the locked
        // Product+Recipe tenant relation stays stable through the update.
        const existingRecipe = await findAndLockRecipeGraphByProductV1(tx, venueId, productId)
        if (!existingRecipe) throw new AppError(`Recipe not found for product ${productId}`, 404)
        return tx.recipe.update({
          where: { id: existingRecipe.id },
          data: { prepTime: data.prepTime, cookTime: data.cookTime, notes: data.notes },
          include: { lines: { include: { rawMaterial: true } }, product: true },
        })
      })

  logAction({ venueId, action: 'RECIPE_UPDATED', entity: 'Recipe', entityId: recipe.id, data: { productId } })
  return recipe as any
}

/**
 * Delete a recipe
 */
export async function deleteRecipe(venueId: string, productId: string): Promise<void> {
  const recipe = await prisma.$transaction(async tx => {
    await acquireRecipeCostGraphVenueLockV1(tx, venueId)
    const locked = await findAndLockRecipeGraphByProductV1(tx, venueId, productId)
    if (!locked) throw new AppError(`Recipe not found for product ${productId}`, 404)

    // WHY: Deletion participates in the same graph lock so a concurrent line or
    // RM recomputation cannot write a cost into a graph being removed.
    await tx.recipe.delete({ where: { id: locked.id } })
    return locked
  })

  logAction({
    venueId,
    action: 'RECIPE_DELETED',
    entity: 'Recipe',
    entityId: recipe.id,
    data: { productId },
  })
}

/**
 * Add a single ingredient to a recipe
 */
export async function addRecipeLine(
  venueId: string,
  productId: string,
  data: {
    rawMaterialId: string
    quantity: number
    unit: string
    isOptional?: boolean
    substituteNotes?: string
  },
) {
  const { recipeLine, rawMaterialName, costPerServing } = await prisma.$transaction(async tx => {
    await acquireRecipeCostGraphVenueLockV1(tx, venueId)
    const recipe = await findAndLockRecipeGraphByProductV1(tx, venueId, productId, [data.rawMaterialId])
    if (!recipe) throw new AppError(`Recipe not found for product ${productId}`, 404)
    assertRecipeGraphVenueV1(recipe, venueId)
    if (recipe.lines.some(line => line.rawMaterialId === data.rawMaterialId)) {
      // WHY: The database enforces one line per RM; a stable 400 preserves the
      // locked graph and never leaks a Prisma uniqueness error.
      throw new AppError('A recipe cannot contain the same ingredient twice', 400, true, 'RECIPE_DUPLICATE_INGREDIENT')
    }

    const rawMaterial = await tx.rawMaterial.findFirst({
      where: { id: data.rawMaterialId, venueId, active: true, deletedAt: null },
    })
    if (!rawMaterial) {
      throw new AppError(`Ingredient is inactive, deleted, or not found. ` + `Please reactivate it or choose an alternative.`, 400)
    }
    assertRecipeLinesUnitsAreValid([{ rawMaterialId: data.rawMaterialId, unit: data.unit }], [rawMaterial])

    // WHY: Recomputing the entire locked graph makes add-line atomic even when
    // historical derived columns were already stale before this mutation.
    const calculated = calculateRecipeCostForMutationV1({
      portionYield: recipe.portionYield,
      lines: [
        ...recipe.lines,
        {
          id: 'new-line',
          quantity: new Decimal(data.quantity),
          unit: data.unit as Unit,
          rawMaterial,
        },
      ],
    })
    for (const lineCost of calculated.lines.filter(line => line.id !== 'new-line')) {
      await tx.recipeLine.update({ where: { id: lineCost.id }, data: { costPerServing: lineCost.costPerServing } })
    }
    const nextLineCost = calculated.lines.find(line => line.id === 'new-line')!.costPerServing
    const created = await tx.recipeLine.create({
      data: {
        recipeId: recipe.id,
        rawMaterialId: data.rawMaterialId,
        quantity: data.quantity,
        unit: data.unit as Unit,
        costPerServing: nextLineCost,
        displayOrder: Math.max(...recipe.lines.map(line => line.displayOrder), -1) + 1,
        isOptional: data.isOptional || false,
        substituteNotes: data.substituteNotes,
      },
      include: { rawMaterial: true },
    })
    await tx.recipe.update({ where: { id: recipe.id }, data: { totalCost: calculated.costPerPortion } })
    return { recipeLine: created, rawMaterialName: rawMaterial.name, costPerServing: nextLineCost }
  })

  logAction({
    venueId,
    action: 'RECIPE_LINE_ADDED',
    entity: 'RecipeLine',
    entityId: recipeLine.id,
    data: {
      productId,
      ingredient: rawMaterialName,
      quantity: data.quantity,
      unit: data.unit,
      costPerServing: costPerServing.toNumber(),
    },
  })

  return recipeLine
}

/**
 * Update a single recipe line (inline edit). Recomputes costPerServing using
 * post-fix unit conversion + recipe.totalCost. Validates dimensional unit
 * compatibility before saving.
 */
export async function updateRecipeLine(
  venueId: string,
  productId: string,
  recipeLineId: string,
  data: {
    quantity?: number
    unit?: string
    isOptional?: boolean
    substituteNotes?: string | null
  },
  staffId?: string,
) {
  const mutation = await prisma.$transaction(async tx => {
    await acquireRecipeCostGraphVenueLockV1(tx, venueId)
    const recipe = await findAndLockRecipeGraphByProductV1(tx, venueId, productId)
    if (!recipe) throw new AppError(`Recipe not found for product ${productId}`, 404)
    assertRecipeGraphVenueV1(recipe, venueId)

    const line = recipe.lines.find(candidate => candidate.id === recipeLineId)
    if (!line) throw new AppError(`Recipe line not found`, 404)
    const nextUnit = (data.unit ?? line.unit) as Unit
    const nextQuantity = data.quantity ?? line.quantity.toNumber()
    assertRecipeLinesUnitsAreValid([{ rawMaterialId: line.rawMaterialId, unit: nextUnit }], [line.rawMaterial])

    // WHY: The modified input and every untouched line share one post-lock
    // calculation, so aggregate and derived rows commit from the same snapshot.
    const calculated = calculateRecipeCostForMutationV1({
      portionYield: recipe.portionYield,
      lines: recipe.lines.map(candidate =>
        candidate.id === recipeLineId ? { ...candidate, quantity: new Decimal(nextQuantity), unit: nextUnit } : candidate,
      ),
    })
    let updatedLine: any = null
    for (const lineCost of calculated.lines) {
      if (lineCost.id === recipeLineId) {
        updatedLine = await tx.recipeLine.update({
          where: { id: recipeLineId },
          data: {
            quantity: new Decimal(nextQuantity),
            unit: nextUnit,
            isOptional: data.isOptional ?? line.isOptional,
            substituteNotes: data.substituteNotes !== undefined ? data.substituteNotes : line.substituteNotes,
            costPerServing: lineCost.costPerServing,
          },
          include: { rawMaterial: true },
        })
      } else {
        await tx.recipeLine.update({ where: { id: lineCost.id }, data: { costPerServing: lineCost.costPerServing } })
      }
    }
    await tx.recipe.update({ where: { id: recipe.id }, data: { totalCost: calculated.costPerPortion } })
    return {
      updatedLine,
      ingredientName: line.rawMaterial.name,
      oldQuantity: line.quantity.toNumber(),
      nextQuantity,
      oldUnit: line.unit,
      nextUnit,
      oldCost: (line.costPerServing ?? new Decimal(0)).toNumber(),
      newCost: calculated.lines.find(lineCost => lineCost.id === recipeLineId)!.costPerServing.toNumber(),
    }
  })

  logAction({
    venueId,
    staffId,
    action: 'RECIPE_LINE_UPDATED',
    entity: 'RecipeLine',
    entityId: recipeLineId,
    data: {
      productId,
      ingredient: mutation.ingredientName,
      oldQuantity: mutation.oldQuantity,
      newQuantity: mutation.nextQuantity,
      oldUnit: mutation.oldUnit,
      newUnit: mutation.nextUnit,
      oldCostPerServing: mutation.oldCost,
      newCostPerServing: mutation.newCost,
    },
  })

  return mutation.updatedLine
}

/**
 * Remove an ingredient from a recipe
 */
export async function removeRecipeLine(venueId: string, productId: string, recipeLineId: string): Promise<void> {
  const removed = await prisma.$transaction(async tx => {
    await acquireRecipeCostGraphVenueLockV1(tx, venueId)
    const recipe = await findAndLockRecipeGraphByProductV1(tx, venueId, productId)
    if (!recipe) throw new AppError(`Recipe not found for product ${productId}`, 404)
    assertRecipeGraphVenueV1(recipe, venueId)

    const line = recipe.lines.find(candidate => candidate.id === recipeLineId)
    if (!line) throw new AppError(`Recipe line not found`, 404)
    const calculated = calculateRecipeCostForMutationV1({
      portionYield: recipe.portionYield,
      lines: recipe.lines.filter(candidate => candidate.id !== recipeLineId),
    })

    // WHY: Empty remaining graphs are valid zero-cost mutations; readiness
    // separately reports EMPTY_LINES without turning this delete into a 500.
    await tx.recipeLine.delete({ where: { id: recipeLineId } })
    for (const lineCost of calculated.lines) {
      await tx.recipeLine.update({ where: { id: lineCost.id }, data: { costPerServing: lineCost.costPerServing } })
    }
    await tx.recipe.update({ where: { id: recipe.id }, data: { totalCost: calculated.costPerPortion } })
    return {
      ingredient: line.rawMaterial.name,
      quantity: line.quantity.toNumber(),
      unit: line.unit,
      costPerServing: line.costPerServing?.toNumber() ?? 0,
    }
  })

  logAction({
    venueId,
    action: 'RECIPE_LINE_REMOVED',
    entity: 'RecipeLine',
    entityId: recipeLineId,
    data: {
      productId,
      ingredient: removed.ingredient,
      quantity: removed.quantity,
      unit: removed.unit,
      costPerServingRemoved: removed.costPerServing,
    },
  })
}

/**
 * Recalculate recipe cost (useful when ingredient prices change). Updates
 * BOTH Recipe.totalCost and every RecipeLine.costPerServing — the previous
 * version only refreshed the total which left lines stale and showed
 * inconsistent cost breakdowns in the dashboard.
 */
export async function recalculateRecipeCost(recipeId: string): Promise<Recipe> {
  // WHY: This preflight discovers only the Venue lock key. No cost or line
  // value is trusted until Product+Recipe and the graph are locked and reread.
  const preflight = await prisma.recipe.findUnique({
    where: { id: recipeId },
    select: { id: true, product: { select: { venueId: true } } },
  })
  if (!preflight) throw new AppError('Recipe not found', 404)

  const updatedRecipe = await prisma.$transaction(async tx => {
    await acquireRecipeCostGraphVenueLockV1(tx, preflight.product.venueId)
    const locked = await lockRecipeCostGraphRowsV1(tx, preflight.product.venueId, recipeId)
    if (!locked) {
      const live = await tx.recipe.findUnique({ where: { id: recipeId }, select: { product: { select: { venueId: true } } } })
      if (live && live.product.venueId !== preflight.product.venueId) {
        throw new AppError('Recipe venue changed; retry recalculation', 409, true, 'RECIPE_COST_VENUE_CHANGED')
      }
      throw new AppError('Recipe not found', 404)
    }

    const recipe = await tx.recipe.findUnique({
      where: { id: recipeId },
      include: { product: { select: { venueId: true } }, lines: { include: { rawMaterial: true } } },
    })
    if (!recipe) throw new AppError('Recipe not found', 404)
    if (recipe.product.venueId !== preflight.product.venueId) {
      throw new AppError('Recipe venue changed; retry recalculation', 409, true, 'RECIPE_COST_VENUE_CHANGED')
    }
    assertRecipeGraphVenueV1(recipe, preflight.product.venueId)

    // WHY: Legacy mutation and H1 read share this neutral Decimal truth, using
    // only post-lock inputs so totalCost remains cost per portion at commit.
    const calculated = calculateRecipeCostForMutationV1({ lines: recipe.lines, portionYield: recipe.portionYield })
    for (const lc of calculated.lines) {
      await tx.recipeLine.update({ where: { id: lc.id }, data: { costPerServing: lc.costPerServing } })
    }
    return tx.recipe.update({
      where: { id: recipeId },
      data: { totalCost: calculated.costPerPortion },
      include: {
        lines: {
          include: {
            rawMaterial: true,
          },
        },
        product: true,
      },
    })
  })

  return updatedRecipe as any
}

/**
 * Configure a recipe line as a variable ingredient
 * Variable ingredients can be substituted by modifier selections
 * ✅ WORLD-CLASS: Toast/Square pattern for modifier-based substitution
 *
 * @param venueId - Venue ID for authorization
 * @param productId - Product ID that owns the recipe
 * @param recipeLineId - Recipe line to configure
 * @param isVariable - Whether this ingredient is variable (can be substituted)
 * @param linkedModifierGroupId - Modifier group that provides substitution options
 */
export async function configureVariableIngredient(
  venueId: string,
  productId: string,
  recipeLineId: string,
  data: {
    isVariable: boolean
    linkedModifierGroupId?: string | null
  },
) {
  const recipe = await prisma.recipe.findUnique({
    where: { productId },
    include: {
      product: {
        select: { venueId: true },
      },
      lines: true,
    },
  })

  if (!recipe || recipe.product.venueId !== venueId) {
    throw new AppError(`Recipe not found for product ${productId}`, 404)
  }

  const line = recipe.lines.find(l => l.id === recipeLineId)
  if (!line) {
    throw new AppError(`Recipe line not found`, 404)
  }

  // If linking to a modifier group, validate it exists in the venue
  if (data.linkedModifierGroupId) {
    const modifierGroup = await prisma.modifierGroup.findFirst({
      where: {
        id: data.linkedModifierGroupId,
        venueId,
      },
    })

    if (!modifierGroup) {
      throw new AppError(`Modifier group with ID ${data.linkedModifierGroupId} not found in venue`, 404)
    }
  }

  const updatedLine = await prisma.recipeLine.update({
    where: { id: recipeLineId },
    data: {
      isVariable: data.isVariable,
      linkedModifierGroupId: data.linkedModifierGroupId ?? null,
    },
    include: {
      rawMaterial: true,
      linkedModifierGroup: {
        include: {
          modifiers: {
            include: {
              rawMaterial: {
                select: { id: true, name: true, unit: true, currentStock: true },
              },
            },
          },
        },
      },
    },
  })

  return updatedLine
}

/**
 * Get recipe with full modifier inventory configuration
 * Returns recipe lines with their linked modifier groups and raw materials
 */
export async function getRecipeWithInventoryConfig(venueId: string, productId: string) {
  const recipe = await prisma.recipe.findUnique({
    where: { productId },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          price: true,
          venueId: true,
        },
      },
      lines: {
        include: {
          rawMaterial: {
            select: { id: true, name: true, unit: true, currentStock: true, costPerUnit: true },
          },
          linkedModifierGroup: {
            include: {
              modifiers: {
                include: {
                  rawMaterial: {
                    select: { id: true, name: true, unit: true, currentStock: true },
                  },
                },
              },
            },
          },
        },
        orderBy: {
          displayOrder: 'asc',
        },
      },
    },
  })

  if (recipe && recipe.product.venueId !== venueId) {
    throw new AppError('Recipe not found', 404)
  }

  return recipe
}
