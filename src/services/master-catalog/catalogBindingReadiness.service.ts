import { CatalogItemKind, Prisma } from '@prisma/client'
import type { CatalogBindingDecisionInput, CatalogBindingPreviewLine } from '../../types/master-catalog'
import { calculateRecipeCostV1 } from '../dashboard/recipe-cost-calculator'
import { hashCatalogRecipeLinesV1 } from './catalogRecipeCost.service'

export interface CatalogBindingProspectiveReadiness {
  state: CatalogBindingPreviewLine['readiness']
  dependency: Prisma.InputJsonObject
}

function absenceDependency(productId: string | null, state: 'NOT_REQUIRED' | 'MISSING_RECIPE' | 'INVALID'): Prisma.InputJsonObject {
  return {
    schemaVersion: 1,
    state,
    productId,
    recipeId: null,
    recipeUpdatedAt: null,
    recipeLineHash: null,
    portionYield: null,
    prepTime: null,
    totalCost: null,
  }
}

/**
 * Captures prospective Recipe inputs before provenance exists. This deliberately
 * does not call Task 6, whose tenant boundary requires a persisted LINKED binding.
 */
export async function readCatalogBindingProspectiveReadinessTx(
  tx: Prisma.TransactionClient,
  input: {
    itemKind: CatalogItemKind
    venueId: string
    decision: CatalogBindingDecisionInput | null
    selectedProductId: string | null
  },
): Promise<CatalogBindingProspectiveReadiness> {
  if (input.itemKind !== CatalogItemKind.PREPARED_DISH || !input.decision || input.decision.decision === 'SKIP') {
    return { state: 'NOT_REQUIRED', dependency: absenceDependency(input.selectedProductId, 'NOT_REQUIRED') }
  }
  if (input.decision.decision === 'CREATE') {
    // WHY: A DB-generated Product cannot have a Recipe before this transaction;
    // Task 8 records the reviewed absence and never fabricates operational rows.
    return { state: 'MISSING_RECIPE', dependency: absenceDependency(null, 'MISSING_RECIPE') }
  }
  if (!input.selectedProductId) return { state: 'NOT_REQUIRED', dependency: absenceDependency(null, 'NOT_REQUIRED') }

  const recipe = await tx.recipe.findFirst({
    where: { productId: input.selectedProductId, product: { venueId: input.venueId } },
    select: {
      id: true,
      portionYield: true,
      prepTime: true,
      totalCost: true,
      updatedAt: true,
      lines: {
        orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          displayOrder: true,
          rawMaterialId: true,
          quantity: true,
          unit: true,
          costPerServing: true,
          rawMaterial: {
            select: { id: true, venueId: true, unit: true, costPerUnit: true, active: true, deletedAt: true },
          },
        },
      },
    },
  })
  if (!recipe) {
    return {
      state: 'MISSING_RECIPE',
      dependency: absenceDependency(input.selectedProductId, 'MISSING_RECIPE'),
    }
  }
  // WHY: Task 6 deliberately returns base-only authority for foreign ingredient
  // rows. Excluding their identity/cost avoids both tenant leakage and a hash oracle.
  if (recipe.lines.some(line => line.rawMaterial.venueId !== input.venueId)) {
    return { state: 'INVALID', dependency: absenceDependency(input.selectedProductId, 'INVALID') }
  }
  let state: CatalogBindingPreviewLine['readiness'] = 'READY'
  if (
    !Number.isSafeInteger(recipe.portionYield) ||
    recipe.portionYield <= 0 ||
    recipe.prepTime === null ||
    !Number.isSafeInteger(recipe.prepTime) ||
    recipe.prepTime <= 0 ||
    recipe.lines.length === 0 ||
    recipe.lines.some(line => !line.rawMaterial.active || line.rawMaterial.deletedAt !== null)
  ) {
    state = 'INVALID'
  } else {
    try {
      const calculated = calculateRecipeCostV1({ portionYield: recipe.portionYield, lines: recipe.lines })
      if (calculated.costPerPortion.toFixed(4) !== recipe.totalCost.toFixed(4)) state = 'STALE'
    } catch {
      state = 'INVALID'
    }
  }
  return {
    state,
    dependency: {
      schemaVersion: 1,
      state,
      productId: input.selectedProductId,
      recipeId: recipe.id,
      recipeUpdatedAt: recipe.updatedAt.toISOString(),
      recipeLineHash: hashCatalogRecipeLinesV1(recipe.lines),
      portionYield: recipe.portionYield,
      prepTime: recipe.prepTime,
      totalCost: recipe.totalCost.toFixed(4),
    },
  }
}
