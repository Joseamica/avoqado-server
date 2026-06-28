/**
 * Cash Out — pure domain logic (no DB, no I/O).
 *
 * The high-risk "are we computing the right thing" core of the PlayTelecom
 * same-day commission feature: venue-local business dates (host-tz-independent),
 * the Lun–Dom escalation week, and escalated-tier selection. Kept pure so it is
 * exhaustively unit-testable. See Avoqado-HQ/specs/2026-06-25-cash-out-promoter-commissions.md
 */
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'

export type CashOutSaleType = 'LINEA_NUEVA' | 'PORTABILIDAD'

/**
 * The venue-local calendar date ('yyyy-MM-dd') of a timestamp.
 * Host-tz-independent: uses the venue's timezone, never the Node host's (prod
 * runs UTC — see .claude/rules/critical-warnings.md timezone trap).
 */
export function venueBusinessDate(at: Date, timeZone: string): string {
  return formatInTimeZone(at, timeZone, 'yyyy-MM-dd')
}

/**
 * The Monday ('yyyy-MM-dd') of the Lun–Dom week containing `businessDate`.
 * Pure UTC arithmetic on a date-only string — host-tz-independent.
 */
export function weekStartMonday(businessDate: string): string {
  const d = new Date(`${businessDate}T00:00:00.000Z`)
  const day = d.getUTCDay() // 0=Sun .. 6=Sat
  const daysToSubtract = (day + 6) % 7 // Mon→0, Tue→1, … Sun→6
  d.setUTCDate(d.getUTCDate() - daysToSubtract)
  return d.toISOString().slice(0, 10)
}

export interface RateTier {
  saleType: CashOutSaleType
  minCount: number
  maxCount: number | null // null = open-ended top tier
  amount: number
}

/**
 * The escalated-commission tier that applies to the Nth (`salesCount`, 1-based)
 * approved sale of the week, for a given sale type. Returns `undefined` when no
 * tier matches — the caller MUST handle that (never silently pay $0).
 * If tiers overlap, the most specific (highest `minCount`) wins.
 */
export function selectRateTier<T extends { saleType: CashOutSaleType; minCount: number; maxCount: number | null }>(
  rates: T[],
  saleType: CashOutSaleType,
  salesCount: number,
): T | undefined {
  return rates
    .filter(r => r.saleType === saleType && r.minCount <= salesCount && (r.maxCount == null || salesCount <= r.maxCount))
    .sort((a, b) => b.minCount - a.minCount)[0]
}

export interface CommissionEntryInput {
  saleVerificationId: string
  venueId: string
  staffId: string
  isPortabilidad: boolean
  saleAt: Date
  timeZone: string
  rates: RateTier[]
  priorWeekCount: number // approved sales by this promoter earlier in the same Lun–Dom week
}

export interface CommissionEntryDraft {
  saleVerificationId: string
  venueId: string
  staffId: string
  saleType: CashOutSaleType
  businessDate: string
  weekStart: string
  tier: number
  amount: number
}

/**
 * Transform a COMPLETED sale into a locked commission ledger entry: maps the
 * sale type, computes the venue-local business date + its Lun–Dom week, and
 * locks the escalated tier/amount for the (priorWeekCount + 1)-th sale of the
 * week. Throws if no tier matches — the amount must never be silently $0.
 */
export function buildCommissionEntry(input: CommissionEntryInput): CommissionEntryDraft {
  const saleType: CashOutSaleType = input.isPortabilidad ? 'PORTABILIDAD' : 'LINEA_NUEVA'
  const businessDate = venueBusinessDate(input.saleAt, input.timeZone)
  const weekStart = weekStartMonday(businessDate)
  const salesCount = input.priorWeekCount + 1
  const tierRow = selectRateTier(input.rates, saleType, salesCount)
  if (!tierRow) {
    throw new Error(`No cash-out commission tier for ${saleType} sale #${salesCount} (venue ${input.venueId})`)
  }
  return {
    saleVerificationId: input.saleVerificationId,
    venueId: input.venueId,
    staffId: input.staffId,
    saleType,
    businessDate,
    weekStart,
    tier: salesCount,
    amount: tierRow.amount,
  }
}

/** Whether the cash-out scheme is active on the given venue-local day (ADMIN day-selection). */
export function isSchemeActiveOn(activeDays: string[], businessDate: string): boolean {
  return activeDays.includes(businessDate)
}

/**
 * Validate an escalated rate table BEFORE saving it, so a misconfiguration is
 * caught in the dashboard rather than producing a wrong/no payout later. Each
 * sale type's tiers must form a contiguous ladder that starts at 1 and ends in
 * an open-ended top tier. Returns Spanish error messages ([] = valid).
 */
export function validateRateTable(rates: RateTier[]): string[] {
  const errors: string[] = []
  const bySaleType = new Map<CashOutSaleType, RateTier[]>()

  for (const r of rates) {
    if (r.minCount < 1) errors.push(`${r.saleType}: el inicio del tramo debe ser ≥ 1 (recibido ${r.minCount}).`)
    if (r.maxCount != null && r.maxCount < r.minCount)
      errors.push(`${r.saleType}: el máximo (${r.maxCount}) no puede ser menor que el mínimo (${r.minCount}).`)
    if (r.amount < 0) errors.push(`${r.saleType}: la comisión no puede ser negativa (${r.amount}).`)
    const list = bySaleType.get(r.saleType) ?? []
    list.push(r)
    bySaleType.set(r.saleType, list)
  }

  for (const [saleType, list] of bySaleType) {
    const sorted = [...list].sort((a, b) => a.minCount - b.minCount)
    if (sorted[0].minCount !== 1) {
      errors.push(`${saleType}: la tabla debe empezar en 1 venta acumulada (empieza en ${sorted[0].minCount}).`)
    }
    for (let i = 0; i < sorted.length - 1; i++) {
      const cur = sorted[i]
      const next = sorted[i + 1]
      if (cur.maxCount == null) {
        errors.push(`${saleType}: el tramo abierto (sin máximo) debe ser el último.`)
        break
      }
      if (next.minCount !== cur.maxCount + 1) {
        errors.push(`${saleType}: hueco o traslape entre el tramo que termina en ${cur.maxCount} y el que empieza en ${next.minCount}.`)
      }
    }
    if (sorted[sorted.length - 1].maxCount != null) {
      errors.push(`${saleType}: el último tramo debe quedar abierto (sin máximo) para cubrir cualquier número de ventas.`)
    }
  }

  return errors
}

/**
 * The UTC half-open range [gte, lt) for a venue-local Lun–Dom week, used to
 * query `SaleVerification.createdAt` (stored in UTC) by venue-local week.
 * `weekStart` is the Monday as 'yyyy-MM-dd' (from weekStartMonday). Converts the
 * venue-local midnight boundaries to real UTC via fromZonedTime (host-tz-safe).
 */
export function weekRangeUtc(weekStart: string, timeZone: string): { gte: Date; lt: Date } {
  const next = new Date(`${weekStart}T00:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + 7)
  const nextStr = next.toISOString().slice(0, 10)
  return {
    gte: fromZonedTime(`${weekStart}T00:00:00.000`, timeZone),
    lt: fromZonedTime(`${nextStr}T00:00:00.000`, timeZone),
  }
}
