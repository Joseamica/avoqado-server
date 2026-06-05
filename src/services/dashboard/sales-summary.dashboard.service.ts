/**
 * Sales Summary Dashboard Service
 *
 * Calculates comprehensive sales metrics for venues.
 * Used by the Sales Summary report in the dashboard.
 *
 * Accounting Structure:
 * - grossSales = items + serviceCosts (Order.subtotal + service fees)
 *   Does NOT include taxes or tips (pass-through items)
 * - items: Sum of Order.subtotal (item prices without taxes/tips)
 * - serviceCosts: Service fees, delivery fees (future)
 * - discounts: Total discounts applied
 * - refunds: Total refunded payments
 * - netSales: grossSales - discounts - refunds
 * - deferredSales: Unpaid/partial orders total
 * - taxes: Total taxes collected (pass-through)
 * - tips: Total tips
 *
 * Costs breakdown:
 * - platformFees: Avoqado platform fees (from VenueTransaction.feeAmount)
 * - staffCommissions: Commissions paid to staff (from CommissionCalculation.netCommission)
 *
 * Calculated totals:
 * - totalCollected: netSales + tips - platformFees (actual cash flow)
 * - netProfit: netSales - platformFees - staffCommissions (true venue profit)
 */

import { Prisma } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'

import logger from '@/config/logger'
import { BadRequestError } from '@/errors/AppError'
import { calculateSettlementDate } from '@/services/payments/settlementCalculation.service'
import {
  MINDFORM_NEW_VENUE_ID,
  getLegacyPayments,
  getLegacyPeriodMetrics,
  type LegacyPeriodMetric,
  type LegacyPeriodReportType,
} from '@/services/legacy/qrPayments.legacy.service'
import prisma from '@/utils/prismaClient'
import { sanitizeTimezone } from '@/utils/sanitizeTimezone'

// ============================================================
// Types
// ============================================================

export interface SalesSummaryMetrics {
  // Order-derived metrics — null when filtering by paymentMethod/cardType
  // because Order rows can't be reliably split across payment buckets
  // (a single Order may be paid by multiple Payments with different methods).
  grossSales: number | null
  items: number | null
  serviceCosts: number | null
  discounts: number | null
  refunds: number
  netSales: number | null
  deferredSales: number | null
  taxes: number | null
  tips: number
  // Costs breakdown (for clarity)
  platformFees: number // Avoqado platform fees (from VenueTransaction)
  staffCommissions: number // Commissions paid to staff (from CommissionCalculation)
  // Legacy field for backwards compatibility (= platformFees)
  commissions: number
  totalCollected: number
  // True profit after all costs
  netProfit: number // netSales - platformFees - staffCommissions
  transactionCount: number
}

export interface PaymentMethodBreakdown {
  method: string
  amount: number
  count: number
  percentage: number
}

export interface PaymentMethodDetailedBreakdown {
  bucket: 'CARD' | 'CASH' | 'OTHER' | 'QR_LEGACY'
  amount: number
  count: number
  percentage: number
  tips: number
  refunds: number
  platformFees: number
  subBuckets?: Array<{
    type: 'CREDIT' | 'DEBIT' | 'AMEX' | 'INTERNATIONAL'
    amount: number
    count: number
    percentage: number
    platformFees: number
  }>
}

export interface TimePeriodMetrics {
  period: string // ISO date string or label (e.g., "Monday", "09:00")
  periodLabel?: string // Human-readable label
  metrics: SalesSummaryMetrics
}

export interface MerchantAccountBreakdown {
  merchantAccountId: string
  displayName: string // "Amaena - A" / alias / provider name fallback
  provider: string // "AngelPay (Nexgo)" / "Blumon PAX"
  affiliation: string | null // angelpayAffiliation when present
  collectedOnCard: number // SUM(Payment.amount) — card only (merchantAccountId IS NOT NULL)
  platformFee: number // SUM(TransactionCost.venueChargeAmount)
  netToReceive: number // collectedOnCard - platformFee
  transactionCount: number
  // Soonest estimated settlement for this merchant within the range (Entrega 2);
  // present only when includeSettlementProjection=true. nextDate is YYYY-MM-DD in
  // venue timezone, or null when no settlement config can project these payments.
  estimatedSettlement?: {
    nextDate: string | null
    settlementDays: number | null
  }
}

// Entrega 2 — settlement projection ("¿cuándo cae el dinero?").
// The date-range picker scopes WHICH sales; the calendar shows WHEN that card
// money lands, grouped by settlement date and merchant. Estimate only (rule-based
// until a bank API confirms). Cash is excluded — it is immediate.
export interface SettlementCalendarMerchant {
  merchantAccountId: string
  displayName: string
  platformFee: number
  netToReceive: number
  transactionCount: number
}

export interface SettlementCalendarDay {
  date: string // YYYY-MM-DD settlement date in venue timezone
  status: 'settled' | 'pending' | 'projected' // vs today: past / today / future
  totalNet: number
  byMerchant: SettlementCalendarMerchant[]
}

export interface SalesSummaryResponse {
  dateRange: {
    startDate: Date
    endDate: Date
  }
  reportType: ReportType
  summary: SalesSummaryMetrics
  byPaymentMethod?: PaymentMethodBreakdown[]
  byPaymentMethodDetailed?: PaymentMethodDetailedBreakdown[]
  byPeriod?: TimePeriodMetrics[] // Time-based breakdown
  byMerchantAccount?: MerchantAccountBreakdown[] // additive; present only when includeMerchantBreakdown=true
  settlementCalendar?: SettlementCalendarDay[] // additive; present only when includeSettlementProjection=true
  filtered: boolean
}

export type ReportType = 'summary' | 'hours' | 'days' | 'weeks' | 'months' | 'hourlySum' | 'dailySum'

export type PaymentMethodFilter = 'CASH' | 'CARD' | 'QR_LEGACY' | 'OTHER'
export type CardTypeFilter = 'CREDIT' | 'DEBIT' | 'AMEX' | 'INTERNATIONAL'

export interface SalesSummaryFilters {
  startDate: string
  endDate: string
  groupBy?: 'none' | 'paymentMethod'
  reportType?: ReportType
  timezone?: string
  merchantAccountId?: string
  paymentMethod?: PaymentMethodFilter
  cardType?: CardTypeFilter
  includeMerchantBreakdown?: boolean // additive opt-in; default off preserves existing payload
  includeSettlementProjection?: boolean // additive opt-in; adds settlementCalendar + per-merchant estimatedSettlement
}

// ============================================================
// Payment Filter Helpers
// ============================================================

/**
 * Zeroed summary shell. Used by the QR_LEGACY short-circuit when there is
 * nothing to compute (non-MindForm venue reaching the legacy branch defensively).
 * Order-derived metrics are null to mirror the filtered-view contract.
 */
function emptySummary(): SalesSummaryMetrics {
  return {
    grossSales: null,
    items: null,
    serviceCosts: null,
    discounts: null,
    refunds: 0,
    netSales: null,
    deferredSales: null,
    taxes: null,
    tips: 0,
    platformFees: 0,
    staffCommissions: 0,
    commissions: 0,
    totalCollected: 0,
    netProfit: 0,
    transactionCount: 0,
  }
}

/**
 * Build a legacy-only period metric (order-derived fields null, payment-derived
 * fields filled from the legacy aggregate). Used by the QR_LEGACY short-circuit
 * to populate byPeriod without the native queries. Part of the MindForm QR
 * bridge — delete when native QR ships.
 */
function legacyOnlyMetrics(amount: number, tips: number, count: number): SalesSummaryMetrics {
  return {
    ...emptySummary(),
    tips,
    totalCollected: amount + tips,
    netProfit: amount,
    transactionCount: count,
  }
}

/**
 * Assign each bucket's `percentage` against a tips-INCLUSIVE grand total (the
 * sum of the `amount` fields, which already include tips) and sort by amount
 * descending. Using the same basis as the `amount` field keeps the percentage
 * trustworthy for any consumer and makes the native + legacy-append paths use an
 * identical denominator.
 */
function withPercentages(buckets: PaymentMethodBreakdown[]): PaymentMethodBreakdown[] {
  const grandTotal = buckets.reduce((s, p) => s + p.amount, 0)
  return buckets
    .map(p => ({ ...p, percentage: grandTotal > 0 ? Number(((p.amount / grandTotal) * 100).toFixed(1)) : 0 }))
    .sort((a, b) => b.amount - a.amount)
}

/**
 * Build a Prisma where fragment narrowing payments to a single method/card-type
 * bucket. Mirrors the canonical mapping in `transactionCost.service.ts`
 * (`determineTransactionCardType`) so a payment that counts as AMEX here
 * counts as AMEX everywhere else.
 *
 * QR_LEGACY is handled outside Prisma — see the short-circuit in
 * getSalesSummary. We throw here as defense-in-depth so any direct caller
 * (e.g. a test) gets a clear failure instead of silent zero rows.
 */
