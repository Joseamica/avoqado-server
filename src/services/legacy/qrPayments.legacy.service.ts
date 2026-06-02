/**
 * Legacy QR Payments bridge — reads MindForm payments from the old avo-pwa
 * Postgres database and maps them to the new PaymentWithRelations shape so
 * they can be merged into the unified /payments response.
 *
 * This is a temporary bridge: when the legacy system is decommissioned,
 * delete this file, legacyPool.ts, and the merge call in payment.dashboard.service.ts.
 */

import { Decimal } from '@prisma/client/runtime/library'
import { legacyPool } from './legacyPool'
import logger from '../../config/logger'
import { sanitizeTimezone } from '../../utils/sanitizeTimezone'

// Legacy venue ID in the old DB (hardcoded — single venue)
const LEGACY_MINDFORM_VENUE_ID = 'mindform_prado'

// New venue ID in avoqado-server DB
export const MINDFORM_NEW_VENUE_ID = 'cmisvi38o001fhr2828ygmxi2'

interface LegacyPaymentRow {
  id: string
  amount: string // numeric comes as string from pg
  status: string // ACCEPTED | REJECTED | PENDING | REFUNDED
  method: string | null
  cardBrand: string | null
  last4: string | null
  createdAt: Date
  updatedAt: Date | null
  source: string | null
  splitType: string | null
  tableNumber: number | null
  waiterName: string | null
  currency: string | null
  bank: string | null
  tipAmount: string // from Tip table, 0 if no tip
}

// Status mapping: legacy → new system
function mapStatus(legacyStatus: string): string {
  switch (legacyStatus) {
    case 'ACCEPTED':
      return 'COMPLETED'
    case 'REJECTED':
      return 'FAILED'
    case 'REFUNDED':
      return 'REFUNDED'
    default:
      return 'PENDING'
  }
}

// Method mapping: legacy uses STRIPE as method
function mapMethod(legacyMethod: string | null): string {
  if (!legacyMethod) return 'CARD'
  switch (legacyMethod.toUpperCase()) {
    case 'STRIPE':
      return 'CARD'
    case 'CASH':
      return 'CASH'
    default:
      return 'CARD'
  }
}

/**
 * Maps a raw legacy row into a shape compatible with PaymentWithRelations.
 * Missing relations (processedBy, order, merchantAccount, shift) are set to null.
 */
function mapToPaymentShape(row: LegacyPaymentRow) {
  const amount = new Decimal(row.amount).dividedBy(100) // legacy stores centavos
  const tipAmount = new Decimal(row.tipAmount || '0').dividedBy(100)

  return {
    id: `legacy-${row.id}`,
    venueId: MINDFORM_NEW_VENUE_ID,
    orderId: '',
    shiftId: null,
    processedById: null,
    merchantAccountId: null,
    terminalId: null,
    amount,
    tipAmount,
    method: mapMethod(row.method),
    source: 'QR_LEGACY',
    status: mapStatus(row.status),
    splitType: row.splitType || 'FULLPAYMENT',
    type: 'REGULAR',
    processor: 'stripe',
    processorId: row.id, // Stripe payment intent ID
    processorData: null,
    authorizationNumber: null,
    referenceNumber: null,
    idempotencyKey: null,
    cardBrand: row.cardBrand?.toUpperCase() || null,
    maskedPan: row.last4 ? `************${row.last4}` : null,
    entryMode: 'ECOMMERCE',
    feePercentage: new Decimal(0),
    feeAmount: new Decimal(0),
    netAmount: amount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt || row.createdAt,
    // Relations — null since legacy data lacks these
    processedBy: row.waiterName
      ? { id: 'legacy', firstName: row.waiterName, lastName: '', email: null, photoUrl: null, role: 'WAITER' }
      : null,
    order: row.tableNumber
      ? { id: 'legacy', table: { id: 'legacy', tableNumber: row.tableNumber, label: `Mesa ${row.tableNumber}` } }
      : null,
    shift: null,
    merchantAccount: null,
    transactionCost: null,
    // Flag for frontend to render "QR" badge
    isLegacyQR: true,
  }
}

export interface LegacyPaymentFilters {
  startDate?: string
  endDate?: string
  search?: string
}

/**
 * The full set of `method` values the legacy mapper can emit (see `mapMethod`).
 * Used by `shouldIncludeLegacyPayments` and `filterLegacyRowsByMethodSource` to
 * decide whether a user's method filter could possibly include a legacy row.
 */
export const LEGACY_METHOD_VALUES = ['CASH', 'CARD'] as const

/**
 * The single `source` value the legacy mapper always emits (see `mapToPaymentShape`).
 */
export const LEGACY_SOURCE_VALUE = 'QR_LEGACY' as const

