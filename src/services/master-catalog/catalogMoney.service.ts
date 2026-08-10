import { Prisma } from '@prisma/client'

const ORDINARY_SIGNED_DECIMAL = /^-?\d+(?:\.\d+)?$/
const ORDINARY_CATALOG_MONEY = /^\d+(?:\.\d{1,2})?$/
const MAX_CATALOG_MONEY = new Prisma.Decimal('99999999.99')

function invalidMoney(): never {
  throw new Error('CATALOG_MONEY_INVALID')
}

function invalidDecimal(): never {
  throw new Error('CATALOG_DECIMAL_INVALID')
}

/**
 * WHY: Canonicalizes a Decimal without crossing JavaScript number or rounding.
 * Rejecting excess precision keeps hashes and persisted monetary values equal.
 */
export function canonicalCatalogDecimal(input: string | Prisma.Decimal, scale: number): string {
  if (!Number.isInteger(scale) || scale < 0 || scale > 20) invalidDecimal()

  if (typeof input === 'string' && !ORDINARY_SIGNED_DECIMAL.test(input)) invalidDecimal()
  if (typeof input !== 'string' && !Prisma.Decimal.isDecimal(input)) invalidDecimal()

  let decimal: Prisma.Decimal
  try {
    decimal = Prisma.Decimal.isDecimal(input) ? input : new Prisma.Decimal(input)
  } catch {
    return invalidDecimal()
  }

  if (!decimal.isFinite() || decimal.decimalPlaces() > scale) invalidDecimal()
  return decimal.toFixed(scale)
}

/**
 * WHY: Accepts only the new API's string wire contract. Spreadsheet exponents,
 * separators, signs, floats, and wider values cannot be silently reinterpreted.
 */
export function parseCatalogMoney(input: unknown): string {
  if (typeof input !== 'string' || !ORDINARY_CATALOG_MONEY.test(input)) invalidMoney()

  let decimal: Prisma.Decimal
  try {
    decimal = new Prisma.Decimal(input)
  } catch {
    return invalidMoney()
  }

  if (!decimal.isFinite() || decimal.isNegative() || decimal.greaterThan(MAX_CATALOG_MONEY)) invalidMoney()
  return canonicalCatalogDecimal(decimal, 2)
}
