/**
 * Dashboard Refund Service
 *
 * Issues a refund from the dashboard against an existing Payment.
 * Creates a new Payment with type=REFUND and a negative amount, tracking the
 * cumulative refunded total on the original payment's `processorData`.
 *
 * Simpler than the TPV flow (which needs terminal SDK data) — works for cash
 * and "manual" refunds entered by staff from the web dashboard.
 */

import { PaymentType, TransactionStatus, Prisma } from '@prisma/client'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'

export type RefundReason = 'RETURNED_GOODS' | 'ACCIDENTAL_CHARGE' | 'CANCELLED_ORDER' | 'FRAUDULENT_CHARGE' | 'OTHER'

export interface IssueRefundInput {
  venueId: string
  paymentId: string
  amount: number // in cents — positive number
  reason: RefundReason
  staffId?: string | null
  note?: string | null
}

export interface IssueRefundResult {
  refundId: string
  originalPaymentId: string
  amount: number // decimal (positive)
  remainingRefundable: number
  status: string
}

export async function issueRefund(input: IssueRefundInput): Promise<IssueRefundResult> {
  logger.info('[REFUND.DASHBOARD] Issuing refund', {
    venueId: input.venueId,
    paymentId: input.paymentId,
    amount: input.amount,
    reason: input.reason,
  })

  if (!input.amount || input.amount <= 0) {
    throw new BadRequestError('Refund amount must be a positive number (cents)')
  }
  if (!input.reason) {
    throw new BadRequestError('Refund reason is required')
  }

  const original = await prisma.payment.findUnique({
    where: { id: input.paymentId },
    select: {
      id: true,
      venueId: true,
      status: true,
      type: true,
      method: true,
      source: true,
      amount: true,
      tipAmount: true,
      orderId: true,
      shiftId: true,
      merchantAccountId: true,
      processorData: true,
    },
  })

  if (!original) {
    throw new NotFoundError(`Payment ${input.paymentId} not found`)
  }
  if (original.venueId !== input.venueId) {
    throw new BadRequestError('Payment does not belong to this venue')
  }
  if (original.status !== 'COMPLETED') {
    throw new BadRequestError(`Cannot refund payment with status: ${original.status}`)
  }
  if (original.type === PaymentType.REFUND) {
    throw new BadRequestError('Cannot refund a refund')
  }

  const refundDecimal = input.amount / 100
  const totalOriginal = Number(original.amount) + Number(original.tipAmount || 0)
  const processorData = (original.processorData as Record<string, unknown>) || {}
  const alreadyRefunded = Number(processorData.refundedAmount || 0)
  const remainingBefore = totalOriginal - alreadyRefunded

  if (refundDecimal > remainingBefore + 0.001) {
    throw new BadRequestError(`Refund (${refundDecimal.toFixed(2)}) exceeds remaining refundable (${remainingBefore.toFixed(2)})`)
  }

  // Find active shift for the staff (optional, for reconciliation)
  let shiftId = original.shiftId
  if (input.staffId) {
    const openShift = await prisma.shift.findFirst({
      where: { venueId: input.venueId, staffId: input.staffId, status: 'OPEN', endTime: null },
      orderBy: { startTime: 'desc' },
      select: { id: true },
    })
    if (openShift) shiftId = openShift.id
  }

  const result = await prisma.$transaction(async tx => {
    const refundPayment = await tx.payment.create({
      data: {
        venueId: input.venueId,
        orderId: original.orderId,
        shiftId: shiftId || undefined,
        processedById: input.staffId || undefined,
        merchantAccountId: original.merchantAccountId,

        // Negative amount represents outgoing refund
        amount: new Prisma.Decimal(-refundDecimal),
        tipAmount: new Prisma.Decimal(0),
        netAmount: new Prisma.Decimal(-refundDecimal),
        feeAmount: new Prisma.Decimal(0),
        feePercentage: 0,

        method: original.method,
        source: original.source,
        status: TransactionStatus.COMPLETED,
        type: PaymentType.REFUND,

        processor: 'dashboard',
        processorData: {
          originalPaymentId: original.id,
          refundReason: input.reason,
          note: input.note ?? null,
        },
      },
    })

    // Bump refundedAmount on the original payment's processorData
    const updatedProcessorData = {
      ...processorData,
      refundedAmount: alreadyRefunded + refundDecimal,
      refunds: [
        ...((Array.isArray(processorData.refunds) ? processorData.refunds : []) as any[]),
        {
          refundPaymentId: refundPayment.id,
          amount: refundDecimal,
          reason: input.reason,
          at: new Date().toISOString(),
        },
      ],
    }
    await tx.payment.update({
      where: { id: original.id },
      data: { processorData: updatedProcessorData as any },
    })

    // Venue transaction for financial tracking
    await tx.venueTransaction.create({
      data: {
        venueId: input.venueId,
        paymentId: refundPayment.id,
        type: 'REFUND',
        grossAmount: new Prisma.Decimal(-refundDecimal),
        feeAmount: new Prisma.Decimal(0),
        netAmount: new Prisma.Decimal(-refundDecimal),
        status: 'SETTLED',
      },
    })

    return refundPayment
  })

  const remainingAfter = remainingBefore - refundDecimal

  logger.info('[REFUND.DASHBOARD] Refund issued', {
    refundId: result.id,
    originalPaymentId: original.id,
    amount: refundDecimal,
    remainingRefundable: remainingAfter,
  })

  return {
    refundId: result.id,
    originalPaymentId: original.id,
    amount: refundDecimal,
    remainingRefundable: remainingAfter,
    status: 'COMPLETED',
  }
}

/**
 * Return the set of REFUND payments that reference a given original payment.
 */
export async function listRefundsForPayment(venueId: string, originalPaymentId: string) {
  const refunds = await prisma.payment.findMany({
    where: {
      venueId,
      type: PaymentType.REFUND,
      // processorData->>originalPaymentId = :originalPaymentId
      // Prisma JSON filters don't hit this cleanly, so we filter in JS below.
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      amount: true,
      status: true,
      method: true,
      createdAt: true,
      processedBy: { select: { firstName: true, lastName: true } },
      processorData: true,
    },
  })

  return refunds.filter(r => {
    const pd = (r.processorData as Record<string, unknown>) || {}
    return pd.originalPaymentId === originalPaymentId
  })
}