/**
 * Pre-flight check: decide whether the user's method/source filter could match
 * any legacy QR payment. When this returns `false`, the caller should skip the
 * legacy DB round-trip entirely — there is nothing the legacy bridge could
 * contribute to the filtered result.
 *
 * Rules:
 *   - An empty/undefined filter means "no constraint" → include legacy.
 *   - `methods` is satisfied if it intersects `LEGACY_METHOD_VALUES`.
 *   - `sources` is satisfied if it includes `LEGACY_SOURCE_VALUE`.
 *   - Both constraints must pass (logical AND).
 */
export function shouldIncludeLegacyPayments(filter?: { methods?: readonly string[]; sources?: readonly string[] }): boolean {
  if (filter?.methods && filter.methods.length > 0) {
    const intersects = filter.methods.some(m => (LEGACY_METHOD_VALUES as readonly string[]).includes(m))
    if (!intersects) return false
  }
  if (filter?.sources && filter.sources.length > 0) {
    if (!filter.sources.includes(LEGACY_SOURCE_VALUE)) return false
  }
  return true
}

/**
 * Drop legacy rows whose `method` or `source` doesn't match the user's filter.
 * Mirrors what Prisma's `where: { method: { in } }` does for the new-system
 * branch, but applied in JS because legacy values live in a separate DB and the
 * mapping shape is computed in `mapToPaymentShape` (not directly queryable).
 *
 * Returns the input untouched when no method/source filter is active.
 */
export function filterLegacyRowsByMethodSource<T extends { method: string; source: string }>(
  rows: T[],
  filter?: { methods?: readonly string[]; sources?: readonly string[] },
): T[] {
  if (!filter) return rows
  const { methods, sources } = filter
  const hasMethodFilter = methods && methods.length > 0
  const hasSourceFilter = sources && sources.length > 0
  if (!hasMethodFilter && !hasSourceFilter) return rows
  return rows.filter(row => {
    if (hasMethodFilter && !methods!.includes(row.method)) return false
    if (hasSourceFilter && !sources!.includes(row.source)) return false
    return true
  })
}

/**
 * Fetch legacy QR payments for MindForm.
 * Returns { rows, total } to support pagination merge.
 */
export async function getLegacyPayments(
  filters?: LegacyPaymentFilters,
): Promise<{ rows: ReturnType<typeof mapToPaymentShape>[]; total: number }> {
  if (!legacyPool) {
    logger.warn('[LegacyQRPayments] Skipping fetch — legacyPool is null (LEGACY_DATABASE_URL not configured)')
    return { rows: [], total: 0 }
  }

  try {
    // All column refs MUST be prefixed with "p." because the data query joins
    // Tip (which also has `createdAt` and `amount` columns). Without the prefix
    // Postgres throws `column reference "createdAt" is ambiguous` and the
    // whole legacy branch silently returns [].
    const conditions = [`p."venueId" = $1`, `p.status = 'ACCEPTED'`]
    const params: any[] = [LEGACY_MINDFORM_VENUE_ID]
    let paramIdx = 2

    if (filters?.startDate) {
      conditions.push(`p."createdAt" >= $${paramIdx}`)
      params.push(new Date(filters.startDate))
      paramIdx++
    }
    if (filters?.endDate) {
      conditions.push(`p."createdAt" <= $${paramIdx}`)
      params.push(new Date(filters.endDate))
      paramIdx++
    }
    if (filters?.search) {
      conditions.push(`(p.last4 ILIKE $${paramIdx} OR p."waiterName" ILIKE $${paramIdx} OR CAST(p.amount AS TEXT) LIKE $${paramIdx})`)
      params.push(`%${filters.search}%`)
      paramIdx++
    }

    const where = conditions.join(' AND ')

    logger.info('[LegacyQRPayments] Querying legacy DB', {
      venueId: LEGACY_MINDFORM_VENUE_ID,
      startDate: filters?.startDate,
      endDate: filters?.endDate,
      hasSearch: !!filters?.search,
    })

    const [dataResult, countResult] = await Promise.all([
      legacyPool.query(
        // Tip is pre-aggregated by paymentId in a subquery so a payment with
        // multiple Tip rows yields exactly ONE row here (not N duplicates).
        // A bare `LEFT JOIN "Tip"` would emit one row per tip, double-counting
        // amount/tip and inflating rows.length past the COUNT(*) total — and,
        // critically, over-counting the legacy totals merged into the
        // sales-summary report. Keep this in sync with getLegacyPeriodMetrics,
        // which uses the same pre-aggregation.
        `SELECT p.id, p.amount, p.status, p.method, p."cardBrand", p.last4,
                p."createdAt", p."updatedAt", p.source, p."splitType",
                p."tableNumber", p."waiterName", p.currency, p.bank,
                COALESCE(t.amount, 0) AS "tipAmount"
         FROM "Payment" p
         LEFT JOIN (SELECT "paymentId", SUM(amount) AS amount FROM "Tip" GROUP BY "paymentId") t
           ON t."paymentId" = p.id
         WHERE ${where}
         ORDER BY p."createdAt" DESC`,
        params,
      ),
      // Count query uses the same alias `p` so the prefixed WHERE clause works.
      legacyPool.query(`SELECT COUNT(*)::int AS total FROM "Payment" p WHERE ${where}`, params),
    ])

    const rows = dataResult.rows.map(mapToPaymentShape)
    const total = countResult.rows[0]?.total ?? 0

    logger.info('[LegacyQRPayments] Fetched legacy payments', {
      rowCount: rows.length,
      totalMatching: total,
    })

    return { rows, total }
  } catch (err) {
    logger.error('[LegacyQRPayments] Failed to fetch legacy payments', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      filters,
    })
    return { rows: [], total: 0 }
  }
}

