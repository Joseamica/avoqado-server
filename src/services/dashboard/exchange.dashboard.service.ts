import { Prisma, type ExchangeStatus, type PrismaClient } from '@prisma/client'
import { z } from 'zod'
import type { ExchangeResponse } from '../exchanges/exchange.service'
import prisma from '@/utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { exchangeReviewNoteSchema } from '@/schemas/dashboard/exchange.dashboard.schema'

const reviewSelect = {
  id: true,
  status: true,
  reviewReason: true,
  createdAt: true,
  originalOrderId: true,
  originalPaymentId: true,
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
type ReviewLabels = { originalOrderNumber: string | null; newOrderNumber: string | null; staffName: string | null }
const reviewRow = ({ differenceAmount, ...row }: ReviewRecord): ExchangeReviewRow => ({
  ...row,
  differenceCents: differenceAmount.mul(100).toNumber(),
})

async function addReviewLabels(db: PrismaClient, venueId: string, rows: ReviewRecord[]) {
  if (!rows.length) return []
  const orderIds = [...new Set(rows.flatMap(r => [r.originalOrderId, r.newOrderId]))]
  const staffIds = [...new Set(rows.map(r => r.staffId))]
  const [orders, staff] = await Promise.all([
    db.order.findMany({ where: { venueId, id: { in: orderIds } }, take: orderIds.length, select: { id: true, orderNumber: true } }),
    db.staff.findMany({
      where: { id: { in: staffIds }, venues: { some: { venueId } } },
      take: staffIds.length,
      select: { id: true, firstName: true, lastName: true },
    }),
  ])
  const numbers = new Map(orders.map(o => [o.id, o.orderNumber]))
  const names = new Map(staff.map(s => [s.id, [s.firstName, s.lastName].filter(Boolean).join(' ')]))
  return rows.map(row => ({
    ...reviewRow(row),
    originalOrderNumber: numbers.get(row.originalOrderId) ?? null,
    newOrderNumber: numbers.get(row.newOrderId) ?? null,
    staffName: names.get(row.staffId) ?? null,
  }))
}

function decodeCursor(cursor: string) {
  try {
    if (cursor.length > 512) throw new Error()
    return z
      .object({ createdAt: z.string().datetime(), id: z.string().cuid() })
      .parse(JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')))
  } catch {
    throw new BadRequestError('El cursor de cambios no es válido')
  }
}

export async function listExchangesForReview({
  venueId,
  pendingReview,
  limit = 25,
  offset = 0,
  cursor,
  originalOrderId,
  status,
  db = prisma,
}: {
  venueId: string
  pendingReview?: boolean
  limit?: number
  offset?: number
  cursor?: string
  originalOrderId?: string
  status?: ExchangeStatus
  db?: PrismaClient
}): Promise<{ total: number; items: Array<ExchangeReviewRow & ReviewLabels>; nextCursor: string | null }> {
  const where: Prisma.ExchangeWhereInput = {
    venueId,
    ...(originalOrderId ? { originalOrderId } : {}),
    ...(status ? { status } : {}),
    ...(pendingReview ? { status: 'NEEDS_REVIEW', reviewedAt: null } : {}),
  }
  const after = cursor ? decodeCursor(cursor) : null
  const pageWhere: Prisma.ExchangeWhereInput = after
    ? { ...where, OR: [{ createdAt: { lt: new Date(after.createdAt) } }, { createdAt: new Date(after.createdAt), id: { lt: after.id } }] }
    : where
  const take = Math.min(100, Math.max(1, Math.trunc(limit) || 25))
  const [total, rows] = await Promise.all([
    db.exchange.count({ where }),
    db.exchange.findMany({
      where: pageWhere,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One internal lookahead row proves nextCursor without counting a moving result twice.
      take: take + 1,
      skip: after ? 0 : offset,
      select: reviewSelect,
    }),
  ])
  const page = rows.slice(0, take)
  const last = page.at(-1)
  const nextCursor =
    rows.length > take && last
      ? Buffer.from(JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id })).toString('base64')
      : null
  return { total, items: await addReviewLabels(db, venueId, page), nextCursor }
}

export async function getExchangeForDashboard({ venueId, exchangeId }: { venueId: string; exchangeId: string }) {
  const row = await prisma.exchange.findFirst({
    where: { venueId, id: exchangeId },
    select: {
      ...reviewSelect,
      returnedAmount: true,
      takenAmount: true,
      settlementKind: true,
      settlementMethod: true,
      lines: true,
      result: true,
    },
  })
  if (!row) throw new NotFoundError('No se encontró el cambio')
  const lines = row.lines as Partial<ExchangeResponse['lines']> | null
  const result = row.result as Partial<ExchangeResponse> | null
  const { lines: _lines, result: _result, returnedAmount, takenAmount, settlementKind, settlementMethod, ...review } = row
  const [summary] = await addReviewLabels(prisma, venueId, [review])
  return {
    ...summary,
    applied: row.status === 'COMPLETED',
    returnedCents: returnedAmount.mul(100).toNumber(),
    takenCents: takenAmount.mul(100).toNumber(),
    returned: lines?.returned ?? [],
    taken: lines?.taken ?? [],
    settlement: { kind: settlementKind, method: settlementMethod, amountCents: Math.abs(summary.differenceCents) },
    expectedChargeCents: result?.expectedCents ?? null,
    chargedCents: result?.chargedSaleCents ?? null,
    chargePaymentCount: result?.chargePaymentCount ?? null,
    paymentIds: result?.paymentIds ?? [],
  }
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
