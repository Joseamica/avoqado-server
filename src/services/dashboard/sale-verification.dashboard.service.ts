import { SaleVerificationStatus, SaleVerificationRejectionReason, Prisma } from '@prisma/client'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import socketManager from '../../communication/sockets'
import { SocketEventType } from '../../communication/sockets/types'
import { logAction } from './activity-log.service'

// ============================================================
// Sale Verification Dashboard Service
// ============================================================
// Provides sale verification data with staff and payment details
// for the dashboard Sales Report view

interface ScannedProduct {
  barcode: string
  format: string
  productName?: string | null
  productId?: string | null
  hasInventory: boolean
  quantity: number
}

interface SaleVerificationDashboardResponse {
  id: string
  venueId: string
  paymentId: string
  staffId: string
  photos: string[]
  scannedProducts: ScannedProduct[]
  status: SaleVerificationStatus
  inventoryDeducted: boolean
  deviceId: string | null
  notes: string | null
  createdAt: Date
  updatedAt: Date
  /** True if this payment has an associated sale verification record */
  hasVerification: boolean
  /**
   * Present (true) ONLY when the request re-sent a decision that was already recorded:
   * nothing was written, audited or emitted — the row on file is returned as-is.
   * Absent on a real review, so existing clients see no change.
   */
  idempotentNoOp?: true
  // Back-office review metadata (PlayTelecom / Walmart documentation flow)
  reviewedById: string | null
  reviewedAt: Date | null
  reviewNotes: string | null
  rejectionReasons: SaleVerificationRejectionReason[]
  reviewedBy: {
    id: string
    firstName: string
    lastName: string
  } | null
  // Joined data
  staff: {
    id: string
    firstName: string
    lastName: string
    email: string
    photoUrl?: string | null
  } | null
  payment: {
    id: string
    amount: number
    status: string
    createdAt: Date
    order?: {
      id: string
      orderNumber: string
      total: number
      tags: string[]
    } | null
  } | null
}

interface ListSaleVerificationsParams {
  pageSize: number
  pageNumber: number
  status?: SaleVerificationStatus
  staffId?: string
  fromDate?: Date
  toDate?: Date
  search?: string
}

interface PaginatedResponse<T> {
  data: T[]
  pagination: {
    pageSize: number
    pageNumber: number
    totalCount: number
    totalPages: number
  }
}

interface SalesSummary {
  totalRevenue: number
  totalCount: number
  conciliatedCount: number
  pendingCount: number
  completedCount: number
  failedCount: number
  /** Terminal "Rechazada" (REJECTED) sales — started but lost (couldn't link/port). */
  rejectedCount: number
  avgAmount: number
  /** Count of payments without any sale verification */
  withoutVerificationCount: number
}

/**
 * List sale verifications with staff and payment details
 * For dashboard Sales Report view
 *
 * Now queries from Payment and LEFT JOINs with SaleVerification
 * to return ALL payments (including those without verification)
 */