export type LegacyPeriodReportType = 'hours' | 'days' | 'weeks' | 'months' | 'hourlySum' | 'dailySum'

export interface LegacyPeriodMetric {
  periodKey: string // String(Number(period)) — matches the native period map key
  amount: number // pesos (legacy centavos / 100)
  tips: number // pesos
  count: number
}

/**
 * Aggregate MindForm legacy QR payments grouped by the SAME time-period
 * expression the native sales-summary uses, so the buckets align 1:1 with the
 * native byPeriod map keys. Uses EXTRACT(EPOCH …)*1000 for date types to match
 * Prisma's UTC interpretation of `timestamp without time zone` across drivers.
 *
 * methodFilter: undefined → all eligible legacy rows; 'CARD' → only card rows;
 * 'CASH' → only cash rows. (Legacy rows are only ever CARD or CASH.)
 *
 * Part of the temporary MindForm QR bridge — delete with the rest when the
 * native QR module ships.
 */
export async function getLegacyPeriodMetrics(
  startDate: string,
  endDate: string,
  reportType: LegacyPeriodReportType,
  timezone: string,
  methodFilter?: 'CARD' | 'CASH',
): Promise<LegacyPeriodMetric[]> {
  if (!legacyPool) {
    logger.warn('[LegacyQRPayments] getLegacyPeriodMetrics skipped — legacyPool is null')
    return []
  }
  const tz = sanitizeTimezone(timezone)

  let periodExpr: string
  switch (reportType) {
    case 'hours':
      periodExpr = `(EXTRACT(EPOCH FROM DATE_TRUNC('hour',  p."createdAt" AT TIME ZONE '${tz}')) * 1000)::bigint`
      break
    case 'days':
      periodExpr = `(EXTRACT(EPOCH FROM DATE_TRUNC('day',   p."createdAt" AT TIME ZONE '${tz}')) * 1000)::bigint`
      break
    case 'weeks':
      periodExpr = `(EXTRACT(EPOCH FROM DATE_TRUNC('week',  p."createdAt" AT TIME ZONE '${tz}')) * 1000)::bigint`
      break
    case 'months':
      periodExpr = `(EXTRACT(EPOCH FROM DATE_TRUNC('month', p."createdAt" AT TIME ZONE '${tz}')) * 1000)::bigint`
      break
    case 'hourlySum':
      periodExpr = `EXTRACT(HOUR FROM p."createdAt" AT TIME ZONE '${tz}')::int`
      break
    case 'dailySum':
      periodExpr = `EXTRACT(DOW FROM p."createdAt" AT TIME ZONE '${tz}')::int`
      break
    default:
      return []
  }

  // Legacy method values: 'STRIPE'/null → CARD, 'CASH' → CASH (see mapMethod).
  const conditions = [`p."venueId" = $1`, `p.status = 'ACCEPTED'`, `p."createdAt" >= $2`, `p."createdAt" <= $3`]
  if (methodFilter === 'CASH') conditions.push(`UPPER(COALESCE(p.method, '')) = 'CASH'`)
  if (methodFilter === 'CARD') conditions.push(`UPPER(COALESCE(p.method, '')) <> 'CASH'`)
  const where = conditions.join(' AND ')

  // Tips are aggregated in a subquery (≤1 row per payment) so that SUM(p.amount)
  // can never be inflated by a payment that happens to carry multiple Tip rows.
  const sql = `
    SELECT ${periodExpr} AS period,
           COALESCE(SUM(p.amount), 0) AS amount_centavos,
           COALESCE(SUM(COALESCE(t.amt, 0)), 0) AS tip_centavos,
           COUNT(*)::int AS count
    FROM "Payment" p
    LEFT JOIN (SELECT "paymentId", SUM(amount) AS amt FROM "Tip" GROUP BY "paymentId") t
      ON t."paymentId" = p.id
    WHERE ${where}
    GROUP BY ${periodExpr}
  `
  try {
    const res = await legacyPool.query(sql, [LEGACY_MINDFORM_VENUE_ID, new Date(startDate), new Date(endDate)])
    return res.rows.map((r: any) => ({
      periodKey: String(Number(r.period)),
      amount: Number(r.amount_centavos) / 100,
      tips: Number(r.tip_centavos) / 100,
      count: Number(r.count),
    }))
  } catch (err) {
    logger.error('[LegacyQRPayments] getLegacyPeriodMetrics failed', { error: err instanceof Error ? err.message : String(err) })
    return []
  }
}