export function buildPaymentWhereFilter(paymentMethod?: PaymentMethodFilter, cardType?: CardTypeFilter): Prisma.PaymentWhereInput {
  if (!paymentMethod) return {}

  if (paymentMethod === 'CASH') return { method: 'CASH' }

  if (paymentMethod === 'OTHER') {
    return { method: { in: ['DIGITAL_WALLET', 'BANK_TRANSFER', 'CRYPTOCURRENCY', 'OTHER'] } }
  }

  if (paymentMethod === 'QR_LEGACY') {
    throw new Error('QR_LEGACY should be short-circuited by getSalesSummary, not reach the filter builders')
  }

  // paymentMethod === 'CARD'
  if (!cardType) {
    return { method: { in: ['CREDIT_CARD', 'DEBIT_CARD'] } }
  }

  // ── NULL-safe exclusions (must mirror buildPaymentSqlClause exactly) ──
  // Prisma's scalar `not` and JSON-path `NOT { equals }` BOTH drop rows where
  // the column / JSON key is NULL or absent (SQL `x <> v` and `NOT (NULL = v)`
  // are NULL → excluded). Real payments very often have a NULL cardBrand and a
  // NULL/absent processorData.isInternational, so the naive negation silently
  // dropped the vast majority of CREDIT/DEBIT rows (incident found via
  // /full-testing 2026-06-02: CREDIT 157→20, DEBIT 117→0, negative totals when
  // the Prisma count disagreed with the SQL fee sum). These OR-forms restore
  // the NULL/absent rows so Prisma matches the SQL clause 1:1.
  const notAmexBrand: Prisma.PaymentWhereInput = {
    OR: [{ cardBrand: null }, { cardBrand: { not: 'AMERICAN_EXPRESS' } }],
  }
  const notInternational: Prisma.PaymentWhereInput = {
    OR: [
      { processorData: { equals: Prisma.DbNull } }, // column is SQL NULL
      { processorData: { path: ['isInternational'], equals: Prisma.AnyNull } }, // key absent / JSON null
      { NOT: { processorData: { path: ['isInternational'], equals: true } } }, // present & not true
    ],
  }

  if (cardType === 'INTERNATIONAL') {
    // Positive match — no NULL hazard (only rows explicitly flagged true).
    return {
      method: { in: ['CREDIT_CARD', 'DEBIT_CARD'] },
      processorData: { path: ['isInternational'], equals: true },
    }
  }

  if (cardType === 'AMEX') {
    return {
      method: { in: ['CREDIT_CARD', 'DEBIT_CARD'] },
      cardBrand: 'AMERICAN_EXPRESS',
      AND: [notInternational],
    }
  }

  // CREDIT or DEBIT — exclude AMEX brand and exclude international flag,
  // both NULL-safe so cards with no captured brand / processorData still count.
  return {
    method: cardType === 'CREDIT' ? 'CREDIT_CARD' : 'DEBIT_CARD',
    AND: [notAmexBrand, notInternational],
  }
}

/**
 * SQL twin for raw-SQL queries. Returns " AND <clause>" or "" if no filter.
 * `columnPrefix` is the table alias (e.g. 'p' for "p.method").
 */
export function buildPaymentSqlClause(
  paymentMethod: PaymentMethodFilter | undefined,
  cardType: CardTypeFilter | undefined,
  columnPrefix = '',
): string {
  if (!paymentMethod) return ''

  const c = columnPrefix ? `${columnPrefix}.` : ''
  const pdJson = `${c}"processorData"`
  const pdIsIntl = `(${pdJson}->>'isInternational')::boolean = true`
  const pdNotIntl = `(${pdJson} IS NULL OR (${pdJson}->>'isInternational') IS NULL OR (${pdJson}->>'isInternational')::boolean = false)`

  if (paymentMethod === 'CASH') return ` AND ${c}method = 'CASH'`
  if (paymentMethod === 'OTHER') return ` AND ${c}method IN ('DIGITAL_WALLET','BANK_TRANSFER','CRYPTOCURRENCY','OTHER')`
  if (paymentMethod === 'QR_LEGACY') {
    throw new Error('QR_LEGACY should be short-circuited by getSalesSummary, not reach the filter builders')
  }

  // CARD
  if (!cardType) return ` AND ${c}method IN ('CREDIT_CARD','DEBIT_CARD')`
  if (cardType === 'INTERNATIONAL') return ` AND ${c}method IN ('CREDIT_CARD','DEBIT_CARD') AND ${pdIsIntl}`
  if (cardType === 'AMEX')
    return ` AND ${c}method IN ('CREDIT_CARD','DEBIT_CARD') AND ${c}"cardBrand" = 'AMERICAN_EXPRESS' AND ${pdNotIntl}`

  const method = cardType === 'CREDIT' ? 'CREDIT_CARD' : 'DEBIT_CARD'
  return ` AND ${c}method = '${method}' AND (${c}"cardBrand" IS NULL OR ${c}"cardBrand" <> 'AMERICAN_EXPRESS') AND ${pdNotIntl}`
}

/**
 * SINGLE SOURCE OF TRUTH for how the active (paymentMethod, cardType) filter
 * admits MindForm legacy QR rows. Both the row-level summary merge
 * (legacyMatchesFilter) and the SQL period query (calculateTimePeriodMetrics)
 * derive from this so they can never drift apart.
 *
 * Legacy rows lack processorData.isInternational and a reliable cardBrand, so:
 *   - INTERNATIONAL / AMEX / DEBIT → excluded (legacy can't satisfy them)
 *   - CREDIT or CARD-without-cardType → include card-method legacy rows
 *   - CASH → include cash-method legacy rows
 *   - OTHER → excluded; no filter / QR_LEGACY → include all
 *
 * `method` is the legacy method bucket to keep ('CARD' | 'CASH'); when
 * undefined, all eligible legacy rows are kept.
 */
export function legacyAdmission(
  paymentMethod: PaymentMethodFilter | undefined,
  cardType: CardTypeFilter | undefined,
): { include: boolean; method?: 'CARD' | 'CASH' } {
  if (!paymentMethod) return { include: true }
  if (paymentMethod === 'QR_LEGACY') return { include: true }
  if (paymentMethod === 'CASH') return { include: true, method: 'CASH' }
  if (paymentMethod === 'OTHER') return { include: false }
  // CARD
  if (!cardType || cardType === 'CREDIT') return { include: true, method: 'CARD' }
  return { include: false } // DEBIT / AMEX / INTERNATIONAL
}

/**
 * Row-level twin of legacyAdmission: does THIS legacy payment (already mapped to
 * 'CARD' | 'CASH') match the active filter?
 */
export function legacyMatchesFilter(
  legacyMethod: string,
  paymentMethod: PaymentMethodFilter | undefined,
  cardType: CardTypeFilter | undefined,
): boolean {
  const admission = legacyAdmission(paymentMethod, cardType)
  if (!admission.include) return false
  if (!admission.method) return true
  return legacyMethod === admission.method
}

export type BreakdownBucket = 'CARD' | 'CASH' | 'OTHER' | 'QR_LEGACY'
export type CardSubBucket = 'CREDIT' | 'DEBIT' | 'AMEX' | 'INTERNATIONAL'

/**
 * Classify a payment into a breakdown bucket + optional card sub-bucket.
 * Mirrors determineTransactionCardType in transactionCost.service.ts so a
 * payment that counts as AMEX here counts as AMEX everywhere else: international
 * wins first, then AMEX brand, then the card method (credit/debit).
 */
export function bucketOf(
  method: string,
  cardBrand: string | null,
  isInternational: boolean,
): { bucket: BreakdownBucket; sub?: CardSubBucket } {
  if (method === 'CASH') return { bucket: 'CASH' }
  if (method === 'CREDIT_CARD' || method === 'DEBIT_CARD') {
    if (isInternational) return { bucket: 'CARD', sub: 'INTERNATIONAL' }
    if (cardBrand === 'AMERICAN_EXPRESS') return { bucket: 'CARD', sub: 'AMEX' }
    return { bucket: 'CARD', sub: method === 'CREDIT_CARD' ? 'CREDIT' : 'DEBIT' }
  }
  return { bucket: 'OTHER' }
}

// ============================================================
// Main Service Function
// ============================================================

/**
 * Per-merchant-account card breakdown for the reconciliation view.
 *
 * Card money only: cash payments have merchantAccountId = NULL, so the
 * `IS NOT NULL` predicate naturally excludes them. Fees come from the
 * one-to-one TransactionCost row (paymentId is @unique, so the LEFT JOIN never
 * fans out the payment rows). Mirrors the same venue + createdAt bounds + status
 * the platform-fees raw query uses, so this breakdown sums consistently with the
 * report headline.
 */
