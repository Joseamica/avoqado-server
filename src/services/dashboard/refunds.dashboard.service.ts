/**
 * Refunds Report Dashboard Service
 *
 * Lists refunds issued for a venue within a date range. Refunds are stored as
 * `Payment` rows with `type = REFUND` whose `amount`/`tipAmount` are NEGATIVE and
 * whose `processorData` carries `originalPaymentId`, `refundReason` and `note`
 * (see refund.dashboard.service.ts `issueRefund`). This report surfaces them
 * venue-wide for the "Reembolsos" report in the dashboard.
 *
 * Amounts are returned as POSITIVE magnitudes (the report shows "how much was
 * given back"), which is the opposite sign convention from the raw Payment rows.
 */

import { PaymentType, TransactionStatus } from '@prisma/client'

import logger from '@/config/logger'
import { BadRequestError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

// ============================================================
// Types
// ============================================================

export interface RefundsReportFilters {
  startDate: string
  endDate: string
}

export type RefundReason = 'RETURNED_GOODS' | 'ACCIDENTAL_CHARGE' | 'CANCELLED_ORDER' | 'FRAUDULENT_CHARGE' | 'OTHER'

export interface RefundRecord {
  id: string
  createdAt: Date
  orderNumber: string | null
  originalPaymentId: string | null
  method: string
  reason: RefundReason | null
  note: string | null
  saleAmount: number // positive magnitude of the refunded sale portion
  tipAmount: number // positive magnitude of the refunded tip portion
  totalAmount: number // saleAmount + tipAmount
  status: TransactionStatus
  processedByName: string | null
}

export interface RefundsReportResponse {
  dateRange: {
    startDate: Date
    endDate: Date
  }
  refunds: RefundRecord[]
  totals: {
    count: number
    totalRefunded: number
    totalSale: number
    totalTips: number
  }
  byReason: Array<{
    reason: RefundReason | 'UNKNOWN'
    count: number
    amount: number
  }>
}

// ============================================================
// Main Service Function
// ============================================================

/**
 * Get the list of refunds issued for a venue within a date range.
 */
export async function getRefundsReport(venueId: string, filters: RefundsReportFilters): Promise<RefundsReportResponse> {
  const { startDate, endDate } = filters

  const parsedStartDate = new Date(startDate)
  const parsedEndDate = new Date(endDate)

  if (isNaN(parsedStartDate.getTime())) {
    throw new BadRequestError(`Invalid startDate: ${startDate}`)
  }
  if (isNaN(parsedEndDate.getTime())) {
    throw new BadRequestError(`Invalid endDate: ${endDate}`)
  }

  logger.info('Calculating refunds report', { venueId, startDate, endDate })

  const rows = await prisma.payment.findMany({
    where: {
      venueId,
      type: PaymentType.REFUND,
      status: { not: TransactionStatus.PENDING },
      createdAt: { gte: parsedStartDate, lte: parsedEndDate },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      amount: true,
      tipAmount: true,
      status: true,
      method: true,
      createdAt: true,
      processorData: true,
      processedBy: { select: { firstName: true, lastName: true } },
      order: { select: { orderNumber: true } },
    },
  })

  const refunds: RefundRecord[] = rows.map(r => {
    const pd = (r.processorData as Record<string, unknown> | null) || {}
    // Stored amounts are negative for refunds — present positive magnitudes.
    const saleAmount = Math.abs(Number(r.amount))
    const tipAmount = Math.abs(Number(r.tipAmount ?? 0))
    const processedByName = r.processedBy ? `${r.processedBy.firstName} ${r.processedBy.lastName}`.trim() : null

    return {
      id: r.id,
      createdAt: r.createdAt,
      orderNumber: r.order?.orderNumber ?? null,
      originalPaymentId: typeof pd.originalPaymentId === 'string' ? pd.originalPaymentId : null,
      method: r.method,
      reason: typeof pd.refundReason === 'string' ? (pd.refundReason as RefundReason) : null,
      note: typeof pd.note === 'string' ? pd.note : null,
      saleAmount,
      tipAmount,
      totalAmount: saleAmount + tipAmount,
      status: r.status,
      processedByName,
    }
  })

  // Totals
  const totals = refunds.reduce(
    (acc, r) => ({
      count: acc.count + 1,
      totalRefunded: acc.totalRefunded + r.totalAmount,
      totalSale: acc.totalSale + r.saleAmount,
      totalTips: acc.totalTips + r.tipAmount,
    }),
    { count: 0, totalRefunded: 0, totalSale: 0, totalTips: 0 },
  )

  // Breakdown by reason
  const reasonMap = new Map<RefundReason | 'UNKNOWN', { count: number; amount: number }>()
  for (const r of refunds) {
    const key = r.reason ?? 'UNKNOWN'
    const existing = reasonMap.get(key) || { count: 0, amount: 0 }
    existing.count += 1
    existing.amount += r.totalAmount
    reasonMap.set(key, existing)
  }
  const byReason = Array.from(reasonMap.entries())
    .map(([reason, data]) => ({ reason, count: data.count, amount: data.amount }))
    .sort((a, b) => b.amount - a.amount)

  logger.info('Refunds report calculated', { venueId, count: totals.count, totalRefunded: totals.totalRefunded })

  return {
    dateRange: { startDate: parsedStartDate, endDate: parsedEndDate },
    refunds,
    totals,
    byReason,
  }
}
