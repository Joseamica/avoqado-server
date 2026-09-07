import { Unit } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { areUnitsCompatible, convertUnit } from '../../utils/unitConversion'

export type RecipeCostCalculationErrorCode =
  | 'INVALID_PORTION_YIELD'
  | 'INVALID_LINE_QUANTITY'
  | 'INVALID_LINE_COST'
  | 'INCOMPATIBLE_LINE_UNIT'

export class RecipeCostCalculationError extends Error {
  constructor(
    public readonly code: RecipeCostCalculationErrorCode,
    public readonly lineId?: string,
  ) {
    super(code)
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** Smallest quantity RecipeLine.quantity Decimal(12,3) can still store. */
export const MIN_STORABLE_RECIPE_QUANTITY = '0.001'

const RECIPE_QUANTITY_SCALE = 3

/**
 * Would Postgres still hold this quantity once it lands in Decimal(12,3)?
 *
 * A value below 0.0005 is accepted by every "positive number" check and then
 * stored as 0, after which this calculator rejects the line on EVERY later
 * mutation and the recipe can no longer be edited (Testarudo Cafe,
 * 2026-09-04). The Zod schema is the friendly boundary check; this one exists
 * because recipe lines are also written by callers that never see it — the
 * chatbot action engine today, an import or MCP tool tomorrow.
 */
export function storesAsNonzeroRecipeQuantityV1(quantity: Decimal | number | string): boolean {
  const value = new Decimal(quantity)
  return value.isFinite() && value.toDecimalPlaces(RECIPE_QUANTITY_SCALE, Decimal.ROUND_HALF_UP).gt(0)
}

export interface RecipeCostLineDescriptionV1 {
  id: string
  ingredientName: string
}

/**
 * Spanish, actionable text for a cost error raised by an already-persisted
 * graph. The dashboard prints the AppError message verbatim, so a generic
 * "Recipe cost inputs are invalid" left the operator with no way to know which
 * of the existing lines was blocking the save (Testarudo Cafe, 2026-09-04).
 */
export function describeRecipeCostErrorV1(error: RecipeCostCalculationError, lines: readonly RecipeCostLineDescriptionV1[]): string {
  // WHY: A missing name must never degrade into a printed line id — that is
  // noise to the operator and leaks an internal identifier into the UI.
  const ingredient = lines.find(line => line.id === error.lineId)?.ingredientName
  const subject = ingredient ? `"${ingredient}"` : 'uno de los ingredientes'

  switch (error.code) {
    case 'INVALID_PORTION_YIELD':
      return 'El rendimiento de la receta (cuántas porciones salen) debe ser un número entero mayor a 0. Corrígelo en la receta para poder guardar.'
    case 'INVALID_LINE_QUANTITY':
      return `La cantidad de ${subject} en esta receta quedó en 0. Edita ese renglón y ponle al menos ${MIN_STORABLE_RECIPE_QUANTITY}, o quítalo de la receta.`
    case 'INVALID_LINE_COST':
      return `El costo de ${subject} es negativo. Corrígelo en Inventario → Ingredientes para poder guardar la receta.`
    case 'INCOMPATIBLE_LINE_UNIT':
      return `La unidad de ${subject} en la receta no es compatible con la unidad en la que se almacena ese ingrediente (peso con peso, volumen con volumen). Corrige la unidad de ese renglón.`
  }
}

export interface RecipeCostLineV1 {
  id: string
  quantity: Decimal
  unit: Unit
  rawMaterial: {
    unit: Unit
    costPerUnit: Decimal
  }
}

export interface RecipeCostResultV1 {
  batchCost: Decimal
  costPerPortion: Decimal
  lines: Array<{ id: string; costPerServing: Decimal }>
}

const RECIPE_COST_SCALE = 4

function roundRecipeCost(value: Decimal): Decimal {
  // WHY: Recipe and RecipeLine persist Decimal(10,4); explicit HALF_UP makes
  // read-only readiness and legacy recalculation byte-consistent at that edge.
  return value.toDecimalPlaces(RECIPE_COST_SCALE, Decimal.ROUND_HALF_UP)
}

/**
 * Pure recipe-cost truth shared by legacy mutation and H1 readiness reads.
 * Recipe.totalCost is deliberately returned per portion, never per batch.
 */
export function calculateRecipeCostV1(input: { portionYield: number; lines: readonly RecipeCostLineV1[] }): RecipeCostResultV1 {
  // WHY: A zero/fractional yield cannot represent portions and must not be
  // silently replaced with one because that hides invalid PREPARED_DISH data.
  if (!Number.isSafeInteger(input.portionYield) || input.portionYield <= 0) {
    throw new RecipeCostCalculationError('INVALID_PORTION_YIELD')
  }
  const yieldDecimal = new Decimal(input.portionYield.toString())
  let batchCost = new Decimal('0')
  const unroundedLineCosts: Array<{ id: string; costPerServing: Decimal }> = []

  for (const line of input.lines) {
    // WHY: Nonpositive quantities and negative costs must become readiness
    // findings; a zero-cost ingredient remains a valid reviewed business value.
    if (!line.quantity.isFinite() || line.quantity.lte(0)) {
      throw new RecipeCostCalculationError('INVALID_LINE_QUANTITY', line.id)
    }
    if (!line.rawMaterial.costPerUnit.isFinite() || line.rawMaterial.costPerUnit.lt(0)) {
      throw new RecipeCostCalculationError('INVALID_LINE_COST', line.id)
    }
    if (line.unit !== line.rawMaterial.unit && !areUnitsCompatible(line.unit, line.rawMaterial.unit)) {
      throw new RecipeCostCalculationError('INCOMPATIBLE_LINE_UNIT', line.id)
    }

    // WHY: costPerUnit is denominated in the raw-material base unit, so the
    // recipe quantity must be converted before Decimal multiplication.
    const quantityInRawMaterialUnit =
      line.unit === line.rawMaterial.unit ? new Decimal(line.quantity) : convertUnit(line.quantity, line.unit, line.rawMaterial.unit)
    const lineBatchCost = quantityInRawMaterialUnit.mul(line.rawMaterial.costPerUnit)
    batchCost = batchCost.add(lineBatchCost)
    unroundedLineCosts.push({ id: line.id, costPerServing: lineBatchCost.div(yieldDecimal) })
  }

  return {
    batchCost: roundRecipeCost(batchCost),
    costPerPortion: roundRecipeCost(batchCost.div(yieldDecimal)),
    lines: unroundedLineCosts.map(line => ({ ...line, costPerServing: roundRecipeCost(line.costPerServing) })),
  }
}