export async function listSaleVerificationsWithDetails(
  venueId: string,
  params: ListSaleVerificationsParams,
): Promise<PaginatedResponse<SaleVerificationDashboardResponse>> {
  logger.info(
    `[SALE VERIFICATION DASHBOARD] Listing verifications for venue ${venueId} | Page ${params.pageNumber}, Size ${params.pageSize}`,
  )

  // Build WHERE clause for payments
  const paymentWhere: Prisma.PaymentWhereInput = {
    order: {
      venueId,
    },
    status: 'COMPLETED', // Only completed payments
  }

  // Handle date range on payment createdAt
  if (params.fromDate && params.toDate) {
    paymentWhere.createdAt = {
      gte: params.fromDate,
      lte: params.toDate,
    }
  } else if (params.fromDate) {
    paymentWhere.createdAt = { gte: params.fromDate }
  } else if (params.toDate) {
    paymentWhere.createdAt = { lte: params.toDate }
  }

  // Filter by verification status if provided
  if (params.status) {
    paymentWhere.saleVerification = {
      status: params.status,
    }
  }

  // Filter by staff if provided
  if (params.staffId) {
    paymentWhere.saleVerification = {
      ...((paymentWhere.saleVerification as object) ?? {}),
      staffId: params.staffId,
    }
  }

  // Search filter
  if (params.search) {
    paymentWhere.OR = [
      { id: { contains: params.search, mode: 'insensitive' } },
      {
        saleVerification: {
          staff: {
            OR: [
              { firstName: { contains: params.search, mode: 'insensitive' } },
              { lastName: { contains: params.search, mode: 'insensitive' } },
            ],
          },
        },
      },
    ]
  }

  const [payments, totalCount] = await Promise.all([
    prisma.payment.findMany({
      where: paymentWhere,
      // `id` is the TIEBREAK — same reason as the org-level list
      // (sale-verification.org.dashboard.service.ts): manually-uploaded sales all share one
      // backdated noon instant, and a non-unique sort key lets Postgres order ties freely,
      // so a tie group crossing a skip/take boundary drops rows between pages.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (params.pageNumber - 1) * params.pageSize,
      take: params.pageSize,
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            total: true,
            tags: true,
          },
        },
        saleVerification: {
          include: {
            staff: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                photoUrl: true,
              },
            },
            reviewedBy: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        },
      },
    }),
    prisma.payment.count({ where: paymentWhere }),
  ])

  const response: SaleVerificationDashboardResponse[] = payments.map(p => {
    const v = p.saleVerification
    const hasVerification = v !== null

    return {
      // Use verification ID if exists, otherwise payment ID as fallback
      id: v?.id ?? p.id,
      venueId,
      paymentId: p.id,
      staffId: v?.staffId ?? '',
      photos: v?.photos ?? [],
      scannedProducts: (v?.scannedProducts as unknown as ScannedProduct[]) ?? [],
      status: v?.status ?? ('PENDING' as SaleVerificationStatus),
      inventoryDeducted: v?.inventoryDeducted ?? false,
      deviceId: v?.deviceId ?? null,
      notes: v?.notes ?? null,
      createdAt: v?.createdAt ?? p.createdAt,
      updatedAt: v?.updatedAt ?? p.createdAt,
      hasVerification,
      reviewedById: v?.reviewedById ?? null,
      reviewedAt: v?.reviewedAt ?? null,
      reviewNotes: v?.reviewNotes ?? null,
      rejectionReasons: v?.rejectionReasons ?? [],
      reviewedBy: v?.reviewedBy ?? null,
      staff: v?.staff ?? null,
      payment: {
        id: p.id,
        amount: Number(p.amount),
        status: p.status,
        createdAt: p.createdAt,
        order: p.order
          ? {
              id: p.order.id,
              orderNumber: p.order.orderNumber,
              total: Number(p.order.total),
              tags: p.order.tags,
            }
          : null,
      },
    }
  })

  logger.info(`[SALE VERIFICATION DASHBOARD] Found ${response.length} payments (total: ${totalCount})`)

  return {
    data: response,
    pagination: {
      pageSize: params.pageSize,
      pageNumber: params.pageNumber,
      totalCount,
      totalPages: Math.ceil(totalCount / params.pageSize),
    },
  }
}

/**
 * Get summary statistics for sale verifications
 * For dashboard metrics cards
 *
 * Now counts ALL completed payments and checks which have/don't have verification
 */
