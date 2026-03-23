/**
 * Mobile Refund Service
 *
 * Unassociated refund management for iOS/Android POS apps.
 * Creates a refund Payment + VenueTransaction + optional cash drawer event.
 */

import prisma from '../../utils/prismaClient'
import { BadRequestError } from '../../errors/AppError'
import { logAction } from '../dashboard/activity-log.service'
import { Decimal } from '@prisma/client/runtime/library'

// ============================================================================
// CREATE UNASSOCIATED REFUND
// ============================================================================

interface CreateRefundParams {
  venueId: string
  amount: number // cents (positive)
  reason: string
  method: string // CASH
  staffId: string
  staffName?: string
}

/**
 * Create an unassociated refund (not linked to a specific original transaction).
 *
 * Flow:
 * 1. Create a refund order placeholder (status COMPLETED, paymentStatus REFUNDED)
 * 2. Create a Payment record with status REFUNDED, negative amount
 * 3. Create a VenueTransaction with type REFUND
 * 4. If there's an open CashDrawerSession, create a PAY_OUT event
 * 5. Return the refund details
 */
export async function createRefund(params: CreateRefundParams) {
  const { venueId, amount, reason, method, staffId, staffName } = params

  if (!amount || amount <= 0) {
    throw new BadRequestError('El monto debe ser mayor a 0')
  }

  if (!reason || !reason.trim()) {
    throw new BadRequestError('El motivo del reembolso es requerido')
  }

  const amountDecimal = centsToDecimal(amount) // positive (e.g., 50.00)
  const negativeAmount = new Decimal((-Number(amountDecimal)).toFixed(2)) // negative (e.g., -50.00)

  // Step 1: Create a refund placeholder order
  const orderNumber = `REF-${Date.now()}`
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber,
      type: 'TAKEOUT',
      source: 'AVOQADO_IOS',
      subtotal: negativeAmount,
      taxAmount: new Decimal('0.00'),
      total: negativeAmount,
      status: 'COMPLETED',
      paymentStatus: 'REFUNDED',
      createdById: staffId,
    },
  })

  // Step 2: Create Payment record
  const payment = await prisma.payment.create({
    data: {
      venueId,
      orderId: order.id,
      processedById: staffId,
      amount: negativeAmount,
      tipAmount: new Decimal('0.00'),
      method: (method === 'CASH' ? 'CASH' : 'CASH') as any,
      source: 'POS',
      status: 'REFUNDED',
      type: 'REGULAR',
      feePercentage: new Decimal('0.0000'),
      feeAmount: new Decimal('0.00'),
      netAmount: negativeAmount,
    },
  })

  // Step 3: Create VenueTransaction
  await prisma.venueTransaction.create({
    data: {
      venueId,
      paymentId: payment.id,
      type: 'REFUND',
      grossAmount: negativeAmount,
      feeAmount: new Decimal('0.00'),
      netAmount: negativeAmount,
    },
  })

  // Step 4: If there's an open CashDrawerSession, create PAY_OUT event
  if (method === 'CASH') {
    const openSession = await prisma.cashDrawerSession.findFirst({
      where: { venueId, status: 'OPEN' },
    })

    if (openSession) {
      await prisma.cashDrawerEvent.create({
        data: {
          sessionId: openSession.id,
          venueId,
          type: 'PAY_OUT',
          amount: amountDecimal, // positive amount for the pay-out
          staffId,
          staffName: staffName || 'Staff',
          note: `Reembolso: ${reason}`,
          orderId: order.id,
        },
      })
    }
  }

  logAction({
    staffId,
    venueId,
    action: 'REFUND_CREATED',
    entity: 'Payment',
    entityId: payment.id,
    data: {
      amount: Number(amountDecimal),
      reason,
      method,
      orderNumber,
      source: 'MOBILE',
    },
  })

  return {
    refundId: payment.id,
    orderId: order.id,
    orderNumber,
    amount, // cents
    reason,
    method,
    createdAt: payment.createdAt.toISOString(),
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function centsToDecimal(cents: number): Decimal {
  return new Decimal((cents / 100).toFixed(2))
}
