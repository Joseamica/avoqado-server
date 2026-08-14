import { Prisma } from '@prisma/client'

export type CashReconciliationOutcome =
  | 'APPLIED'
  | 'SKIPPED'
  | 'LEGACY_APPLIED'
  | 'IGNORED_DISABLED'
  | 'IGNORED_INVALID'
  | 'IGNORED_OVERFLOW'
  | 'NOT_REQUESTED'

export interface LegacyShiftCloseData {
  cashDeclared: number
  cardDeclared: number
  vouchersDeclared: number
  otherDeclared: number
  notes?: string
}

export interface NormalizedCashReconciliationRequest {
  source: 'NEW' | 'LEGACY' | 'NONE'
  action?: 'COUNTED' | 'SKIPPED'
  outcome: CashReconciliationOutcome
  countedCash?: Prisma.Decimal
  legacyCloseData?: LegacyShiftCloseData
  reason?: string
}

const DECIMAL_10_2_MAX = new Prisma.Decimal('99999999.99')
const CANONICAL_COUNT = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/
const LEGACY_FIELDS = ['cashDeclared', 'cardDeclared', 'vouchersDeclared', 'otherDeclared', 'notes'] as const

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function owns(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function invalidNew(action: 'COUNTED' | 'SKIPPED' | undefined, reason: string): NormalizedCashReconciliationRequest {
  return {
    source: 'NEW',
    ...(action ? { action } : {}),
    outcome: 'IGNORED_INVALID',
    reason,
  }
}

function legacyNumber(value: unknown): number {
  return value == null ? 0 : Number(value)
}

function legacyValue(primary: Record<string, unknown>, fallback: Record<string, unknown>, key: (typeof LEGACY_FIELDS)[number]): unknown {
  return owns(primary, key) ? primary[key] : fallback[key]
}

function legacyData(primary: Record<string, unknown>, fallback: Record<string, unknown>): LegacyShiftCloseData {
  const notes = legacyValue(primary, fallback, 'notes')
  return {
    cashDeclared: legacyNumber(legacyValue(primary, fallback, 'cashDeclared')),
    cardDeclared: legacyNumber(legacyValue(primary, fallback, 'cardDeclared')),
    vouchersDeclared: legacyNumber(legacyValue(primary, fallback, 'vouchersDeclared')),
    otherDeclared: legacyNumber(legacyValue(primary, fallback, 'otherDeclared')),
    notes: typeof notes === 'string' ? notes : undefined,
  }
}

/**
 * Separates the new, explicitly gated reconciliation protocol from the active legacy declaration
 * protocol used by Avoqado Desktop. A present new protocol never falls through to a legacy alias.
 */
export function normalizeCashReconciliationRequest(rawBody: unknown): NormalizedCashReconciliationRequest {
  const body = record(rawBody)
  const nested = record(body.closeData)

  if (owns(body, 'cashReconciliationAction')) {
    const action = body.cashReconciliationAction

    if (action === 'COUNTED') {
      if (typeof body.countedCash !== 'string' || !CANONICAL_COUNT.test(body.countedCash)) {
        return invalidNew('COUNTED', 'countedCash must be a canonical Decimal(10,2) string')
      }

      const countedCash = new Prisma.Decimal(body.countedCash)
      if (countedCash.greaterThan(DECIMAL_10_2_MAX)) {
        return invalidNew('COUNTED', 'countedCash exceeds Decimal(10,2)')
      }

      return { source: 'NEW', action: 'COUNTED', outcome: 'APPLIED', countedCash }
    }

    if (action === 'SKIPPED') {
      const hasConflictingCount = owns(body, 'countedCash') || owns(body, 'cashDeclared') || owns(nested, 'cashDeclared')
      return hasConflictingCount
        ? invalidNew('SKIPPED', 'SKIPPED cannot include a cash count')
        : { source: 'NEW', action: 'SKIPPED', outcome: 'SKIPPED' }
    }

    return invalidNew(undefined, 'cashReconciliationAction is not supported')
  }

  if (owns(body, 'countedCash')) {
    return invalidNew(undefined, 'countedCash requires cashReconciliationAction=COUNTED')
  }

  const hasTopLevelLegacy = LEGACY_FIELDS.some(key => owns(body, key))
  const hasNestedLegacy = LEGACY_FIELDS.some(key => owns(nested, key))
  if (hasTopLevelLegacy || hasNestedLegacy) {
    return {
      source: 'LEGACY',
      outcome: 'LEGACY_APPLIED',
      legacyCloseData: legacyData(body, nested),
    }
  }

  return { source: 'NONE', outcome: 'NOT_REQUESTED' }
}

export interface CashReconciliationCalculation {
  expectedCash: Prisma.Decimal
  difference: Prisma.Decimal
  fitsDifferenceColumn: boolean
}

/** Calculate physical count minus opening float and completed cash payments without JS numbers. */
export function calculateCashReconciliation(
  countedCash: Prisma.Decimal | string | number,
  startingCash: Prisma.Decimal | string | number,
  /** Lo que entró al cajón: ventas en efectivo **+ propina cobrada en efectivo**. */
  cashInDrawer: Prisma.Decimal | string | number,
): CashReconciliationCalculation {
  const expectedCash = new Prisma.Decimal(startingCash).add(new Prisma.Decimal(cashInDrawer))
  const difference = new Prisma.Decimal(countedCash).sub(expectedCash)
  return {
    expectedCash,
    difference,
    fitsDifferenceColumn: difference.absoluteValue().lessThanOrEqualTo(DECIMAL_10_2_MAX),
  }
}
