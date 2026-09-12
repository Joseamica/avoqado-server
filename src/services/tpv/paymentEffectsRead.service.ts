export type PaymentEffectStatus = 'PENDING' | 'PROCESSING' | 'DONE' | 'DEAD_LETTER'
export type PaymentEffectListInput = {
  venueId: string
  status?: PaymentEffectStatus
  kind?: 'REVIEW' | 'RECEIPT' | 'REFERRAL' | 'COMMISSION'
  paymentId?: string
  limit?: number
  cursor?: string
}

/** Read-only operational visibility. Frozen monetary policy and claim tokens stay private. */
export async function listPaymentEffects(input: PaymentEffectListInput) {
  const limit = Number.isFinite(input.limit) ? Math.min(100, Math.max(1, Math.floor(input.limit!))) : 50
  const where: Prisma.PaymentEffectWhereInput = {
    venueId: input.venueId,
    status: input.status ?? 'PENDING',
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.paymentId ? { paymentId: input.paymentId } : {}),
  }
  let after: Prisma.PaymentEffectWhereInput = {}
  if (input.cursor) {
    const anchor = await prisma.paymentEffect.findFirst({
      // A worker may change status after page one. Its immutable position remains valid.
      where: { venueId: input.venueId, id: input.cursor },
      select: { id: true, createdAt: true },
    })
    if (!anchor) throw new BadRequestError('La página ya no está disponible con estos filtros. Vuelve a consultar desde el inicio.')
    after = { OR: [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }] }
  }
  const [rows, total] = await Promise.all([
    prisma.paymentEffect.findMany({
      where: { ...where, ...after },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One lookahead row proves that the next page exists; at most 100 rows are returned.
      take: limit + 1,
      select: {
        id: true,
        venueId: true,
        paymentId: true,
        orderId: true,
        kind: true,
        status: true,
        attempts: true,
        nextAttemptAt: true,
        leaseUntil: true,
        completedAt: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.paymentEffect.count({ where }),
  ])
  const hasMore = rows.length > limit
  const publicErrors = new Set(['PAYMENT_EFFECT_EXECUTION_FAILED', 'LEASE_ATTEMPTS_EXHAUSTED', 'COMMISSION_SNAPSHOT_REQUIRES_REVIEW'])
  const items = rows.slice(0, limit).map(row => ({
    ...row,
    lastError: row.lastError && !publicErrors.has(row.lastError) ? 'PAYMENT_EFFECT_REQUIRES_REVIEW' : row.lastError,
  }))
  return { items, total, hasMore, nextCursor: hasMore ? items[items.length - 1].id : null }
}
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'
