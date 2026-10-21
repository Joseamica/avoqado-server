import { Unit } from '@prisma/client'

/** Only unambiguous SAT units. Boxes/bags need an explicitly chosen purchase presentation. */
export function invoicePurchaseUnit(claveUnidad: string | null): Unit | null {
  const units: Record<string, Unit> = {
    KGM: Unit.KILOGRAM,
    GRM: Unit.GRAM,
    LTR: Unit.LITER,
    MLT: Unit.MILLILITER,
    H87: Unit.PIECE,
    C62: Unit.UNIT,
  }
  return claveUnidad ? (units[claveUnidad.toUpperCase()] ?? null) : null
}
