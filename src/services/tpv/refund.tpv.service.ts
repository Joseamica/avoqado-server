import { PaymentType, TransactionStatus, CardBrand, CardEntryMode, Prisma } from '@prisma/client'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { generateDigitalReceipt } from './digitalReceipt.tpv.service'
import { Decimal } from '@prisma/client/runtime/library'
import { createRefundTransactionCost } from '../payments/transactionCost.service'
import { createRefundCommission } from '../dashboard/commission/commission-calculation.service'

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
  /**
   * Optional explicit tip portion of the refund, in cents. When omitted, TPV
   * splits proportional to the original sale/tip ratio. When set, the caller
   * controls how much of the refund comes from tip vs sale (0 = keep staff
   * tip intact, equal to amount = tip-only refund, etc.). Bounds are validated.
   */
  tipRefundCents?: number
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
  _userId?: string,
  _orgId?: string,
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

  // Reject zero/negative refund amounts up-front — Blumon would accept the
  // call but the resulting DB row is a $0 refund that only pollutes reports.
  if (!Number.isFinite(refundData.amount) || refundData.amount <= 0) {
    logger.error('Invalid refund amount (must be > 0)', { amount: refundData.amount })
    throw new BadRequestError('Refund amount must be greater than zero')
  }

  const refundAmountInPesos = refundData.amount / 100
  const originalAmountNumber = Number(originalPayment.amount)
  // 💸 FIX: Include tip in refundable amount - tip is part of the total transaction
  const originalTipNumber = Number(originalPayment.tipAmount || 0)
  const totalOriginalAmount = originalAmountNumber + originalTipNumber

  // Calculate already refunded amount from processorData
  const processorData = (originalPayment.processorData as Record<string, unknown>) || {}
  const alreadyRefunded = Number(processorData.refundedAmount || 0)
  const remainingRefundable = totalOriginalAmount - alreadyRefunded

  if (refundAmountInPesos > remainingRefundable) {
    logger.error('Refund amount exceeds remaining refundable', {
      originalPaymentId: refundData.originalPaymentId,
      requestedRefund: refundAmountInPesos,
      originalAmount: originalAmountNumber,
      originalTip: originalTipNumber,
      totalOriginalAmount,
      alreadyRefunded,
      remainingRefundable,
    })
    throw new BadRequestError(`Refund amount (${refundAmountInPesos}) exceeds remaining refundable amount (${remainingRefundable})`)
  }

  // Split between sale (Payment.amount) and tip (Payment.tipAmount). Default
  // is proportional; caller can override with `tipRefundCents` for explicit
  // control ("refund only the sale, keep staff tip intact", etc.).
  let tipRefund = 0
  let salesRefund = refundAmountInPesos

  if (typeof refundData.tipRefundCents === 'number') {
    const overrideTip = refundData.tipRefundCents / 100
    if (overrideTip < 0) {
      throw new BadRequestError('tipRefundCents must be >= 0')
    }
    if (overrideTip > refundAmountInPesos + 0.001) {
      throw new BadRequestError(`tipRefundCents ($${overrideTip}) exceeds total refund ($${refundAmountInPesos})`)
    }
    if (overrideTip > originalTipNumber + 0.001) {
      throw new BadRequestError(`tipRefundCents ($${overrideTip}) exceeds original tip ($${originalTipNumber})`)
    }
    tipRefund = Math.round(overrideTip * 100) / 100
    salesRefund = Math.round((refundAmountInPesos - tipRefund) * 100) / 100
    if (salesRefund > originalAmountNumber + 0.001) {
      throw new BadRequestError(`Sale portion of refund ($${salesRefund}) exceeds original sale amount ($${originalAmountNumber})`)
    }
  } else if (originalTipNumber > 0 && totalOriginalAmount > 0) {
    // Default: proportional split.
    tipRefund = Math.round(((refundAmountInPesos * originalTipNumber) / totalOriginalAmount) * 100) / 100
    tipRefund = Math.min(tipRefund, originalTipNumber)
    salesRefund = Math.round((refundAmountInPesos - tipRefund) * 100) / 100
    if (salesRefund > originalAmountNumber) {
      const excess = salesRefund - originalAmountNumber
      salesRefund -= excess
      tipRefund = Math.round((tipRefund + excess) * 100) / 100
    }
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
    // 🔒 Row-lock the original payment for the duration of this tx so
    // concurrent refund attempts cannot both pass the "remaining refundable"
    // check with stale data and each create their own refund (D8 race).
    const lockedRows = await tx.$queryRaw<Array<{ id: string; amount: unknown; tipAmount: unknown; processorData: unknown }>>(Prisma.sql`
      SELECT id, amount, "tipAmount", "processorData"
      FROM "Payment"
      WHERE id = ${refundData.originalPaymentId}
      FOR UPDATE
    `)
    const locked = lockedRows[0]
    if (!locked) {
      throw new NotFoundError(`Payment ${refundData.originalPaymentId} disappeared`)
    }
    const lockedProcessorData = (locked.processorData as Record<string, unknown> | null) ?? {}
    const lockedAlreadyRefunded = Number(lockedProcessorData.refundedAmount ?? 0)
    const lockedTotal = Number(locked.amount) + Number(locked.tipAmount ?? 0)
    const lockedRemaining = lockedTotal - lockedAlreadyRefunded
    if (refundAmountInPesos > lockedRemaining + 0.001) {
      throw new BadRequestError(`Refund amount (${refundAmountInPesos}) exceeds remaining refundable amount (${lockedRemaining})`)
    }

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

        // Negative amount/tip mirror the original split.
        amount: new Decimal(-salesRefund),
        tipAmount: new Decimal(-tipRefund),

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
          // Parity fields with dashboard/mobile refunds so downstream
          // consumers (backfill script, reports) treat TPV refunds uniformly.
          amountCents: Math.round(refundAmountInPesos * 100),
          amount: refundAmountInPesos,
          // Marker: shift totalSales decrement is applied in-line below.
          // `scripts/backfill-refund-shift-totals.ts` skips rows with this flag.
          shiftBackfilled: true,
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

    // Mirror the dashboard/mobile `refunds[]` schema so readers that only know
    // the new format (e.g. `transaction.mobile.service.ts:208`) can aggregate
    // TPV-originated refunds without special casing. Keep `refundHistory`
    // intact for backwards compatibility with legacy readers.
    const existingRefundsArray = Array.isArray((processorData as Record<string, unknown>).refunds)
      ? ((processorData as Record<string, unknown>).refunds as Prisma.JsonArray)
      : []
    const newRefundsEntry = {
      refundPaymentId: refundPayment.id,
      amount: refundAmountInPesos,
      amountCents: Math.round(refundAmountInPesos * 100),
      reason: refundData.reason,
      at: new Date().toISOString(),
    }

    // Build updated processorData as plain object for Prisma JSON field
    const updatedProcessorData = {
      ...processorData,
      refundedAmount: newRefundedAmount,
      refundedAmountCents: Math.round(newRefundedAmount * 100),
      isFullyRefunded,
      lastRefundId: refundPayment.id,
      lastRefundAt: new Date().toISOString(),
      refundHistory: [...(existingHistory as Prisma.JsonArray), newRefundEntry],
      refunds: [...existingRefundsArray, newRefundsEntry],
    } as Prisma.InputJsonValue

    await tx.payment.update({
      where: { id: refundData.originalPaymentId },
      data: {
        processorData: updatedProcessorData,
      },
    })

    // Mirror dashboard/mobile: create a VenueTransaction row so accounting
    // reports see the outgoing refund alongside the original charge.
    await tx.venueTransaction.create({
      data: {
        venueId,
        paymentId: refundPayment.id,
        type: 'REFUND',
        grossAmount: new Decimal(-refundAmountInPesos),
        feeAmount: new Decimal(0),
        netAmount: new Decimal(-refundAmountInPesos),
        status: 'SETTLED',
      },
    })

    // Decrement Shift.totalSales (and totalTips when applicable) so closeout
    // reports reflect reality. Uses the same proportional split computed above
    // so tip refunds don't incorrectly deflate sales.
    if (shiftId) {
      await tx.shift.update({
        where: { id: shiftId },
        data: {
          totalSales: { decrement: new Decimal(salesRefund) },
          ...(tipRefund > 0 ? { totalTips: { decrement: new Decimal(tipRefund) } } : {}),
        },
      })
    }

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
  // STEP 5b: Create negative CommissionCalculation for refund (non-blocking)
  // ═══════════════════════════════════════════════════════════════════════════
  createRefundCommission(result.id, refundData.originalPaymentId).catch(error => {
    // Don't fail the refund if commission reversal fails
    logger.error('Failed to create refund commission', {
      refundPaymentId: result.id,
      originalPaymentId: refundData.originalPaymentId,
      error: error instanceof Error ? error.message : String(error),
    })
  })

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
    // Total refund = abs(amount) + abs(tipAmount). Since the tip-split fix
    // (2026-04-19) Payment.amount holds only the sale portion and tipAmount
    // holds the tip portion. TPV Android expects the TOTAL refund amount.
    amount: Math.abs(Number(result.amount)) + Math.abs(Number(result.tipAmount ?? 0)),
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
