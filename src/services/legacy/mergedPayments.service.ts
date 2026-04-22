/**
 * ⚠️ TEMPORARY TECH DEBT — DELETE WHEN NATIVE QR PAYMENTS SHIP ⚠️
 *
 * Single entry point to read venue payments for analytics (KPIs, charts,
 * settlement aggregations) that need to include MindForm's legacy QR payments
 * stored in the old avo-pwa Postgres database.
 *
 * Why this file exists:
 *   - MindForm's QR flow was built on a separate Postgres DB (legacy avo-pwa).
 *   - Until we migrate it to the native Avoqado QR module, its payments must
 *     still appear in this venue's /home KPIs, pie charts, tips-over-time, etc.
 *   - Without this bridge, MindForm sees incomplete totals in the dashboard.
 *
 * Why centralize it here (instead of copy-pasting `if (isMindForm)` everywhere):
 *   - Exactly ONE place owns the MindForm branch logic.
 *   - The non-MindForm path (~999 other venues) pays the cost of a single
 *     string comparison — the legacy pool (`legacyPool.ts`) stays lazy and
 *     never opens a connection.
 *   - When the native QR module ships, we delete this file + callers revert to
 *     a direct `prisma.payment.findMany` call.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHEN TO DELETE THIS FILE:
 *   Trigger: MindForm migrates to the native Avoqado QR flow and all its
 *   historical legacy payments are either imported into the new `Payment`
 *   table or intentionally retired from analytics.
 *
 *   Steps:
 *     1. Confirm no Payment with id prefix `legacy-` is referenced by any
 *        report, digital receipt, or settlement record.
 *     2. Delete this file (`mergedPayments.service.ts`).
 *     3. Delete `qrPayments.legacy.service.ts` and `legacyPool.ts`.
 *     4. Remove `LEGACY_DATABASE_URL` from `.env` and deployment secrets.
 *     5. Replace each `fetchPaymentsForAnalytics(...)` call with a direct
 *        `prisma.payment.findMany({ where: {...}, select: {...} })`.
 *     6. Remove the MindForm branch in
 *        `src/services/dashboard/payment.dashboard.service.ts` (the
 *        `getLegacyPayments` merge inside the payments list endpoint).
 *     7. Run `npm run pre-deploy` + full regression on MindForm's dashboard.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { Prisma, TransactionStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { MINDFORM_NEW_VENUE_ID, getLegacyPayments } from './qrPayments.legacy.service'

export interface AnalyticsPaymentFilters {
  fromDate: Date
  toDate: Date
  /** Include refund-type payments. Default: false (analytics KPIs exclude refunds). */
  includeRefunds?: boolean
  /** Exclude payments attached to cancelled orders. Default: true. */
  excludeCancelledOrders?: boolean
}

/**
 * Normalized analytics payment shape — superset of fields needed by any /home
 * KPI, chart, or aggregation. Always uses `number` for amounts (Decimal → Number
 * conversion happens here so callers don't repeat it).
 */
export interface AnalyticsPayment {
  id: string
  amount: number
  tipAmount: number
  method: string
  type: string
  status: string
  createdAt: Date
}

/**
 * Fetch all analytics-eligible payments for a venue, merging MindForm's legacy
 * QR payments when applicable. Returns a normalized shape ready for aggregation.
 */
export async function fetchPaymentsForAnalytics(venueId: string, filters: AnalyticsPaymentFilters): Promise<AnalyticsPayment[]> {
  const { fromDate, toDate, includeRefunds = false, excludeCancelledOrders = true } = filters

  const whereClause: Prisma.PaymentWhereInput = {
    venueId,
    status: TransactionStatus.COMPLETED,
    createdAt: { gte: fromDate, lte: toDate },
    ...(includeRefunds ? {} : { type: { not: 'REFUND' } }),
    ...(excludeCancelledOrders ? { order: { status: { not: 'CANCELLED' } } } : {}),
  }

  const newPayments = await prisma.payment.findMany({
    where: whereClause,
    select: {
      id: true,
      amount: true,
      tipAmount: true,
      method: true,
      type: true,
      status: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  })

  const normalized: AnalyticsPayment[] = newPayments.map(p => ({
    id: p.id,
    amount: Number(p.amount),
    tipAmount: Number(p.tipAmount),
    method: String(p.method),
    type: String(p.type),
    status: String(p.status),
    createdAt: p.createdAt,
  }))

  // ⚠️ Gate: short-circuit for non-MindForm venues. DO NOT move this below the
  // `await getLegacyPayments` call — that would force the legacy DB query on
  // ALL venues (and spin up the legacy pool unnecessarily).
  if (venueId !== MINDFORM_NEW_VENUE_ID) {
    return normalized
  }

  logger.info('[MergedPayments] MindForm detected — merging legacy QR payments into analytics', {
    venueId,
    fromDate: fromDate.toISOString(),
    toDate: toDate.toISOString(),
    nativeCount: normalized.length,
  })

  const { rows: legacyRows } = await getLegacyPayments({
    startDate: fromDate.toISOString(),
    endDate: toDate.toISOString(),
  })

  // Apply the same analytics filters to legacy rows (mirrors the where clause
  // above — status=COMPLETED + type != REFUND). The legacy mapper already sets
  // these fields per `mapToPaymentShape` in qrPayments.legacy.service.ts.
  const legacyFiltered = legacyRows.filter(p => {
    if (p.status !== 'COMPLETED') return false
    if (!includeRefunds && p.type === 'REFUND') return false
    return true
  })

  const legacyNormalized: AnalyticsPayment[] = legacyFiltered.map(p => ({
    id: p.id,
    amount: Number(p.amount),
    tipAmount: Number(p.tipAmount),
    method: p.method,
    type: p.type,
    status: p.status,
    createdAt: p.createdAt,
  }))

  logger.info('[MergedPayments] Legacy merge complete', {
    venueId,
    legacyRows: legacyRows.length,
    legacyKept: legacyNormalized.length,
    total: normalized.length + legacyNormalized.length,
  })

  return [...normalized, ...legacyNormalized].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}
