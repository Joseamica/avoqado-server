import { PaymentType, TransactionStatus, CardBrand, CardEntryMode, PaymentMethod, Prisma } from '@prisma/client'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { generateDigitalReceipt } from './digitalReceipt.tpv.service'
import { Decimal } from '@prisma/client/runtime/library'
import { createRefundTransactionCost } from '../payments/transactionCost.service'

/**
 * Refund request data from TPV Android app
 *
 * **CRITICAL - Multi-Merchant Routing:**
 * The refund MUST be processed by the same merchant that processed the original payment.
 */
interface RefundRequestData {
  venueId: string
  originalPaymentId: string
  originalOrderId?: string | null
  amount: number // In cents (5000 = $50.00)
  reason: string // RefundReason.name (e.g., "CUSTOMER_REQUEST")
  staffId: string
  shiftId?: string | null
  merchantAccountId?: string | null
  tpvId?: string | null // Terminal that processed this refund (for sales attribution)
  blumonSerialNumber: string
  authorizationNumber: string
  referenceNumber: string
  maskedPan?: string | null
  cardBrand?: string | null
  entryMode?: string | null
  isPartialRefund: boolean
  currency: string
}

/**
 * Refund response matching what Android app expects
 */
interface RefundResponse {
  id: string
  originalPaymentId: string
  amount: number // In pesos (decimal)
  status: string
  authorizationNumber?: string | null
  referenceNumber?: string | null
  digitalReceipt?: {
    id: string
    accessKey: string
    receiptUrl: string
  } | null
}

/**
 * Record a refund for an existing payment
 *
 * **Flow:**
 * 1. Find original payment and validate
 * 2. Validate refund amount doesn't exceed original
 * 3. Create new Payment record with type=REFUND
 * 4. Update original payment's processorData with refund tracking
 * 5. Generate digital receipt
 * 6. Return response
 *
 * @param venueId Venue ID from route params
 * @param refundData Refund request data from TPV
 * @param userId Current user ID (from auth context)
 * @param orgId Organization ID (from auth context)
 */
