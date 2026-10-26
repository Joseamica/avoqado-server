import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { exchangeReviewNoteSchema } from '@/schemas/dashboard/exchange.dashboard.schema'

const reviewSelect = {
  id: true,
  status: true,
  reviewReason: true,
  createdAt: true,
  originalOrderId: true,
  newOrderId: true,
  differenceAmount: true,
  chargePaymentId: true,
  staffId: true,
  reviewedAt: true,
  reviewedById: true,
  reviewNote: true,
} satisfies Prisma.ExchangeSelect
type ReviewRecord = Prisma.ExchangeGetPayload<{ select: typeof reviewSelect }>
export type ExchangeReviewRow = Omit<ReviewRecord, 'differenceAmount'> & { differenceCents: number }
const reviewRow = ({ differenceAmount, ...row }: ReviewRecord): ExchangeReviewRow => ({
  ...row,
  differenceCents: differenceAmount.mul(100).toNumber(),
})

export async function listExchangesForReview({
  venueId,
  pendingReview,
  limit = 25,
  offset = 0,
}: {
  venueId: string
  pendingReview?: boolean
  limit?: number
  offset?: number
}): Promise<{ total: number; items: ExchangeReviewRow[] }> {
  const where: Prisma.ExchangeWhereInput = { venueId, ...(pendingReview ? { status: 'NEEDS_REVIEW', reviewedAt: null } : {}) }
  const [total, rows] = await Promise.all([
    prisma.exchange.count({ where }),
    prisma.exchange.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(100, Math.max(1, limit)),
      skip: offset,
      select: reviewSelect,
    }),
  ])
  return { total, items: rows.map(reviewRow) }
}

function assertReviewable<T extends { status: string; reviewedAt: Date | null }>(row: T | null): asserts row is T {
  if (!row) throw new NotFoundError('No se encontró el cambio')
  if (row.reviewedAt) throw new ConflictError('Este cambio ya fue revisado', 'EXCHANGE_ALREADY_REVIEWED')
  if (row.status !== 'NEEDS_REVIEW') throw new ConflictError('Este cambio no está por revisar', 'EXCHANGE_NOT_IN_REVIEW')
}

export async function markExchangeReviewed({
  venueId,
  exchangeId,
  staffId,
  note,
  source = 'HTTP',
}: {
  venueId: string
  exchangeId: string
  staffId: string
  note: string
  source?: 'HTTP' | 'MCP'
}): Promise<ExchangeReviewRow> {
  const parsed = exchangeReviewNoteSchema.safeParse(note)
  if (!parsed.success) throw new BadRequestError(parsed.error.issues.map(i => i.message).join(', '))
  return prisma.$transaction(async tx => {
    const where = { id: exchangeId, venueId }
    const current = await tx.exchange.findFirst({ where, select: { ...reviewSelect, resultRevision: true } })
    assertReviewable(current)
    const reviewedAt = new Date()
    const written = await tx.exchange.updateMany({
      where: { ...where, status: 'NEEDS_REVIEW', reviewedAt: null, resultRevision: current.resultRevision },
      data: { reviewedAt, reviewedById: staffId, reviewNote: parsed.data, resultRevision: { increment: 1 }, updatedAt: reviewedAt },
    })
    if (written.count !== 1) {
      assertReviewable(await tx.exchange.findFirst({ where, select: { status: true, reviewedAt: true } }))
      throw new ConflictError('El cambio se actualizó mientras lo revisabas; vuelve a intentarlo', 'EXCHANGE_RETRY_CONFLICT')
    }
    await tx.activityLog.create({
      data: {
        venueId,
        entity: 'Exchange',
        entityId: exchangeId,
        action: 'EXCHANGE_REVIEWED',
        staffId,
        data: { note: parsed.data, reviewReason: current.reviewReason, source },
      },
    })
    const { resultRevision: _revision, ...row } = current
    return reviewRow({ ...row, reviewedAt, reviewedById: staffId, reviewNote: parsed.data })
  })
}