export async function getSaleVerificationsSummary(venueId: string, fromDate?: Date, toDate?: Date): Promise<SalesSummary> {
  logger.info(`[SALE VERIFICATION DASHBOARD] Getting summary for venue ${venueId}`)

  // Build WHERE clause for payments
  const paymentWhere: Prisma.PaymentWhereInput = {
    order: {
      venueId,
    },
    status: 'COMPLETED',
  }

  if (fromDate && toDate) {
    paymentWhere.createdAt = { gte: fromDate, lte: toDate }
  } else if (fromDate) {
    paymentWhere.createdAt = { gte: fromDate }
  } else if (toDate) {
    paymentWhere.createdAt = { lte: toDate }
  }

  // Get all completed payments with their sale verifications
  const payments = await prisma.payment.findMany({
    where: paymentWhere,
    include: {
      saleVerification: {
        select: { status: true },
      },
    },
  })

  // Calculate totals
  let totalRevenue = 0
  let completedCount = 0
  let pendingCount = 0
  let failedCount = 0
  let rejectedCount = 0
  let withoutVerificationCount = 0

  for (const p of payments) {
    const amount = typeof p.amount === 'number' ? p.amount : Number(p.amount)
    totalRevenue += amount

    if (p.saleVerification) {
      switch (p.saleVerification.status) {
        case 'COMPLETED':
          completedCount++
          break
        case 'PENDING':
          pendingCount++
          break
        case 'FAILED':
          failedCount++
          break
        case 'REJECTED':
          rejectedCount++
          break
      }
    } else {
      withoutVerificationCount++
    }
  }

  const totalCount = payments.length
  const avgAmount = totalCount > 0 ? totalRevenue / totalCount : 0

  return {
    totalRevenue,
    totalCount,
    conciliatedCount: completedCount, // COMPLETED = conciliado
    pendingCount,
    completedCount,
    failedCount,
    rejectedCount,
    avgAmount,
    withoutVerificationCount,
  }
}

/**
 * Get daily sales data for charts
 */
