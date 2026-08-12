import { CatalogItemStatus, CatalogVenueBindingStatus, Prisma, Unit } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { NotFoundError } from '../../errors/AppError'
import type { PreparedDishReadiness, PreparedDishReadinessDependencies, PreparedDishReadinessFinding } from '../../types/master-catalog'
import { calculateRecipeCostV1, RecipeCostCalculationError } from '../dashboard/recipe-cost-calculator'
import { hashCanonicalJsonV1 } from './catalogHash.service'
import { validateCatalogProductTypeV1 } from './catalogProductType.service'

interface CatalogRecipeLineHashInput {
  id: string
  displayOrder: number
  rawMaterialId: string
  quantity: Decimal
  unit: Unit
  rawMaterial: {
    id?: string
    venueId: string
    unit: Unit
    costPerUnit: Decimal
    active?: boolean
    deletedAt?: Date | null
  }
  // WHY: The field is accepted structurally so callers may pass Prisma rows,
  // but the canonical mapper below deliberately excludes this derived value.
  costPerServing?: Decimal | null
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Hashes only current recipe inputs, never derived diagnostic costs. Sorting by
 * displayOrder/id makes the dependency stable across nondeterministic DB reads.
 */
export function hashCatalogRecipeLinesV1(lines: readonly CatalogRecipeLineHashInput[]): string {
  const canonicalLines = [...lines]
    .sort((left, right) => left.displayOrder - right.displayOrder || compareOrdinal(left.id, right.id))
    .map(line => ({
      id: line.id,
      displayOrder: line.displayOrder,
      rawMaterialId: line.rawMaterialId,
      quantity: line.quantity.toFixed(3),
      unit: line.unit,
      rawMaterialUnit: line.rawMaterial.unit,
      rawMaterialVenueId: line.rawMaterial.venueId,
      rawMaterialCostPerUnit: line.rawMaterial.costPerUnit.toFixed(4),
      rawMaterialActive: line.rawMaterial.active ?? true,
      rawMaterialDeletedAt: line.rawMaterial.deletedAt?.toISOString() ?? null,
    }))

  // WHY: Task 5's namespaced canonical hash prevents Decimal/Date coercion and
  // lets profile/binding previews detect a changed ingredient deterministically.
  return hashCanonicalJsonV1('catalog-recipe-lines', canonicalLines)
}

function dependenciesFor(
  binding: {
    id: string
    revision: number
    catalogItem: { id: string; revision: number }
  },
  productId: string,
  recipe?: { id: string; updatedAt: Date; lines: readonly CatalogRecipeLineHashInput[] } | null,
): PreparedDishReadinessDependencies {
  return {
    bindingId: binding.id,
    bindingRevision: binding.revision,
    catalogItemId: binding.catalogItem.id,
    catalogItemRevision: binding.catalogItem.revision,
    productId,
    recipeId: recipe?.id ?? null,
    recipeUpdatedAt: recipe?.updatedAt.toISOString() ?? null,
    recipeLineHash: recipe ? hashCatalogRecipeLinesV1(recipe.lines) : null,
  }
}

function invalidResult(dependencies: PreparedDishReadinessDependencies, findings: PreparedDishReadinessFinding[]): PreparedDishReadiness {
  return { state: 'INVALID', findings, dependencies }
}

function recipeLineFinding(error: RecipeCostCalculationError): PreparedDishReadinessFinding {
  // WHY: Calculator internals stay neutral; H1 exposes one stable invalid-line
  // finding while preserving a bounded reason for operator diagnostics.
  return {
    code: error.code === 'INVALID_PORTION_YIELD' ? 'INVALID_PORTION_YIELD' : 'INVALID_RECIPE_LINE',
    lineId: error.lineId,
    reason: error.code,
  }
}

async function readCatalogRecipeBinding(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; venueId: string; productId: string },
) {
  return tx.catalogVenueBinding.findFirst({
    where: {
      organizationId: input.organizationId,
      venueId: input.venueId,
      productId: input.productId,
    },
    select: {
      id: true,
      revision: true,
      status: true,
      product: { select: { id: true, venueId: true } },
      catalogItem: { select: { id: true, revision: true, status: true, kind: true, productType: true } },
    },
  })
}

function assertLiveCatalogRecipeBinding(
  binding: Awaited<ReturnType<typeof readCatalogRecipeBinding>>,
  input: { venueId: string; productId: string },
): asserts binding is NonNullable<typeof binding> {
  if (
    !binding ||
    binding.status !== CatalogVenueBindingStatus.LINKED ||
    binding.catalogItem.status !== CatalogItemStatus.ACTIVE ||
    !binding.product ||
    binding.product.id !== input.productId ||
    binding.product.venueId !== input.venueId
  ) {
    // WHY: Pending/unlinked/retired provenance is indistinguishable from a
    // missing tenant target and cannot leak operational readiness details.
    throw new NotFoundError('Binding de catálogo no encontrado')
  }
}

