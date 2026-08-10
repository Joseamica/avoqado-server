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