export async function recordRefund(
  venueId: string,
  refundData: RefundRequestData,
  userId?: string,
  orgId?: string,
): Promise<RefundResponse> {
  logger.info('Recording refund', {
    venueId,
    originalPaymentId: refundData.originalPaymentId,
    amount: refundData.amount,
    reason: refundData.reason,
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1: Find and validate original payment
  // ═══════════════════════════════════════════════════════════════════════════
  const originalPayment = await prisma.payment.findUnique({
    where: { id: refundData.originalPaymentId },
    include: {
      order: true,
      receipts: true,
    },
  })

  if (!originalPayment) {
    logger.error('Original payment not found', {
      originalPaymentId: refundData.originalPaymentId,
      venueId,
    })
    throw new NotFoundError(`Payment ${refundData.originalPaymentId} not found`)
  }

  // Validate payment belongs to this venue
  if (originalPayment.venueId !== venueId) {
    logger.error('Payment does not belong to venue', {
      originalPaymentId: refundData.originalPaymentId,
      paymentVenueId: originalPayment.venueId,
      requestedVenueId: venueId,
    })
    throw new BadRequestError('Payment does not belong to this venue')
  }

  // Validate payment is completed
  if (originalPayment.status !== 'COMPLETED') {
    logger.error('Cannot refund non-completed payment', {
      originalPaymentId: refundData.originalPaymentId,
      status: originalPayment.status,
    })
    throw new BadRequestError(`Cannot refund payment with status: ${originalPayment.status}`)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2: Validate refund amount
  // ═══════════════════════════════════════════════════════════════════════════
  const refundAmountInPesos = refundData.amount / 100
  const originalAmountNumber = Number(originalPayment.amount)

  // Calculate already refunded amount from processorData
  const processorData = (originalPayment.processorData as Record<string, unknown>) || {}
  const alreadyRefunded = Number(processorData.refundedAmount || 0)
  const remainingRefundable = originalAmountNumber - alreadyRefunded

  if (refundAmountInPesos > remainingRefundable) {
    logger.error('Refund amount exceeds remaining refundable', {
      originalPaymentId: refundData.originalPaymentId,
      requestedRefund: refundAmountInPesos,
      originalAmount: originalAmountNumber,
      alreadyRefunded,
      remainingRefundable,
    })
    throw new BadRequestError(`Refund amount (${refundAmountInPesos}) exceeds remaining refundable amount (${remainingRefundable})`)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 3: Find current shift for the staff (for reconciliation)
  // ═══════════════════════════════════════════════════════════════════════════
  let shiftId = refundData.shiftId

  if (!shiftId) {
    const currentShift = await prisma.shift.findFirst({
      where: {
        venueId,
        staffId: refundData.staffId,
        status: 'OPEN',
        endTime: null,
      },
      orderBy: {
        startTime: 'desc',
      },
    })
    shiftId = currentShift?.id || null
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 4: Create refund payment and update original in transaction
  // ═══════════════════════════════════════════════════════════════════════════
  const result = await prisma.$transaction(async tx => {
    // Create new Payment record with type=REFUND
    const refundPayment = await tx.payment.create({
      data: {
        venueId,
        orderId: originalPayment.orderId, // Link to same order
        shiftId: shiftId || undefined,
        processedById: refundData.staffId,
        merchantAccountId: refundData.merchantAccountId || originalPayment.merchantAccountId,
        // ⭐ Terminal that processed this refund (use provided tpvId or inherit from original payment)
        terminalId: refundData.tpvId || originalPayment.terminalId || null,

        // Negative amount to represent refund
        amount: new Decimal(-refundAmountInPesos),
        tipAmount: new Decimal(0),

        // Payment info
        method: originalPayment.method,
        source: originalPayment.source,
        status: TransactionStatus.COMPLETED,
        type: PaymentType.REFUND,

        // Processor info
        processor: 'blumon',
        processorData: {
          originalPaymentId: refundData.originalPaymentId,
          refundReason: refundData.reason,
          isPartialRefund: refundData.isPartialRefund,
          currency: refundData.currency,
          blumonSerialNumber: refundData.blumonSerialNumber,
        },

        // Authorization from Blumon SDK CancelIcc
        authorizationNumber: refundData.authorizationNumber,
        referenceNumber: refundData.referenceNumber,

        // Card details
        cardBrand: mapCardBrand(refundData.cardBrand),
        maskedPan: refundData.maskedPan,
        entryMode: mapEntryMode(refundData.entryMode),

        // Fee calculation (no fees on refunds typically)
        feePercentage: new Decimal(0),
        feeAmount: new Decimal(0),
        netAmount: new Decimal(-refundAmountInPesos),
      },
    })

    // Update original payment's processorData with refund tracking
    const newRefundedAmount = alreadyRefunded + refundAmountInPesos
    const isFullyRefunded = newRefundedAmount >= originalAmountNumber

    // Build refund history array safely as plain JSON
    const existingHistory = Array.isArray(processorData.refundHistory) ? processorData.refundHistory : []

    const newRefundEntry = {
      refundId: refundPayment.id,
      amount: refundAmountInPesos,
      reason: refundData.reason,
      staffId: refundData.staffId,
      timestamp: new Date().toISOString(),
    }

    // Build updated processorData as plain object for Prisma JSON field
    const updatedProcessorData = {
      ...processorData,
      refundedAmount: newRefundedAmount,
      isFullyRefunded,
      lastRefundId: refundPayment.id,
      lastRefundAt: new Date().toISOString(),
      refundHistory: [...(existingHistory as Prisma.JsonArray), newRefundEntry],
    } as Prisma.InputJsonValue

    await tx.payment.update({
      where: { id: refundData.originalPaymentId },
      data: {
        processorData: updatedProcessorData,
      },
    })

    return refundPayment
  })

  logger.info('Refund payment created', {
    refundPaymentId: result.id,
    originalPaymentId: refundData.originalPaymentId,
    amount: refundAmountInPesos,
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 5: Create negative TransactionCost for refund (for accurate profit reporting)
  // ═══════════════════════════════════════════════════════════════════════════
  try {
    await createRefundTransactionCost(result.id, refundData.originalPaymentId)
    logger.info('Refund TransactionCost created', { refundPaymentId: result.id })
  } catch (error) {
    // Don't fail the refund if TransactionCost creation fails
    logger.error('Failed to create refund TransactionCost', { error, refundPaymentId: result.id })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 6: Generate digital receipt for refund
  // ═══════════════════════════════════════════════════════════════════════════
  let digitalReceipt = null
  try {
    const receipt = await generateDigitalReceipt(result.id)
    digitalReceipt = {
      id: receipt.id,
      accessKey: receipt.accessKey,
      // 💸 Add ?refund=true for frontend to detect refund and apply appropriate styling
      receiptUrl: `${process.env.FRONTEND_URL || 'https://dashboardv2.avoqado.io'}/receipts/public/${receipt.accessKey}?refund=true`,
    }
    logger.info('Refund digital receipt generated', { receiptId: receipt.id })
  } catch (error) {
    // Don't fail the refund if receipt generation fails
    logger.error('Failed to generate refund receipt', { error, refundPaymentId: result.id })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 6: Return response matching Android app's expected format
  // ═══════════════════════════════════════════════════════════════════════════
  return {
    id: result.id,
    originalPaymentId: refundData.originalPaymentId,
    amount: Math.abs(Number(result.amount)), // Return positive amount in pesos
    status: result.status,
    authorizationNumber: result.authorizationNumber,
    referenceNumber: result.referenceNumber,
    digitalReceipt,
  }
}

/**
 * Map card brand string to CardBrand enum
 */
function mapCardBrand(brand?: string | null): CardBrand | null {
  if (!brand) return null

  const brandMap: Record<string, CardBrand> = {
    VISA: CardBrand.VISA,
    MASTERCARD: CardBrand.MASTERCARD,
    AMEX: CardBrand.AMERICAN_EXPRESS,
    AMERICAN_EXPRESS: CardBrand.AMERICAN_EXPRESS,
    DISCOVER: CardBrand.DISCOVER,
    DINERS_CLUB: CardBrand.DINERS_CLUB,
    JCB: CardBrand.JCB,
    MAESTRO: CardBrand.MAESTRO,
    UNIONPAY: CardBrand.UNIONPAY,
    OTHER: CardBrand.OTHER,
  }

  return brandMap[brand.toUpperCase()] || CardBrand.OTHER
}

/**
 * Map entry mode string to CardEntryMode enum
 */
function mapEntryMode(mode?: string | null): CardEntryMode | null {
  if (!mode) return null

  const modeMap: Record<string, CardEntryMode> = {
    CHIP: CardEntryMode.CHIP,
    CONTACTLESS: CardEntryMode.CONTACTLESS,
    SWIPE: CardEntryMode.SWIPE,
    MANUAL: CardEntryMode.MANUAL,
    FALLBACK: CardEntryMode.FALLBACK,
  }

  return modeMap[mode.toUpperCase()] || CardEntryMode.CHIP
}