export async function computeMerchantAccountBreakdown(
  venueId: string,
  startDate: Date,
  endDate: Date,
): Promise<MerchantAccountBreakdown[]> {
  const rows = await prisma.$queryRaw<Array<{ merchantAccountId: string; collected: number; fee: number; txns: number }>>(
    Prisma.sql`
      SELECT p."merchantAccountId" AS "merchantAccountId",
             COALESCE(SUM(p.amount), 0)::float AS collected,
             COALESCE(SUM(tc."venueChargeAmount"), 0)::float AS fee,
             COUNT(*)::int AS txns
      FROM "Payment" p
      LEFT JOIN "TransactionCost" tc ON tc."paymentId" = p.id
      WHERE p."venueId" = ${venueId}
        AND p."createdAt" >= ${startDate}
        AND p."createdAt" <= ${endDate}
        AND p.status = 'COMPLETED'
        AND p."merchantAccountId" IS NOT NULL
      GROUP BY p."merchantAccountId"
    `,
  )

  if (rows.length === 0) return []

  const accounts = await prisma.merchantAccount.findMany({
    where: { id: { in: rows.map(r => r.merchantAccountId) } },
    select: {
      id: true,
      displayName: true,
      alias: true,
      angelpayAffiliation: true,
      displayOrder: true,
      provider: { select: { name: true } },
    },
  })
  const byId = new Map(accounts.map(a => [a.id, a]))

  return rows
    .map(r => {
      const a = byId.get(r.merchantAccountId)
      const collected = Number(r.collected)
      const fee = Number(r.fee)
      return {
        merchantAccountId: r.merchantAccountId,
        displayName: a?.displayName || a?.alias || 'Comercio',
        provider: a?.provider?.name ?? '',
        affiliation: a?.angelpayAffiliation ?? null,
        collectedOnCard: collected,
        platformFee: fee,
        netToReceive: collected - fee,
        transactionCount: Number(r.txns),
      }
    })
    .sort((x, y) => y.collectedOnCard - x.collectedOnCard)
}

/**
 * Settlement projection (Entrega 2) — "¿cuándo cae el dinero de tarjeta?"
 *
 * Loads the card payments in range, finds the SettlementConfiguration active at
 * each payment's createdAt (matched by effectiveFrom/effectiveTo, NOT just the
 * currently-active row), and projects the settlement date with the same engine
 * Saldo Disponible uses (calculateSettlementDate → business days + MX holidays +
 * cutoff). It then groups by (settlementDate, merchant).
 *
 * Estimate only: a payment with no matching config is skipped (honest "—" — it
 * can't be projected). Cash never enters here (it's immediate). Returns the
 * calendar plus, per merchant, the soonest upcoming settlement date for the
 * breakdown's "Cae" column.
 */