/**
 * Evaluates local Product/Recipe readiness without invoking any mutating legacy
 * recalculation path. The binding composite scope is the tenant boundary.
 */
export async function evaluatePreparedDishBinding(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; venueId: string; productId: string },
): Promise<PreparedDishReadiness> {
  // WHY: One tenant-scoped binding read proves organization, venue, CatalogItem,
  // and Product identity before any local Recipe details are considered.
  const binding = await readCatalogRecipeBinding(tx, input)
  assertLiveCatalogRecipeBinding(binding, input)
  try {
    // WHY: Task 5 owns the closed kind/ProductType matrix; readiness consumes it
    // instead of duplicating semantics that could drift after enum expansion.
    validateCatalogProductTypeV1({ kind: binding.catalogItem.kind, productType: binding.catalogItem.productType })
  } catch {
    return invalidResult(dependenciesFor(binding, input.productId), [{ code: 'PRODUCT_TYPE_INVALID' }])
  }

  // WHY: RETAIL_PRODUCT completeness stops at the corporate baseline and must
  // never acquire Recipe semantics merely because it is packaged food/drink.
  if (binding.catalogItem.kind === 'RETAIL_PRODUCT') {
    return { state: 'READY', findings: [], dependencies: dependenciesFor(binding, input.productId) }
  }

  // WHY: The second statement independently scopes Product.venueId because the
  // binding/Product could move or disappear after the first tenant-safe read.
  const recipe = await tx.recipe.findFirst({
    where: { productId: input.productId, product: { venueId: input.venueId } },
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

  // WHY: Dependencies come from fresh provenance after the Recipe statement;
  // a concurrent revision/status change cannot be returned as an old snapshot.
  const liveBinding = await readCatalogRecipeBinding(tx, input)
  assertLiveCatalogRecipeBinding(liveBinding, input)
  const liveBaseDependencies = dependenciesFor(liveBinding, input.productId)
  try {
    validateCatalogProductTypeV1({ kind: liveBinding.catalogItem.kind, productType: liveBinding.catalogItem.productType })
  } catch {
    return invalidResult(liveBaseDependencies, [{ code: 'PRODUCT_TYPE_INVALID' }])
  }
  if (liveBinding.catalogItem.kind === 'RETAIL_PRODUCT') return { state: 'READY', findings: [], dependencies: liveBaseDependencies }
  if (!recipe) return invalidResult(liveBaseDependencies, [{ code: 'MISSING_RECIPE' }])

  const foreignLine = recipe.lines.find(line => line.rawMaterial.venueId !== input.venueId)
  if (foreignLine) {
    // WHY: Foreign cost/lifecycle data never enters the dependency hash or costs;
    // the base-only result avoids a cross-tenant change oracle.
    return invalidResult(liveBaseDependencies, [
      { code: 'INVALID_RECIPE_LINE', lineId: foreignLine.id, reason: 'RAW_MATERIAL_VENUE_MISMATCH' },
    ])
  }

  const dependencies = dependenciesFor(liveBinding, input.productId, recipe)
  const findings: PreparedDishReadinessFinding[] = []
  if (!Number.isSafeInteger(recipe.portionYield) || recipe.portionYield <= 0) findings.push({ code: 'INVALID_PORTION_YIELD' })
  if (recipe.prepTime === null || !Number.isSafeInteger(recipe.prepTime) || recipe.prepTime <= 0) {
    findings.push({ code: 'MISSING_PREP_TIME', reason: 'PREP_TIME_MUST_BE_POSITIVE_INTEGER' })
  }
  if (recipe.lines.length === 0) findings.push({ code: 'EMPTY_LINES' })

  // WHY: Deleted/inactive ingredients make a line invalid even when its units
  // still convert; readiness reports this without repairing operational data.
  for (const line of recipe.lines) {
    if (!line.rawMaterial.active || line.rawMaterial.deletedAt !== null) {
      findings.push({ code: 'INVALID_RECIPE_LINE', lineId: line.id, reason: 'RAW_MATERIAL_INACTIVE' })
    }
  }
  if (findings.length > 0) return invalidResult(dependencies, findings)

  let calculated
  try {
    calculated = calculateRecipeCostV1({ portionYield: recipe.portionYield, lines: recipe.lines })
  } catch (error) {
    if (error instanceof RecipeCostCalculationError) return invalidResult(dependencies, [recipeLineFinding(error)])
    throw error
  }

  const costs = {
    batchCost: calculated.batchCost.toFixed(4),
    costPerPortion: calculated.costPerPortion.toFixed(4),
    storedCostPerPortion: recipe.totalCost.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
  }

  // WHY: Recipe.totalCost already means cost per portion; dividing it again
  // would make valid batch recipes stale by their portionYield.
  if (!calculated.costPerPortion.eq(new Decimal(costs.storedCostPerPortion))) {
    return { state: 'STALE', findings: [{ code: 'RECIPE_COST_STALE' }], dependencies, costs }
  }

  return { state: 'READY', findings: [], dependencies, costs }
}