export async function getDailySalesData(
  venueId: string,
  fromDate: Date,
  toDate: Date,
): Promise<Array<{ date: string; revenue: number; count: number }>> {
  logger.info(`[SALE VERIFICATION DASHBOARD] Getting daily sales data for venue ${venueId}`)

  const verifications = await prisma.saleVerification.findMany({
    where: {
      venueId,
      createdAt: { gte: fromDate, lte: toDate },
    },
    include: {
      payment: {
        select: { amount: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  // Group by day
  const dailyData = new Map<string, { revenue: number; count: number }>()

  for (const v of verifications) {
    const dateKey = v.createdAt.toISOString().split('T')[0]
    const existing = dailyData.get(dateKey) ?? { revenue: 0, count: 0 }
    const amount = v.payment?.amount ?? 0

    dailyData.set(dateKey, {
      revenue: existing.revenue + (typeof amount === 'number' ? amount : Number(amount)),
      count: existing.count + 1,
    })
  }

  return Array.from(dailyData.entries()).map(([date, data]) => ({
    date,
    revenue: data.revenue,
    count: data.count,
  }))
}

/**
 * Get staff for sale verifications filter
 */
export async function getStaffWithVerifications(venueId: string): Promise<
  Array<{
    id: string
    firstName: string
    lastName: string
    verificationCount: number
  }>
> {
  logger.info(`[SALE VERIFICATION DASHBOARD] Getting staff with verifications for venue ${venueId}`)

  const staffWithCounts = await prisma.saleVerification.groupBy({
    by: ['staffId'],
    where: { venueId },
    _count: { id: true },
  })

  const staffIds = staffWithCounts.map(s => s.staffId)

  const staff = await prisma.staff.findMany({
    where: { id: { in: staffIds } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
    },
  })

  return staff.map(s => {
    const count = staffWithCounts.find(sc => sc.staffId === s.id)?._count.id ?? 0
    return {
      id: s.id,
      firstName: s.firstName,
      lastName: s.lastName,
      verificationCount: count,
    }
  })
}

// ============================================================
// Back-Office Review (PlayTelecom / Walmart documentation flow)
// ============================================================

/**
 * Back-office review decisions:
 *   - APPROVE      → COMPLETED ("Venta correcta")
 *   - REJECT       → FAILED ("Revisar" — promoter can re-upload/correct on TPV)
 *   - REJECT_FINAL → REJECTED ("Rechazada" — terminal lost sale; no promoter correction)
 */
export type ReviewDecision = 'APPROVE' | 'REJECT' | 'REJECT_FINAL'

export interface ReviewSaleVerificationParams {
  saleVerificationId: string
  reviewedById: string
  decision: ReviewDecision
  rejectionReasons?: SaleVerificationRejectionReason[]
  reviewNotes?: string
}

/** Status each decision lands the verification in. */
const DECISION_TARGET_STATUS: Record<ReviewDecision, 'COMPLETED' | 'FAILED' | 'REJECTED'> = {
  APPROVE: 'COMPLETED',
  REJECT: 'FAILED',
  REJECT_FINAL: 'REJECTED',
}

/**
 * ActivityLog action per decision. The owner audit screen reads ONLY
 * ActivityLog — `reviewedById`/`reviewedAt` on the row get overwritten on
 * reopen + re-review, so without these the approval history is invisible
 * (prod 2026-08-25: 0 rows for the primary financial decision, while the
 * secondary EDIT path already had 140).
 */
export const SALE_VERIFICATION_REVIEW_AUDIT_ACTION: Record<ReviewDecision, string> = {
  APPROVE: 'SALE_VERIFICATION_APPROVED',
  REJECT: 'SALE_VERIFICATION_SENT_BACK',
  REJECT_FINAL: 'SALE_VERIFICATION_REJECTED',
}

/** Relations the review response needs — shared by the write and the idempotent read. */
const reviewInclude = {
  staff: { select: { id: true, firstName: true, lastName: true, email: true, photoUrl: true } },
  reviewedBy: { select: { id: true, firstName: true, lastName: true } },
  payment: {
    select: {
      id: true,
      amount: true,
      status: true,
      createdAt: true,
      order: { select: { id: true, orderNumber: true, total: true, tags: true } },
    },
  },
} satisfies Prisma.SaleVerificationInclude

type ReviewRow = Prisma.SaleVerificationGetPayload<{ include: typeof reviewInclude }>

/**
 * Resolve an already-reviewed verification against the decision being (re)sent.
 * Same outcome → the recorded review, flagged as no-op. Different outcome → 409.
 * Tenant-scoped: the row is re-read with `venueId` so the outcome can never come
 * from another venue's verification.
 */
async function resolveAlreadyReviewed(
  id: string,
  venueId: string,
  params: ReviewSaleVerificationParams,
): Promise<SaleVerificationDashboardResponse> {
  const current = await prisma.saleVerification.findUnique({ where: { id, venueId }, include: reviewInclude })
  if (!current) {
    throw createServiceError('Sale verification not found', 404)
  }
  if (current.status !== DECISION_TARGET_STATUS[params.decision]) {
    throw createServiceError(`Sale verification already reviewed (status=${current.status})`, 409)
  }
  // Same decision already recorded → no write, no audit, no socket. Return what is on file.
  logger.info(
    `[SALE VERIFICATION REVIEW] Verification ${id} is already ${current.status}; ${params.decision} re-sent by ${params.reviewedById} — returning the recorded review (idempotent no-op)`,
  )
  return { ...toReviewResponse(current), idempotentNoOp: true }
}

function toReviewResponse(row: ReviewRow): SaleVerificationDashboardResponse {
  return {
    id: row.id,
    venueId: row.venueId,
    paymentId: row.paymentId,
    staffId: row.staffId,
    photos: row.photos,
    scannedProducts: (row.scannedProducts as unknown as ScannedProduct[]) ?? [],
    status: row.status,
    inventoryDeducted: row.inventoryDeducted,
    deviceId: row.deviceId,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hasVerification: true,
    reviewedById: row.reviewedById,
    reviewedAt: row.reviewedAt,
    reviewNotes: row.reviewNotes,
    rejectionReasons: row.rejectionReasons,
    reviewedBy: row.reviewedBy ?? null,
    staff: row.staff ?? null,
    payment: row.payment
      ? {
          id: row.payment.id,
          amount: typeof row.payment.amount === 'number' ? row.payment.amount : Number(row.payment.amount),
          status: row.payment.status,
          createdAt: row.payment.createdAt,
          order: row.payment.order
            ? {
                id: row.payment.order.id,
                orderNumber: row.payment.order.orderNumber,
                total: Number(row.payment.order.total),
                tags: row.payment.order.tags,
              }
            : null,
        }
      : null,
  }
}

interface ServiceError extends Error {
  statusCode?: number
}

function createServiceError(message: string, statusCode: number): ServiceError {
  const err = new Error(message) as ServiceError
  err.statusCode = statusCode
  return err
}

/** Mínimo de caracteres del comentario que el promotor lee en su TPV. */
export const PROMOTER_FEEDBACK_MIN_CHARS = 5

/** Mensaje único del candado (en español: el usuario lo ve crudo). */
export const PROMOTER_FEEDBACK_REQUIRED_MESSAGE =
  'Para dejar la venta en "Revisar por promotor" escribe qué debe corregir el promotor (mínimo 5 caracteres).'

/**
 * Candado de "Revisar por promotor": una venta no puede quedar en FAILED sin un
 * comentario que le diga al promotor QUÉ corregir. Los `rejectionReasons`
 * (checkboxes) son opcionales — categorizan para el reporte a Walmart, pero un
 * checkbox solo no dice cuál imagen está mal.
 *
 * NO aplica a REJECTED ("Rechazada"): esa es terminal y el promotor no la corrige.
 *
 * @returns el texto ya trimmeado, listo para guardar.
 * @throws error con statusCode 400 si no alcanza el mínimo.
 */
export function assertPromoterFeedback(reviewNotes?: string | null): string {
  const trimmed = reviewNotes?.trim() ?? ''
  if (trimmed.length < PROMOTER_FEEDBACK_MIN_CHARS) {
    throw createServiceError(PROMOTER_FEEDBACK_REQUIRED_MESSAGE, 400)
  }
  return trimmed
}

/**
 * Approve or reject a sale verification (back-office documentation review).
 *
 * Decisions:
 *   - APPROVE      → status=COMPLETED, rejectionReasons cleared
 *   - REJECT       → status=FAILED, rejectionReasons stored, reviewNotes REQUIRED (>=5 chars)
 *   - REJECT_FINAL → status=REJECTED (terminal "Rechazada"), reviewNotes optional, no reasons required
 *
 * Validations:
 *   - Verification must exist and belong to the given venue
 *   - Verification must be in PENDING status. An already-reviewed one:
 *       · SAME outcome re-sent → idempotent no-op: the recorded review is returned
 *         untouched (first reviewer + timestamp stay). Prod 2026-08-25: an OWNER
 *         approving in batch re-clicked the same row 3× in 13 s because the UI gave
 *         no feedback for ~3 s, and got a red 409 on an action that had worked.
 *         Same idea as the payment path's `idempotencyKey` retry.
 *       · CONFLICTING outcome → 409 (reopen it first; that path is explicit).
 *   - REJECT requires reviewNotes with >= PROMOTER_FEEDBACK_MIN_CHARS chars (never a silent
 *     "revisar" — the promoter must know WHAT to fix). rejectionReasons stay optional.
 *
 * Side-effects:
 *   - Writes an ActivityLog row (`SALE_VERIFICATION_REVIEW_AUDIT_ACTION[decision]`) — this is
 *     the decision Walmart pays PlayTelecom for; the owner audit screen must see it.
 *   - Emits SALE_VERIFICATION_REVIEWED socket event to the promoter (staff) so their TPV refreshes in real time
 */
export async function reviewSaleVerification(
  venueId: string,
  params: ReviewSaleVerificationParams,
): Promise<SaleVerificationDashboardResponse> {
  logger.info(
    `[SALE VERIFICATION REVIEW] Verification ${params.saleVerificationId} ${params.decision} by ${params.reviewedById} on venue ${venueId}`,
  )

  const existing = await prisma.saleVerification.findUnique({
    where: { id: params.saleVerificationId },
    select: { id: true, venueId: true, staffId: true, paymentId: true, status: true },
  })

  if (!existing) {
    throw createServiceError('Sale verification not found', 404)
  }

  if (existing.venueId !== venueId) {
    throw createServiceError('Sale verification does not belong to this venue', 403)
  }

  if (existing.status !== 'PENDING') {
    return resolveAlreadyReviewed(existing.id, venueId, params)
  }

  const reasons = params.rejectionReasons ?? []

  // Candado: "Revisar por promotor" (FAILED) SIEMPRE lleva comentario.
  // REJECT_FINAL ("Rechazada") sigue con motivo opcional a propósito.
  if (params.decision === 'REJECT') {
    assertPromoterFeedback(params.reviewNotes)
  }

  const trimmedNotes = params.reviewNotes?.trim() || null

  const newStatus = DECISION_TARGET_STATUS[params.decision]

  // Atomic transition: the write only lands if the row is STILL PENDING (and in this
  // venue). Two overlapping reviews — a double-submit, or two reviewers on the same
  // sale — cannot both win: the loser gets P2025 and is resolved against what the
  // winner recorded (same decision → no-op, different decision → 409), so the
  // Walmart-payment decision is never overwritten by a late second write.
  let updated: ReviewRow
  try {
    updated = await prisma.saleVerification.update({
      where: { id: params.saleVerificationId, venueId, status: 'PENDING' },
      data: {
        status: newStatus,
        reviewedById: params.reviewedById,
        reviewedAt: new Date(),
        reviewNotes: trimmedNotes,
        // Reasons only apply to the fixable "Revisar" (FAILED) path. REJECTED is terminal.
        rejectionReasons: params.decision === 'REJECT' ? reasons : [],
      },
      include: reviewInclude,
    })
  } catch (err: any) {
    if (err?.code === 'P2025') {
      return resolveAlreadyReviewed(params.saleVerificationId, venueId, params)
    }
    throw err
  }

  // Audit the decision itself. Fire-and-forget: `logAction` never throws and runs
  // OUTSIDE any transaction, so an audit failure can never undo the review.
  void logAction({
    staffId: params.reviewedById,
    venueId,
    action: SALE_VERIFICATION_REVIEW_AUDIT_ACTION[params.decision],
    entity: 'SaleVerification',
    entityId: updated.id,
    data: {
      decision: params.decision,
      previousStatus: 'PENDING',
      newStatus,
      paymentId: updated.paymentId,
      promoterId: existing.staffId,
      rejectionReasons: updated.rejectionReasons,
      reviewNotes: trimmedNotes,
    },
  })

  // Emit socket event to the promoter — best-effort, never fail the request
  try {
    socketManager.broadcastToUser(existing.staffId, SocketEventType.SALE_VERIFICATION_REVIEWED, {
      saleVerificationId: updated.id,
      paymentId: updated.paymentId,
      status: updated.status,
      reviewedAt: updated.reviewedAt,
      reviewNotes: updated.reviewNotes,
      rejectionReasons: updated.rejectionReasons,
      reviewedBy: updated.reviewedBy ? `${updated.reviewedBy.firstName} ${updated.reviewedBy.lastName}`.trim() : null,
    })
  } catch (err: any) {
    logger.warn(`[SALE VERIFICATION REVIEW] Socket emit failed for staff ${existing.staffId}: ${err?.message ?? err}`)
  }

  return toReviewResponse(updated)
}
