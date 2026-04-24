import { Prisma, TransactionStatus } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import logger from '@/config/logger'

import type { CreateManualPaymentInput } from '@/schemas/dashboard/manualPayment.schema'

/**
 * Record a manual payment (admin-only) against an existing Order.
 * V1: order must exist and belong to the venue. Payment amount cannot make
 * total paid exceed order total. Triggers COMPLETED / PARTIAL transitions.
 *
 * Side effects not handled here (leave to existing hooks on Payment create):
 *   - Inventory FIFO deduction on final payment
 *   - Socket.io broadcast
 *   - Receipt email
 */
export async function createManualPayment(venueId: string, staffId: string, input: CreateManualPaymentInput) {
  const amount = new Prisma.Decimal(input.amount)
  const tipAmount = new Prisma.Decimal(input.tipAmount ?? '0')

  // Serializable isolation prevents the "lost update" race where two concurrent
  // payments both read paidAmount=X and each pass the "does not exceed total"
  // check, ending with sum(payments) > total. Under Serializable, Postgres
  // retries the conflict path and one of them fails with a serialization error
  // that the caller retries (idempotent from the client's view) or surfaces
  // as 500 — safer than silently accepting overpayment.
  return prisma.$transaction(
    async tx => {
      const order = await tx.order.findFirst({
        where: { id: input.orderId, venueId },
        include: { payments: { where: { status: TransactionStatus.COMPLETED } } },
      })

    if (!order) {
      throw new NotFoundError('Orden no encontrada')
    }

    const paidSoFar = order.payments.reduce(
      (acc: Prisma.Decimal, p: { amount: Prisma.Decimal | null }) => acc.plus(p.amount ?? 0),
      new Prisma.Decimal(0),
    )
    const newTotalPaid = paidSoFar.plus(amount)
    const orderTotal = new Prisma.Decimal(order.total)

    if (newTotalPaid.greaterThan(orderTotal)) {
      throw new BadRequestError(`El pago excede el saldo pendiente. Pendiente: ${orderTotal.minus(paidSoFar).toFixed(2)}`)
    }

    const payment = await tx.payment.create({
      data: {
        venueId,
        orderId: order.id,
        amount,
        tipAmount,
        method: input.method,
        source: input.source,
        externalSource: input.externalSource ?? null,
        status: TransactionStatus.COMPLETED,
        processedById: staffId,
        // Fee fields are required on Payment model — manual payments have no processor fees.
        feePercentage: new Prisma.Decimal(0),
        feeAmount: new Prisma.Decimal(0),
        netAmount: amount,
        // Payment has no dedicated notes column. Preserve the admin's reason
        // (and tag the provenance) inside processorData so it's auditable.
        processorData: {
          manualEntry: true,
          recordedByStaffId: staffId,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      },
    })

    const fullyPaid = newTotalPaid.equals(orderTotal)
    await tx.order.update({
      where: { id: order.id },
      data: {
        paymentStatus: fullyPaid ? 'PAID' : 'PARTIAL',
        paidAmount: newTotalPaid,
        remainingBalance: orderTotal.minus(newTotalPaid),
        ...(fullyPaid ? { completedAt: new Date() } : {}),
      },
    })

    logger.info('Manual payment created', {
      paymentId: payment.id,
      orderId: order.id,
      venueId,
      staffId,
      amount: amount.toFixed(2),
      source: input.source,
      externalSource: input.externalSource,
    })

      return payment
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  )
}

/**
 * Returns up to `limit` distinct externalSource values used on this venue,
 * ordered by frequency. Powers the combobox autocomplete so admins pick
 * existing entries instead of retyping and risking typos.
 */
export async function getExternalSources(venueId: string, limit = 10): Promise<string[]> {
  const rows = await prisma.payment.groupBy({
    by: ['externalSource'],
    where: {
      venueId,
      externalSource: { not: null },
    },
    _count: { _all: true },
    orderBy: { _count: { externalSource: 'desc' } },
    take: limit,
  })

  return rows.map(r => r.externalSource).filter((s): s is string => Boolean(s))
}