export async function computeSettlementProjection(
  venueId: string,
  startDate: Date,
  endDate: Date,
  venueTimezone: string,
): Promise<{
  calendar: SettlementCalendarDay[]
  nextByMerchant: Map<string, { nextDate: string | null; settlementDays: number | null }>
}> {
  const payments = await prisma.payment.findMany({
    where: {
      venueId,
      status: 'COMPLETED',
      merchantAccountId: { not: null },
      transactionCost: { isNot: null },
      createdAt: { gte: startDate, lte: endDate },
    },
    select: {
      amount: true,
      tipAmount: true,
      createdAt: true,
      merchantAccountId: true,
      transactionCost: {
        select: { transactionType: true, venueChargeAmount: true, venueFixedFee: true },
      },
    },
  })

  if (payments.length === 0) {
    return { calendar: [], nextByMerchant: new Map() }
  }

  const merchantIds = Array.from(new Set(payments.map(p => p.merchantAccountId).filter(Boolean) as string[]))

  // All configs for these merchants — matched per payment by effective window so a
  // historical range uses the rule that was in force then, not today's rule.
  const configs = await prisma.settlementConfiguration.findMany({
    where: { merchantAccountId: { in: merchantIds } },
    select: {
      merchantAccountId: true,
      cardType: true,
      settlementDays: true,
      settlementDayType: true,
      cutoffTime: true,
      cutoffTimezone: true,
      effectiveFrom: true,
      effectiveTo: true,
    },
    orderBy: { effectiveFrom: 'desc' },
  })

  const accounts = await prisma.merchantAccount.findMany({
    where: { id: { in: merchantIds } },
    select: { id: true, displayName: true, alias: true },
  })
  const nameById = new Map(accounts.map(a => [a.id, a.displayName || a.alias || 'Comercio']))

  const todayKey = formatInTimeZone(new Date(), venueTimezone, 'yyyy-MM-dd')

  // dateKey -> merchantId -> accumulator
  const days = new Map<string, Map<string, SettlementCalendarMerchant>>()
  // merchantId -> { dates seen, settlementDays of the matched config }
  const datesByMerchant = new Map<string, { dates: Set<string>; settlementDays: number | null }>()

  for (const p of payments) {
    const tc = p.transactionCost
    const merchantId = p.merchantAccountId
    if (!tc || !merchantId) continue

    // configs is ordered effectiveFrom desc, so the first match is the most recent
    // config whose window contains the payment date.
    const config = configs.find(
      c =>
        c.merchantAccountId === merchantId &&
        c.cardType === tc.transactionType &&
        c.effectiveFrom <= p.createdAt &&
        (c.effectiveTo === null || c.effectiveTo >= p.createdAt),
    )
    if (!config) continue // no rule → can't project honestly; leave it out of the calendar

    const settlementDate = calculateSettlementDate(p.createdAt, {
      settlementDays: config.settlementDays,
      settlementDayType: config.settlementDayType,
      cutoffTime: config.cutoffTime,
      cutoffTimezone: config.cutoffTimezone,
    })
    const dateKey = formatInTimeZone(settlementDate, venueTimezone, 'yyyy-MM-dd')

    const fee = Number(tc.venueChargeAmount) + Number(tc.venueFixedFee)
    const net = Number(p.amount) + Number(p.tipAmount ?? 0) - fee

    if (!days.has(dateKey)) days.set(dateKey, new Map())
    const merchantsForDay = days.get(dateKey)!
    if (!merchantsForDay.has(merchantId)) {
      merchantsForDay.set(merchantId, {
        merchantAccountId: merchantId,
        displayName: nameById.get(merchantId) ?? 'Comercio',
        platformFee: 0,
        netToReceive: 0,
        transactionCount: 0,
      })
    }
    const slot = merchantsForDay.get(merchantId)!
    slot.platformFee += fee
    slot.netToReceive += net
    slot.transactionCount += 1

    const md = datesByMerchant.get(merchantId) ?? { dates: new Set<string>(), settlementDays: config.settlementDays }
    md.dates.add(dateKey)
    md.settlementDays = config.settlementDays
    datesByMerchant.set(merchantId, md)
  }

  const calendar: SettlementCalendarDay[] = Array.from(days.entries())
    .map(([date, merchants]) => {
      const byMerchant = Array.from(merchants.values()).sort((a, b) => b.netToReceive - a.netToReceive)
      const totalNet = byMerchant.reduce((s, m) => s + m.netToReceive, 0)
      const status: SettlementCalendarDay['status'] = date < todayKey ? 'settled' : date === todayKey ? 'pending' : 'projected'
      return { date, status, totalNet, byMerchant }
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  // Per merchant: soonest date that is today-or-future; if all are past, the most recent past date.
  const nextByMerchant = new Map<string, { nextDate: string | null; settlementDays: number | null }>()
  for (const [merchantId, { dates, settlementDays }] of datesByMerchant) {
    const sorted = Array.from(dates).sort()
    const upcoming = sorted.filter(d => d >= todayKey)
    const nextDate = upcoming.length > 0 ? upcoming[0] : sorted.length > 0 ? sorted[sorted.length - 1] : null
    nextByMerchant.set(merchantId, { nextDate, settlementDays })
  }

  return { calendar, nextByMerchant }
}

/**
 * Get sales summary for a venue within a date range
 */
export async function getSalesSummary(venueId: string, filters: SalesSummaryFilters): Promise<SalesSummaryResponse> {
  const {
    startDate,
    endDate,
    groupBy = 'none',
    reportType = 'summary',
    timezone = 'America/Mexico_City',
    merchantAccountId,
    paymentMethod,
    cardType,
  } = filters

  // Validate dates
  const parsedStartDate = new Date(startDate)
  const parsedEndDate = new Date(endDate)

  if (isNaN(parsedStartDate.getTime())) {
    throw new BadRequestError(`Invalid startDate: ${startDate}`)
  }
  if (isNaN(parsedEndDate.getTime())) {
    throw new BadRequestError(`Invalid endDate: ${endDate}`)
  }

  // When a payment-method filter is active, order-derived metrics become
  // misleading (a single order can be paid by mixed methods). We compute only
  // payment-derived metrics and return null for grossSales/items/discounts/
  // taxes/deferred — frontend hides those rows.
  const isFiltered = !!paymentMethod

  // QR_LEGACY short-circuit. This filter only makes sense for MindForm (the one
  // venue with legacy avo-pwa QR payments). We compute the summary directly from
  // the legacy DB and skip the 8 native queries entirely — the native Payment
  // table has no QR_LEGACY rows, and buildPaymentWhereFilter throws on QR_LEGACY.
  if (paymentMethod === 'QR_LEGACY') {
    // Only MindForm has legacy QR data. Controller already rejects QR_LEGACY
    // for other venues; this is defense-in-depth.
    if (venueId !== MINDFORM_NEW_VENUE_ID) {
      return {
        dateRange: { startDate: parsedStartDate, endDate: parsedEndDate },
        reportType,
        summary: emptySummary(),
        filtered: true,
      }
    }

    const { rows: legacyRows } = await getLegacyPayments({
      startDate: parsedStartDate.toISOString(),
      endDate: parsedEndDate.toISOString(),
    })
    const eligible = legacyRows.filter(p => p.status === 'COMPLETED' && p.type !== 'REFUND')
    const amount = eligible.reduce((s, p) => s + Number(p.amount), 0)
    const tips = eligible.reduce((s, p) => s + Number(p.tipAmount), 0)
    const summary: SalesSummaryMetrics = {
      ...emptySummary(),
      tips,
      totalCollected: amount + tips,
      netProfit: amount,
      transactionCount: eligible.length,
    }

    // For a non-summary reportType, build the time-series from legacy alone so
    // the period bars match this legacy-only headline total. Order-derived
    // metrics are null; payment-derived metrics come from the legacy aggregate.
    let byPeriod: TimePeriodMetrics[] | undefined
    if ((reportType as string) !== 'summary') {
      const legacyRowsByPeriod = await getLegacyPeriodMetrics(
        parsedStartDate.toISOString(),
        parsedEndDate.toISOString(),
        reportType as LegacyPeriodReportType,
        timezone, // no methodFilter — all legacy
      )
      const legacyMap = new Map(legacyRowsByPeriod.map(r => [r.periodKey, r]))
      const allPeriods = generateAllPeriods(reportType)
      if (allPeriods.length > 0) {
        // Sum types (hourlySum/dailySum): iterate the fixed 0-23 / 0-6 buckets,
        // filling zeros for periods with no legacy rows.
        byPeriod = allPeriods.map(periodValue => {
          const legacy = legacyMap.get(String(Number(periodValue)))
          return {
            period: formatPeriod(periodValue, reportType, timezone),
            periodLabel: formatPeriodLabel(periodValue, reportType, timezone),
            metrics: legacyOnlyMetrics(legacy?.amount ?? 0, legacy?.tips ?? 0, legacy?.count ?? 0),
          }
        })
      } else {
        // Date types: iterate the legacy period keys (epoch-ms → Date).
        byPeriod = legacyRowsByPeriod.map(r => {
          const periodValue = new Date(Number(r.periodKey))
          return {
            period: formatPeriod(periodValue, reportType, timezone),
            periodLabel: formatPeriodLabel(periodValue, reportType, timezone),
            metrics: legacyOnlyMetrics(r.amount, r.tips, r.count),
          }
        })
      }
    }

    return {
      dateRange: { startDate: parsedStartDate, endDate: parsedEndDate },
      reportType,
      summary,
      byPeriod,
      filtered: true,
    }
  }

  const paymentWhereFilter = buildPaymentWhereFilter(paymentMethod, cardType)
  const paymentLevelFilter = { ...(merchantAccountId ? { merchantAccountId } : {}), ...paymentWhereFilter }

  logger.info('Calculating sales summary', { venueId, startDate, endDate, groupBy, merchantAccountId, paymentMethod, cardType })

  // Base date filter for orders
  const dateFilter = {
    createdAt: {
      gte: parsedStartDate,
      lte: parsedEndDate,
    },
  }

  // When filtering by merchant, we scope orders to only those that have at
  // least one Payment linked to the target merchantAccountId.
  const merchantOrderFilter = merchantAccountId ? { payments: { some: { merchantAccountId } } } : {}

  // Payment-level merchant filter
  const merchantPaymentFilter = merchantAccountId ? { merchantAccountId } : {}

  // Kick off the filtered payment-volume query in parallel with the rest of
  // the core-metric awaits below. We need this number only when deriving
  // totalCollected/netProfit under a filter; awaiting at the derived-metrics
  // block lets the other 8 queries run concurrently with this one.
  const paymentVolumeForFilteredPromise: Promise<number> = isFiltered
    ? prisma.payment
        .aggregate({
          where: { venueId, ...dateFilter, status: 'COMPLETED', ...paymentLevelFilter },
          _sum: { amount: true },
        })
        .then(r => Number(r._sum.amount || 0))
    : Promise.resolve(0)

  // ============================================================
  // Calculate Core Metrics
  // ============================================================

  // 1. Gross Sales - Total from valid orders (exclude drafts, cancelled, deleted, refunded)
  // Skipped under a payment-method filter — orders can't be honestly split per bucket.
  const grossSalesResult = !isFiltered
    ? await prisma.order.aggregate({
        where: {
          venueId,
          ...dateFilter,
          status: { notIn: ['PENDING', 'CANCELLED', 'DELETED'] },
          paymentStatus: { notIn: ['REFUNDED'] },
          ...merchantOrderFilter,
        },
        _sum: {
          total: true,
          subtotal: true,
          taxAmount: true,
          tipAmount: true,
          discountAmount: true,
        },
        _count: true,
      })
    : null

  // 2. Items - Using Order.subtotal (more reliable than OrderItem aggregation
  // because some orders synced from POS don't have OrderItem records)
  // NOTE: items = grossSalesResult._sum.subtotal (already queried above)

  // 3. Refunds — sum of refund Payments (type=REFUND, status=COMPLETED).
  // The legacy query filtered `status='REFUNDED'` which matched a handful of
  // pre-sprint hack records (original Payments flipped to status=REFUNDED with
  // a negative amount) and missed every real refund since the 2026-04 refund
  // sprint, which creates Payments with type=REFUND, status=COMPLETED, negative
  // amount and negative tipAmount (post-2026-04-19 tip split fix).
  const refundsResult = await prisma.payment.aggregate({
    where: {
      venueId,
      ...dateFilter,
      type: 'REFUND',
      ...paymentLevelFilter,
    },
    _sum: {
      amount: true,
      tipAmount: true,
    },
    _count: true,
  })

  // 4. Deferred Sales - Orders with PENDING or PARTIAL payment status
  // Skipped under a payment-method filter (order-derived).
  const deferredResult = !isFiltered
    ? await prisma.order.aggregate({
        where: {
          venueId,
          ...dateFilter,
          status: { notIn: ['PENDING', 'CANCELLED', 'DELETED'] },
          paymentStatus: { in: ['PENDING', 'PARTIAL'] },
          ...merchantOrderFilter,
        },
        _sum: {
          remainingBalance: true,
        },
        _count: true,
      })
    : null

  // 5. Tips - From completed payments (more accurate than order tips)
  const tipsResult = await prisma.payment.aggregate({
    where: {
      venueId,
      ...dateFilter,
      status: 'COMPLETED',
      ...paymentLevelFilter,
    },
    _sum: {
      tipAmount: true,
    },
  })

  // 6. Platform Fees (Avoqado fees) - From TransactionCost.venueChargeAmount
  // (joined via Payment because TransactionCost has no venueId column).
  // VenueTransaction.feeAmount is currently not synced from TransactionCost,
  // so reading the canonical value from TransactionCost avoids reporting $0.
  // The payment-method clause is appended as a SQL fragment from
  // buildPaymentSqlClause — only enum-derived literals (CASH/CREDIT_CARD/etc),
  // never user-supplied strings, so it is safe to concatenate.
  const platformFeesSqlClause = buildPaymentSqlClause(paymentMethod, cardType, 'p')
  const platformFeesMerchantClause = merchantAccountId ? ' AND p."merchantAccountId" = $4' : ''
  const platformFeesQuery = `
    SELECT COALESCE(SUM(tc."venueChargeAmount"), 0)::float AS sum_fee
    FROM "TransactionCost" tc
    JOIN "Payment" p ON p.id = tc."paymentId"
    WHERE p."venueId" = $1
      AND p."createdAt" >= $2
      AND p."createdAt" <= $3
      ${platformFeesMerchantClause}
      ${platformFeesSqlClause}
  `
  const platformFeesParams: Array<string | Date> = merchantAccountId
    ? [venueId, parsedStartDate, parsedEndDate, merchantAccountId]
    : [venueId, parsedStartDate, parsedEndDate]
  const platformFeesRows = await prisma.$queryRawUnsafe<Array<{ sum_fee: number }>>(platformFeesQuery, ...platformFeesParams)

  // 7. Staff Commissions (paid to employees) - From CommissionCalculation
  // CommissionCalculation has paymentId → Payment.merchantAccountId for filtering
  const hasPaymentFilter = !!merchantAccountId || isFiltered
  const staffCommissionsResult = await prisma.commissionCalculation.aggregate({
    where: {
      venueId,
      createdAt: dateFilter.createdAt,
      status: { not: 'VOIDED' },
      ...(hasPaymentFilter ? { payment: paymentLevelFilter } : {}),
    },
    _sum: {
      netCommission: true,
    },
  })

  // 8. Transaction Count - Completed payments
  const transactionCountResult = await prisma.payment.count({
    where: {
      venueId,
      ...dateFilter,
      status: 'COMPLETED',
      ...paymentLevelFilter,
    },
  })

  // ============================================================
  // Calculate Derived Metrics
  // ============================================================

  // Order-derived metrics — null when filtering by paymentMethod/cardType so
  // the frontend hides the rows rather than showing meaningless values.
  // Gross Sales = Item subtotals (Order.subtotal) + service costs
  // Does NOT include taxes or tips (those are shown separately)
  // This follows standard accounting where taxes are pass-through, not revenue
  const grossSales = grossSalesResult ? Number(grossSalesResult._sum.subtotal || 0) : null
  const items = grossSalesResult ? Number(grossSalesResult._sum.subtotal || 0) : null
  const discounts = grossSalesResult ? Number(grossSalesResult._sum.discountAmount || 0) : null
  const taxes = grossSalesResult ? Number(grossSalesResult._sum.taxAmount || 0) : null
  const deferredSales = deferredResult ? Number(deferredResult._sum.remainingBalance || 0) : null
  // Service costs = any revenue beyond item sales (delivery fees, service charges, etc.)
  // Currently no separate serviceCharge field in Order schema, so this is derived
  const serviceCosts = grossSalesResult ? 0 : null

  // Payment-derived metrics — always computed (filter or not).
  // Refund amounts are stored negative on Payment.amount/tipAmount. Sum both so
  // the total includes the tip portion (tip split fix 2026-04-19), take abs so
  // downstream consumers treat "refunds" as a positive magnitude.
  const refunds = Math.abs(Number(refundsResult._sum.amount || 0) + Number(refundsResult._sum.tipAmount || 0))
  const tips = Number(tipsResult._sum.tipAmount || 0)
  const platformFees = Number(platformFeesRows[0]?.sum_fee || 0)
  const staffCommissions = Number(staffCommissionsResult._sum.netCommission || 0)

  // Net Sales = Gross Sales - Discounts - Refunds (null when filtered)
  const netSales = grossSales !== null && discounts !== null ? grossSales - discounts - refunds : null

  // Under filter, derive totalCollected and netProfit from filtered payment
  // volume directly (Payment.amount sum) rather than from netSales. The
  // promise was kicked off near the top of the function so it runs in
  // parallel with the other core-metric queries.
  const paymentVolumeForFiltered = await paymentVolumeForFilteredPromise

  // Total Collected = Net Sales + Tips - Platform Fees
  // Mexico model: taxes are already included in prices, NOT added on top
  // This represents the actual cash flow (money in account after platform fees)
  const totalCollected = isFiltered
    ? paymentVolumeForFiltered + tips - platformFees
    : netSales !== null
      ? netSales + tips - platformFees
      : 0

  // Net Profit = Net Sales - Platform Fees - Staff Commissions
  // This is the true profit after all costs to the venue
  // Note: Tips are NOT subtracted here because they are pass-through to employees
  const netProfit = isFiltered
    ? paymentVolumeForFiltered - platformFees - staffCommissions
    : netSales !== null
      ? netSales - platformFees - staffCommissions
      : 0

  const summary: SalesSummaryMetrics = {
    grossSales,
    items,
    serviceCosts,
    discounts,
    refunds,
    netSales,
    deferredSales,
    taxes,
    tips,
    platformFees,
    staffCommissions,
    commissions: platformFees, // Legacy field for backwards compatibility
    totalCollected,
    netProfit,
    transactionCount: transactionCountResult,
  }

  // ⚠️ MindForm legacy QR bridge. Mirrors the gate in
  // payment.dashboard.service.ts and mergedPayments.service.ts.
  // DELETE this block when the native QR module ships — search the repo for
  // MINDFORM_NEW_VENUE_ID to find every gate.
  let legacyAggregate: { amount: number; tips: number; count: number } | null = null
  if (venueId === MINDFORM_NEW_VENUE_ID) {
    const { rows: legacyRows } = await getLegacyPayments({
      startDate: parsedStartDate.toISOString(),
      endDate: parsedEndDate.toISOString(),
    })
    const eligible = legacyRows.filter(p => p.status === 'COMPLETED' && p.type !== 'REFUND')
    const matching = eligible.filter(p => legacyMatchesFilter(p.method, paymentMethod, cardType))
    legacyAggregate = {
      amount: matching.reduce((s, p) => s + Number(p.amount), 0),
      tips: matching.reduce((s, p) => s + Number(p.tipAmount), 0),
      count: matching.length,
    }

    if (legacyAggregate.count > 0) {
      // Payment-derived totals always include matching legacy volume.
      summary.tips += legacyAggregate.tips
      summary.transactionCount += legacyAggregate.count
      summary.totalCollected += legacyAggregate.amount + legacyAggregate.tips
      summary.netProfit += legacyAggregate.amount

      // Order-derived totals only when NOT filtered (legacy sold real food,
      // so grossSales/netSales should include it on the unfiltered view).
      if (!isFiltered) {
        summary.grossSales = (summary.grossSales ?? 0) + legacyAggregate.amount
        summary.items = (summary.items ?? 0) + legacyAggregate.amount
        summary.netSales = (summary.netSales ?? 0) + legacyAggregate.amount
      }
    }
  }

  // ============================================================
  // Payment Method Breakdown (if requested)
  // ============================================================

  let byPaymentMethod: PaymentMethodBreakdown[] | undefined

  // Skip breakdown under filter — the user already drilled in to one bucket,
  // a single-row breakdown adds no information.
  if (groupBy === 'paymentMethod' && !isFiltered) {
    const paymentsByMethod = await prisma.payment.groupBy({
      by: ['method'],
      where: {
        venueId,
        ...dateFilter,
        status: 'COMPLETED',
        ...merchantPaymentFilter,
      },
      _sum: {
        amount: true,
        tipAmount: true,
      },
      _count: true,
    })

    byPaymentMethod = paymentsByMethod.map(p => ({
      method: p.method,
      amount: Number(p._sum.amount || 0) + Number(p._sum.tipAmount || 0),
      count: p._count,
      percentage: 0, // assigned by withPercentages below
    }))

    // Percentages are computed against a tips-INCLUSIVE grand total (the sum of
    // the `amount` fields, which already include tips) so the field is trustworthy
    // for any consumer (e.g. the mobile controller) — `amount` and its percentage
    // share the same basis. Same helper is reused after the legacy bucket is
    // appended so both paths use an identical denominator.
    byPaymentMethod = withPercentages(byPaymentMethod)

    // Append MindForm's legacy QR volume as its own bucket, then recompute every
    // percentage against the new (larger) grand total so the slices still sum to
    // 100%. Depends on the Part D legacyAggregate block above having populated
    // `legacyAggregate` first.
    if (venueId === MINDFORM_NEW_VENUE_ID && legacyAggregate && legacyAggregate.count > 0) {
      const legacyTotal = legacyAggregate.amount + legacyAggregate.tips
      byPaymentMethod = withPercentages([
        ...(byPaymentMethod ?? []),
        { method: 'QR_LEGACY', amount: legacyTotal, count: legacyAggregate.count, percentage: 0 },
      ])
    }
  }

  // ============================================================
  // Enriched Payment Method Breakdown (Card → Credit/Debit/AMEX/International)
  // ============================================================
  // Surfaces the per-bucket platform commission so a venue owner can SEE that
  // e.g. AMEX really costs ~4.5%. Same gate as byPaymentMethod (only on the
  // unfiltered grouped view — under a filter the user already drilled into one
  // bucket, so a single-bucket breakdown adds nothing).

  let byPaymentMethodDetailed: PaymentMethodDetailedBreakdown[] | undefined

  if (groupBy === 'paymentMethod' && !isFiltered) {
    // Per-bucket and per-sub-bucket accumulator. `amount` INCLUDES tips for
    // consistency with byPaymentMethod (its `amount` is amount+tipAmount).
    type Acc = { amount: number; count: number; tips: number; refunds: number; platformFees: number }
    const newAcc = (): Acc => ({ amount: 0, count: 0, tips: 0, refunds: 0, platformFees: 0 })
    const buckets = new Map<BreakdownBucket, Acc>()
    const subBuckets = new Map<CardSubBucket, Acc>()
    const ensure = <K>(map: Map<K, Acc>, key: K): Acc => {
      let acc = map.get(key)
      if (!acc) {
        acc = newAcc()
        map.set(key, acc)
      }
      return acc
    }

    // (1) Completed payments — one row per payment so we can classify each into
    // its card sub-bucket. (2) Platform fee per payment via TransactionCost
    // joined by paymentId. (3) Refund payments (negative amounts) per bucket.
    const [detailRows, feeRows, refundDetailRows] = await Promise.all([
      prisma.payment.findMany({
        where: { venueId, ...dateFilter, status: 'COMPLETED', ...merchantPaymentFilter },
        select: { id: true, method: true, cardBrand: true, processorData: true, amount: true, tipAmount: true },
      }),
      prisma.$queryRaw<Array<{ payment_id: string; fee: number }>>`
        SELECT tc."paymentId" AS payment_id, tc."venueChargeAmount"::float AS fee
        FROM "TransactionCost" tc
        JOIN "Payment" p ON p.id = tc."paymentId"
        WHERE p."venueId" = ${venueId}
          AND p."createdAt" >= ${parsedStartDate}
          AND p."createdAt" <= ${parsedEndDate}
          AND p."status" = 'COMPLETED'
          ${merchantAccountId ? Prisma.sql`AND p."merchantAccountId" = ${merchantAccountId}` : Prisma.empty}
      `,
      prisma.payment.findMany({
        where: { venueId, ...dateFilter, type: 'REFUND', ...merchantPaymentFilter },
        select: { method: true, cardBrand: true, processorData: true, amount: true, tipAmount: true },
      }),
    ])

    const feeMap = new Map(feeRows.map(f => [f.payment_id, Number(f.fee)]))

    // Completed payments → bucket (+ sub-bucket) accumulators.
    for (const row of detailRows) {
      const isIntl = !!(row.processorData as { isInternational?: boolean } | null)?.isInternational
      const { bucket, sub } = bucketOf(row.method, row.cardBrand, isIntl)
      const amt = Number(row.amount)
      const tip = Number(row.tipAmount)
      const fee = feeMap.get(row.id) ?? 0

      const b = ensure(buckets, bucket)
      b.amount += amt + tip // tips-inclusive, matching byPaymentMethod
      b.tips += tip
      b.count += 1
      b.platformFees += fee

      if (sub) {
        const s = ensure(subBuckets, sub)
        s.amount += amt + tip
        s.tips += tip
        s.count += 1
        s.platformFees += fee
      }
    }

    // Refund payments → bucket refunds (positive magnitude). Refunds aren't
    // attributed down to sub-buckets (the dashboard surfaces refunds at the
    // bucket level only).
    for (const row of refundDetailRows) {
      const isIntl = !!(row.processorData as { isInternational?: boolean } | null)?.isInternational
      const { bucket } = bucketOf(row.method, row.cardBrand, isIntl)
      const b = ensure(buckets, bucket)
      b.refunds += Math.abs(Number(row.amount) + Number(row.tipAmount))
    }

    // MindForm legacy QR → its own QR_LEGACY bucket (no recorded platform fees).
    // legacyAggregate was populated by the Part D block above (declared with let
    // before this block, so it's in scope here). The MINDFORM_NEW_VENUE_ID guard
    // is redundant (legacyAggregate is null otherwise) but kept so the
    // "delete when native QR ships" repo-grep on MINDFORM_NEW_VENUE_ID finds it.
    if (venueId === MINDFORM_NEW_VENUE_ID && legacyAggregate && legacyAggregate.count > 0) {
      const acc = ensure(buckets, 'QR_LEGACY')
      acc.amount += legacyAggregate.amount + legacyAggregate.tips
      acc.tips += legacyAggregate.tips
      acc.count += legacyAggregate.count
    }

    // Grand total = sum of bucket amounts (already tips-inclusive), the same
    // denominator basis byPaymentMethod uses, so percentages are trustworthy.
    const grandTotal = Array.from(buckets.values()).reduce((s, b) => s + b.amount, 0)
    const pct = (part: number, whole: number): number => (whole > 0 ? Number(((part / whole) * 100).toFixed(1)) : 0)

    const bucketOrder: BreakdownBucket[] = ['CARD', 'CASH', 'OTHER', 'QR_LEGACY']
    const subOrder: CardSubBucket[] = ['CREDIT', 'DEBIT', 'AMEX', 'INTERNATIONAL']

    byPaymentMethodDetailed = bucketOrder
      .filter(key => buckets.has(key))
      .map(key => {
        const b = buckets.get(key)!
        const entry: PaymentMethodDetailedBreakdown = {
          bucket: key,
          amount: b.amount,
          count: b.count,
          percentage: pct(b.amount, grandTotal),
          tips: b.tips,
          refunds: b.refunds,
          platformFees: b.platformFees,
        }

        // Attach card sub-buckets (only present types), percentages relative to
        // the CARD bucket total so they sum to ~100 within the card breakdown.
        if (key === 'CARD') {
          const subs = subOrder
            .filter(sk => subBuckets.has(sk))
            .map(sk => {
              const s = subBuckets.get(sk)!
              return {
                type: sk,
                amount: s.amount,
                count: s.count,
                percentage: pct(s.amount, b.amount),
                platformFees: s.platformFees,
              }
            })
          if (subs.length > 0) entry.subBuckets = subs
        }

        return entry
      })
  }

  // ============================================================
  // Time-Period Breakdown (if reportType is not 'summary')
  // ============================================================

  let byPeriod: TimePeriodMetrics[] | undefined

  if (reportType !== 'summary') {
    byPeriod = await calculateTimePeriodMetrics(
      venueId,
      parsedStartDate,
      parsedEndDate,
      reportType,
      timezone,
      merchantAccountId,
      paymentMethod,
      cardType,
    )
  }

  // Per-merchant card breakdown for the reconciliation view (additive; opt-in).
  // Reuses parsedStartDate/parsedEndDate — the same bounds the platform-fees query uses.
  let byMerchantAccount: MerchantAccountBreakdown[] | undefined
  if (filters.includeMerchantBreakdown) {
    byMerchantAccount = await computeMerchantAccountBreakdown(venueId, parsedStartDate, parsedEndDate)
  }

  // Settlement projection (Entrega 2; additive, opt-in). Adds the "¿cuándo cae?"
  // calendar and enriches each merchant row with its soonest settlement date.
  let settlementCalendar: SettlementCalendarDay[] | undefined
  if (filters.includeSettlementProjection) {
    const projection = await computeSettlementProjection(venueId, parsedStartDate, parsedEndDate, timezone)
    settlementCalendar = projection.calendar
    if (byMerchantAccount) {
      byMerchantAccount = byMerchantAccount.map(m => ({
        ...m,
        estimatedSettlement: projection.nextByMerchant.get(m.merchantAccountId) ?? { nextDate: null, settlementDays: null },
      }))
    }
  }

  logger.info('Sales summary calculated', {
    venueId,
    grossSales,
    netSales,
    transactionCount: transactionCountResult,
    reportType,
    periodsCount: byPeriod?.length,
    filtered: isFiltered,
  })

  return {
    dateRange: {
      startDate: parsedStartDate,
      endDate: parsedEndDate,
    },
    reportType,
    summary,
    byPaymentMethod,
    byPaymentMethodDetailed,
    byPeriod,
    byMerchantAccount,
    settlementCalendar,
    filtered: isFiltered,
  }
}

// ============================================================
// Helper: Calculate Time-Period Metrics
// ============================================================

/**
 * Calculate metrics grouped by time period
 */
async function calculateTimePeriodMetrics(
  venueId: string,
  startDate: Date,
  endDate: Date,
  reportType: ReportType,
  timezone: string,
  merchantAccountId?: string,
  paymentMethod?: PaymentMethodFilter,
  cardType?: CardTypeFilter,
): Promise<TimePeriodMetrics[]> {
  // When a payment-method filter is active, order-derived metrics (gross/items/
  // discounts/taxes/deferred) become null and the corresponding raw queries are
  // skipped. Payment-derived queries get the SQL clause appended.
  const isFiltered = !!paymentMethod
  const paymentSqlClause = buildPaymentSqlClause(paymentMethod, cardType)
  const paymentSqlClauseWithPrefix = buildPaymentSqlClause(paymentMethod, cardType, 'p')

  // SECURITY: Sanitize timezone to prevent SQL injection
  const safeTz = sanitizeTimezone(timezone)

  // Determine SQL grouping based on reportType
  let groupByExpression: string
  let orderByExpression: string

  switch (reportType) {
    case 'hours':
      groupByExpression = `DATE_TRUNC('hour', "createdAt" AT TIME ZONE '${safeTz}')`
      orderByExpression = 'period'
      break
    case 'days':
      groupByExpression = `DATE_TRUNC('day', "createdAt" AT TIME ZONE '${safeTz}')`
      orderByExpression = 'period'
      break
    case 'weeks':
      groupByExpression = `DATE_TRUNC('week', "createdAt" AT TIME ZONE '${safeTz}')`
      orderByExpression = 'period'
      break
    case 'months':
      groupByExpression = `DATE_TRUNC('month', "createdAt" AT TIME ZONE '${safeTz}')`
      orderByExpression = 'period'
      break
    case 'hourlySum':
      // Group by hour of day (0-23)
      groupByExpression = `EXTRACT(HOUR FROM "createdAt" AT TIME ZONE '${safeTz}')`
      orderByExpression = 'period'
      break
    case 'dailySum':
      // Group by day of week (0=Sunday, 6=Saturday)
      groupByExpression = `EXTRACT(DOW FROM "createdAt" AT TIME ZONE '${safeTz}')`
      orderByExpression = 'period'
      break
    default:
      return []
  }

  // Optional merchant filter clause for raw SQL queries
  const merchantPaymentClause = merchantAccountId ? `AND "merchantAccountId" = $4` : ''
  const merchantOrderClause = merchantAccountId ? `AND id IN (SELECT "orderId" FROM "Payment" WHERE "merchantAccountId" = $4)` : ''
  const merchantPlatformClause = merchantAccountId ? `AND p."merchantAccountId" = $4` : ''
  const merchantCommissionClause = merchantAccountId ? `AND "paymentId" IN (SELECT id FROM "Payment" WHERE "merchantAccountId" = $4)` : ''

  // Query order metrics grouped by period
  // Using subtotal for gross_sales (not total) to match accounting standards
  const orderMetricsQuery = `
    SELECT
      ${groupByExpression} as period,
      COALESCE(SUM(subtotal), 0) as gross_sales,
      COALESCE(SUM("taxAmount"), 0) as taxes,
      COALESCE(SUM("discountAmount"), 0) as discounts,
      COUNT(*) as order_count
    FROM "Order"
    WHERE "venueId" = $1
      AND "createdAt" >= $2
      AND "createdAt" <= $3
      -- Must mirror the summary grossSales filter (status notIn PENDING/CANCELLED/DELETED)
      -- so the period bars sum to the headline total. Previously this only excluded
      -- CANCELLED, double-counting PENDING/DELETED orders vs the summary card.
      AND status NOT IN ('PENDING', 'CANCELLED', 'DELETED')
      AND "paymentStatus" NOT IN ('REFUNDED')
      ${merchantOrderClause}
    GROUP BY ${groupByExpression}
    ORDER BY ${orderByExpression}
  `

  // Query payment metrics grouped by period — payment-method clause appended
  // before GROUP BY so the filter narrows rows, not groups.
  const paymentMetricsQuery = `
    SELECT
      ${groupByExpression} as period,
      COALESCE(SUM(amount), 0) as payment_amount,
      COALESCE(SUM("tipAmount"), 0) as tips,
      COUNT(*) as transaction_count
    FROM "Payment"
    WHERE "venueId" = $1
      AND "createdAt" >= $2
      AND "createdAt" <= $3
      AND status = 'COMPLETED'
      ${merchantPaymentClause}
      ${paymentSqlClause}
    GROUP BY ${groupByExpression}
    ORDER BY ${orderByExpression}
  `

  // Query refunds grouped by period — REFUND Payments have negative amount and
  // (since 2026-04-19) negative tipAmount. Use ABS so "refunds" is a positive
  // magnitude matching the consumer contract of the non-raw aggregate above.
  const refundsQuery = `
    SELECT
      ${groupByExpression} as period,
      COALESCE(SUM(ABS(amount) + ABS("tipAmount")), 0) as refunds
    FROM "Payment"
    WHERE "venueId" = $1
      AND "createdAt" >= $2
      AND "createdAt" <= $3
      AND type = 'REFUND'
      ${merchantPaymentClause}
      ${paymentSqlClause}
    GROUP BY ${groupByExpression}
    ORDER BY ${orderByExpression}
  `

  // Query deferred sales grouped by period
  const deferredQuery = `
    SELECT
      ${groupByExpression} as period,
      COALESCE(SUM("remainingBalance"), 0) as deferred_sales
    FROM "Order"
    WHERE "venueId" = $1
      AND "createdAt" >= $2
      AND "createdAt" <= $3
      -- Mirror the summary deferred filter (status notIn PENDING/CANCELLED/DELETED).
      AND status NOT IN ('PENDING', 'CANCELLED', 'DELETED')
      AND "paymentStatus" IN ('PENDING', 'PARTIAL')
      ${merchantOrderClause}
    GROUP BY ${groupByExpression}
    ORDER BY ${orderByExpression}
  `

  // Query platform fees (Avoqado fees) grouped by period.
  // Source: TransactionCost.venueChargeAmount joined to Payment for venueId/date.
  // VenueTransaction.feeAmount is not currently synced from TransactionCost.
  const platformFeesGroupBy = groupByExpression.replace(/"createdAt"/g, 'p."createdAt"')
  const platformFeesOrderBy = orderByExpression.replace(/"createdAt"/g, 'p."createdAt"')
  const platformFeesQuery = `
    SELECT
      ${platformFeesGroupBy} as period,
      COALESCE(SUM(tc."venueChargeAmount"), 0) as platform_fees
    FROM "TransactionCost" tc
    JOIN "Payment" p ON p.id = tc."paymentId"
    WHERE p."venueId" = $1
      AND p."createdAt" >= $2
      AND p."createdAt" <= $3
      ${merchantPlatformClause}
      ${paymentSqlClauseWithPrefix}
    GROUP BY ${platformFeesGroupBy}
    ORDER BY ${platformFeesOrderBy}
  `

  // Query staff commissions grouped by period
  // When a payment-method filter is active, also constrain the inner Payment
  // subquery so only commissions for matching payments are aggregated.
  const staffCommissionsPaymentInnerClause = isFiltered ? buildPaymentSqlClause(paymentMethod, cardType) : ''
  const staffCommissionsPaymentSubquery = isFiltered
    ? `AND "paymentId" IN (SELECT id FROM "Payment" WHERE "venueId" = $1 ${staffCommissionsPaymentInnerClause})`
    : ''
  const staffCommissionsQuery = `
    SELECT
      ${groupByExpression} as period,
      COALESCE(SUM("netCommission"), 0) as staff_commissions
    FROM "CommissionCalculation"
    WHERE "venueId" = $1
      AND "createdAt" >= $2
      AND "createdAt" <= $3
      AND status != 'VOIDED'
      ${merchantCommissionClause}
      ${staffCommissionsPaymentSubquery}
    GROUP BY ${groupByExpression}
    ORDER BY ${orderByExpression}
  `

  // Execute all queries in parallel
  // When merchantAccountId is provided, it becomes the 4th parameter ($4) for all queries
  const queryParams: [string, Date, Date, ...string[]] = merchantAccountId
    ? [venueId, startDate, endDate, merchantAccountId]
    : [venueId, startDate, endDate]

  // Under a payment-method filter, skip order-derived queries entirely — their
  // results would be misleading because a single order can't be split per method.
  const [orderMetrics, paymentMetrics, refundsMetrics, deferredMetrics, platformFeesMetrics, staffCommissionsMetrics] = await Promise.all([
    isFiltered
      ? Promise.resolve([] as Array<{ period: Date | number; gross_sales: number; taxes: number; discounts: number; order_count: bigint }>)
      : prisma.$queryRawUnsafe<
          Array<{ period: Date | number; gross_sales: number; taxes: number; discounts: number; order_count: bigint }>
        >(orderMetricsQuery, ...queryParams),
    prisma.$queryRawUnsafe<Array<{ period: Date | number; payment_amount: number; tips: number; transaction_count: bigint }>>(
      paymentMetricsQuery,
      ...queryParams,
    ),
    prisma.$queryRawUnsafe<Array<{ period: Date | number; refunds: number }>>(refundsQuery, ...queryParams),
    isFiltered
      ? Promise.resolve([] as Array<{ period: Date | number; deferred_sales: number }>)
      : prisma.$queryRawUnsafe<Array<{ period: Date | number; deferred_sales: number }>>(deferredQuery, ...queryParams),
    prisma.$queryRawUnsafe<Array<{ period: Date | number; platform_fees: number }>>(platformFeesQuery, ...queryParams),
    prisma.$queryRawUnsafe<Array<{ period: Date | number; staff_commissions: number }>>(staffCommissionsQuery, ...queryParams),
  ])

  // Create maps for quick lookup
  // Use String(Number()) to normalize Decimal/BigInt types from PostgreSQL
  const paymentMap = new Map(paymentMetrics.map(p => [String(Number(p.period)), p]))
  const refundsMap = new Map(refundsMetrics.map(r => [String(Number(r.period)), r]))
  const deferredMap = new Map(deferredMetrics.map(d => [String(Number(d.period)), d]))
  const platformFeesMap = new Map(platformFeesMetrics.map(c => [String(Number(c.period)), c]))
  const staffCommissionsMap = new Map(staffCommissionsMetrics.map(c => [String(Number(c.period)), c]))
  const orderMetricsMap = new Map(orderMetrics.map(o => [String(Number(o.period)), o]))

  // Debug logging for dailySum/hourlySum
  if (reportType === 'dailySum' || reportType === 'hourlySum') {
    logger.info(`[SalesSummary] ${reportType} orderMetrics keys:`, Array.from(orderMetricsMap.keys()))
    logger.info(
      `[SalesSummary] ${reportType} orderMetrics values:`,
      orderMetrics.map(o => ({ period: o.period, gross_sales: o.gross_sales })),
    )
  }

  // ⚠️ MindForm legacy QR bridge — merge legacy QR into the time-series so the
  // period bars sum to the legacy-inclusive headline total. Delete with the
  // rest of the MindForm QR bridge when native QR ships.
  let legacyPeriodMap = new Map<string, LegacyPeriodMetric>()
  if (venueId === MINDFORM_NEW_VENUE_ID && (reportType as string) !== 'summary') {
    // Single source of truth for which legacy rows the active filter admits.
    // QR_LEGACY never reaches here (getSalesSummary short-circuits it).
    const admission = legacyAdmission(paymentMethod, cardType)
    if (admission.include) {
      const legacyRows = await getLegacyPeriodMetrics(
        startDate.toISOString(),
        endDate.toISOString(),
        reportType as LegacyPeriodReportType,
        timezone,
        admission.method,
      )
      legacyPeriodMap = new Map(legacyRows.map(r => [r.periodKey, r]))
    }
  }

  // Generate all periods for summary report types (fill zeros for missing periods)
  const allPeriods = generateAllPeriods(reportType)

  // Combine metrics by period — use allPeriods for summary types (0-23 / 0-6
  // already cover any legacy buckets); otherwise drive from whichever native
  // metric source has rows (payment under filter; order metrics in the default
  // path), then union in any legacy-only periods so they still render.
  let periodsToProcess: Array<Date | number>
  if (allPeriods.length > 0) {
    periodsToProcess = allPeriods
  } else {
    const nativePeriods = isFiltered ? paymentMetrics.map(p => p.period) : orderMetrics.map(o => o.period)
    const seen = new Set(nativePeriods.map(p => String(Number(p))))
    const legacyOnly: Array<Date | number> = []
    for (const key of legacyPeriodMap.keys()) {
      if (!seen.has(key)) legacyOnly.push(new Date(Number(key))) // epoch-ms key → Date for formatPeriod
    }
    periodsToProcess = [...nativePeriods, ...legacyOnly]
  }

  const result: TimePeriodMetrics[] = periodsToProcess.map(periodValue => {
    const periodKey = String(Number(periodValue))
    const order = orderMetricsMap.get(periodKey)
    const payment = paymentMap.get(periodKey)
    const refund = refundsMap.get(periodKey)
    const deferred = deferredMap.get(periodKey)
    const platformFee = platformFeesMap.get(periodKey)
    const staffCommission = staffCommissionsMap.get(periodKey)

    // MindForm legacy QR contribution for this period (0 if none). Folded into
    // the formulas below so each period rolls up to the Part D summary total.
    const legacy = legacyPeriodMap.get(periodKey)
    const legacyAmount = legacy ? legacy.amount : 0
    const legacyTips = legacy ? legacy.tips : 0
    const legacyCount = legacy ? legacy.count : 0

    // Order-derived metrics are null when filtered (order rows can't be honestly
    // split per payment bucket). When NOT filtered, legacy sold real food so its
    // amount folds into grossSales (and therefore items/netSales).
    const grossSales = isFiltered ? null : Number(order?.gross_sales || 0) + legacyAmount
    const discounts = isFiltered ? null : Number(order?.discounts || 0)
    const taxes = isFiltered ? null : Number(order?.taxes || 0)
    const deferredSales = isFiltered ? null : Number(deferred?.deferred_sales || 0)

    // Payment-derived metrics are always present; legacy tips/count always count.
    const refunds = Number(refund?.refunds || 0)
    const tips = Number(payment?.tips || 0) + legacyTips
    const platformFees = Number(platformFee?.platform_fees || 0)
    const staffCommissions = Number(staffCommission?.staff_commissions || 0)
    const paymentAmount = Number(payment?.payment_amount || 0)

    // grossSales already includes legacyAmount (unfiltered), so netSales does too.
    const netSales = grossSales !== null && discounts !== null ? grossSales - discounts - refunds : null

    // Mexico model: taxes are already included in prices, NOT added on top.
    // Total Collected = Net Sales + Tips - Platform Fees (actual cash flow).
    // Under filter, derive from filtered payment volume directly; legacy volume
    // (amount + tips) is added on top in both branches. Note `tips` already
    // includes legacyTips, so only legacyAmount is added explicitly here.
    const totalCollected = isFiltered
      ? paymentAmount + tips - platformFees + legacyAmount
      : netSales !== null
        ? netSales + tips - platformFees
        : 0
    // Net Profit = Net Sales - Platform Fees - Staff Commissions (true profit).
    // netSales already includes legacyAmount when unfiltered; under filter add it.
    const netProfit = isFiltered
      ? paymentAmount - platformFees - staffCommissions + legacyAmount
      : netSales !== null
        ? netSales - platformFees - staffCommissions
        : 0

    return {
      period: formatPeriod(periodValue, reportType, timezone),
      periodLabel: formatPeriodLabel(periodValue, reportType, timezone),
      metrics: {
        grossSales,
        items: grossSales, // Simplified - using grossSales as items proxy
        // serviceCosts: schema has no service-charge column yet; surface 0 when an
        // order exists, null when order metrics are skipped under filter.
        serviceCosts: grossSales !== null ? 0 : null,
        discounts,
        refunds,
        netSales,
        deferredSales,
        taxes,
        tips,
        platformFees,
        staffCommissions,
        commissions: platformFees, // Legacy field for backwards compatibility
        totalCollected,
        netProfit,
        transactionCount: Number(payment?.transaction_count || 0) + legacyCount,
      },
    }
  })

  return result
}

/**
 * Generate all periods for summary report types (to show $0 for missing periods)
 */
function generateAllPeriods(reportType: ReportType): number[] {
  switch (reportType) {
    case 'hourlySum':
      // All 24 hours: 0-23
      return Array.from({ length: 24 }, (_, i) => i)
    case 'dailySum':
      // All 7 days: 0=Sunday to 6=Saturday
      return Array.from({ length: 7 }, (_, i) => i)
    default:
      // For other report types, return empty (use actual data)
      return []
  }
}

/**
 * Format period value for API response
 */
function formatPeriod(period: Date | number, reportType: ReportType, _timezone: string): string {
  if (reportType === 'hourlySum') {
    // Hour of day (0-23)
    return String(period).padStart(2, '0') + ':00'
  }
  if (reportType === 'dailySum') {
    // Day of week (0=Sunday)
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
    return days[Number(period)] || String(period)
  }
  // ISO date string for time-based periods
  if (period instanceof Date) {
    return period.toISOString()
  }
  return String(period)
}

/**
 * Format human-readable period label
 */
function formatPeriodLabel(period: Date | number, reportType: ReportType, timezone: string): string {
  if (reportType === 'hourlySum') {
    const hour = Number(period)
    const suffix = hour >= 12 ? 'PM' : 'AM'
    const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour
    return `${displayHour}:00 ${suffix}`
  }
  if (reportType === 'dailySum') {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    return days[Number(period)] || String(period)
  }
  if (period instanceof Date) {
    // Format based on report type
    const options: Intl.DateTimeFormatOptions = { timeZone: timezone }
    switch (reportType) {
      case 'hours':
        options.hour = '2-digit'
        options.minute = '2-digit'
        options.day = 'numeric'
        options.month = 'short'
        break
      case 'days':
        options.weekday = 'short'
        options.day = 'numeric'
        options.month = 'short'
        break
      case 'weeks':
        options.day = 'numeric'
        options.month = 'short'
        break
      case 'months':
        options.month = 'long'
        options.year = 'numeric'
        break
    }
    return period.toLocaleDateString('es-MX', options)
  }
  return String(period)
}
