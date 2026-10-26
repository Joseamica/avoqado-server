import { Prisma, type PrismaClient } from '@prisma/client'
import { WHERE_PAYMENT_IS_NOT_EXCHANGE_CREDIT, sqlPaymentIsNotExchangeCredit } from './exchangeMarks'

export type ExchangeChargeEvidence =
  | { kind: 'CHARGED'; paymentIds: string[]; chargedSaleCents: number; paymentCount: number; exceedsPaymentLimit: boolean }
  | { kind: 'UNRESOLVED'; requestId: string | null; positiveRequestId: string | null }
  | { kind: 'NOT_CHARGED'; requestCount: number; lastActivityAt: Date | null }

export async function exchangeChargeEvidence(
  db: Prisma.TransactionClient | PrismaClient,
  venueId: string,
  newOrderId: string,
): Promise<ExchangeChargeEvidence> {
  const sale: Prisma.PaymentWhereInput = {
    venueId,
    orderId: newOrderId,
    OR: [{ type: null }, { type: { not: 'REFUND' } }],
    AND: [WHERE_PAYMENT_IS_NOT_EXCHANGE_CREDIT],
  }
  const captured: Prisma.PaymentWhereInput = { ...sale, status: { in: ['COMPLETED', 'REFUNDED'] } }
  const totals = await db.payment.aggregate({ where: captured, _sum: { amount: true }, _count: { _all: true } })
  const { desenlaceCanonico, terminalPaymentService } = await import('../terminal-payment.service')
  // COMPLETED + nonempty paymentId is the positive branch of desenlaceCanonico; soft references still need accreditation.
  const [positive] = await db.$queryRaw<
    Array<{
      requestId: string
      status: 'COMPLETED'
      paymentId: string
      failureCode: string | null
    }>
  >`
    SELECT r."requestId", r.status, r."paymentId", r."failureCode"
    FROM "TerminalPaymentRequest" r
    WHERE r."venueId" = ${venueId} AND r."orderId" = ${newOrderId}
      AND r.status = 'COMPLETED' AND r."paymentId" IS NOT NULL AND r."paymentId" <> ''
      AND NOT EXISTS (
        SELECT 1 FROM "Payment" p WHERE p.id = r."paymentId" AND p."venueId" = r."venueId" AND p."orderId" = r."orderId"
          AND p.status IN ('COMPLETED', 'REFUNDED') AND (p.type IS NULL OR p.type <> 'REFUND')
          AND ${sqlPaymentIsNotExchangeCredit('p')}
      )
    ORDER BY r."createdAt" DESC, r.id DESC LIMIT 1
  `
  if (positive && desenlaceCanonico(positive).outcome === 'CHARGED') {
    return { kind: 'UNRESOLVED', requestId: positive.requestId, positiveRequestId: positive.requestId }
  }
  if (totals._count._all > 0) {
    const { MAX_EXCHANGE_SALE_PAYMENTS } = await import('./exchangeSale')
    const payments = await db.payment.findMany({
      where: captured,
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_EXCHANGE_SALE_PAYMENTS + 1,
    })
    return {
      kind: 'CHARGED',
      paymentIds: payments.map(p => p.id),
      chargedSaleCents: (totals._sum.amount ?? new Prisma.Decimal(0)).mul(100).toDecimalPlaces(0).toNumber(),
      paymentCount: totals._count._all,
      exceedsPaymentLimit: totals._count._all > MAX_EXCHANGE_SALE_PAYMENTS,
    }
  }
  const pending = await db.payment.findFirst({ where: { ...sale, status: { in: ['PENDING', 'PROCESSING'] } }, select: { id: true } })
  const blocking = await terminalPaymentService.findChargeBlockingOrderCancel(venueId, newOrderId, db)
  if (pending || blocking) return { kind: 'UNRESOLVED', requestId: blocking?.requestId ?? null, positiveRequestId: null }
  const requests = await db.terminalPaymentRequest.aggregate({
    where: { venueId, orderId: newOrderId },
    _count: { _all: true },
    _max: { updatedAt: true },
  })
  return { kind: 'NOT_CHARGED', requestCount: requests._count._all, lastActivityAt: requests._max.updatedAt }
}

/** Caller already holds Order, Payment and Shift; this CAS never takes the Exchange advisory lock. */
export async function markExchangeChargeInTx(
  tx: Prisma.TransactionClient,
  input: { venueId: string; orderId: string; paymentId: string },
): Promise<void> {
  const exchange = await tx.exchange.findUnique({
    where: { newOrderId: input.orderId, venueId: input.venueId },
    select: { id: true, status: true, chargePaymentId: true, resultRevision: true, result: true },
  })
  if (!exchange || exchange.chargePaymentId || !['PENDING_PAYMENT', 'CANCELLED'].includes(exchange.status)) return
  const result =
    exchange.result && typeof exchange.result === 'object' && !Array.isArray(exchange.result)
      ? { ...exchange.result, chargePaymentId: input.paymentId }
      : undefined
  const stamped = await tx.exchange.updateMany({
    where: {
      venueId: input.venueId,
      newOrderId: input.orderId,
      status: exchange.status,
      chargePaymentId: null,
      resultRevision: exchange.resultRevision,
    },
    data: { chargePaymentId: input.paymentId, resultRevision: { increment: 1 }, ...(result ? { result } : {}) },
  })
  if (stamped.count !== 1) throw new Error('Exchange charge stamp generation changed')
}
