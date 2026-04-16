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
 * Fetch legacy QR payments for MindForm.
 * Returns { rows, total } to support pagination merge.
 */
export async function getLegacyPayments(
  filters?: LegacyPaymentFilters,
): Promise<{ rows: ReturnType<typeof mapToPaymentShape>[]; total: number }> {
  if (!legacyPool) {
    return { rows: [], total: 0 }
  }

  try {
    const conditions = [`"venueId" = $1`, `status = 'ACCEPTED'`]
    const params: any[] = [LEGACY_MINDFORM_VENUE_ID]
    let paramIdx = 2

    if (filters?.startDate) {
      conditions.push(`"createdAt" >= $${paramIdx}`)
      params.push(new Date(filters.startDate))
      paramIdx++
    }
    if (filters?.endDate) {
      conditions.push(`"createdAt" <= $${paramIdx}`)
      params.push(new Date(filters.endDate))
      paramIdx++
    }
    if (filters?.search) {
      conditions.push(`(last4 ILIKE $${paramIdx} OR "waiterName" ILIKE $${paramIdx} OR CAST(amount AS TEXT) LIKE $${paramIdx})`)
      params.push(`%${filters.search}%`)
      paramIdx++
    }

    const where = conditions.join(' AND ')

    const [dataResult, countResult] = await Promise.all([
      legacyPool.query(
        `SELECT p.id, p.amount, p.status, p.method, p."cardBrand", p.last4,
                p."createdAt", p."updatedAt", p.source, p."splitType",
                p."tableNumber", p."waiterName", p.currency, p.bank,
                COALESCE(t.amount, 0) AS "tipAmount"
         FROM "Payment" p
         LEFT JOIN "Tip" t ON t."paymentId" = p.id
         WHERE ${where}
         ORDER BY p."createdAt" DESC`,
        params,
      ),
      legacyPool.query(`SELECT COUNT(*)::int AS total FROM "Payment" WHERE ${where}`, params),
    ])

    const rows = dataResult.rows.map(mapToPaymentShape)
    const total = countResult.rows[0]?.total ?? 0

    return { rows, total }
  } catch (err) {
    logger.error('[LegacyQRPayments] Failed to fetch legacy payments', err)
    return { rows: [], total: 0 }
  }
}
