/**
 * Commission Calculation Service
 *
 * Creates immutable commission records following the TransactionCost pattern.
 * Called automatically when a Payment is COMPLETED.
 *
 * Key Business Rules:
 * - Commissions are BONUSES for employees (they earn MORE based on sales)
 * - Tips are NOT included by default (tips are already direct bonus)
 * - Idempotent: Won't create duplicate for same payment
 * - Rate cascade: Override > Tier > Role Rate > Default Rate
 * - Creates negative records for refunds (proportional to original)
 *
 * Flow:
 * 1. Payment COMPLETED → createCommissionForPayment()
 * 2. Find active config for venue
 * 3. Determine recipient (CREATOR/SERVER/PROCESSOR)
 * 4. Check for override/tier rates
 * 5. Calculate commission
 * 6. Create immutable CommissionCalculation record
 */

import prisma from '../../../utils/prismaClient'
import logger from '../../../config/logger'
import { Prisma, CommissionCalcType, CommissionCalcStatus, PaymentType, CommissionRecipient } from '@prisma/client'
import { NotFoundError, BadRequestError } from '../../../errors/AppError'
import {
  findActiveCommissionConfig,
  findActiveOverride,
  getRecipientStaffId,
  calculateFinalRate,
  applyCommissionBounds,
  calculateBaseAmount,
  validateStaffForCommission,
  commissionExistsForPayment,
  decimalToNumber,
} from './commission-utils'
import { getApplicableTierRate } from './commission-tier.service'

// ============================================
// Type Definitions
// ============================================

export interface CommissionCalculationResult {
  calculationId: string
  paymentId: string
  staffId: string
  baseAmount: number
  effectiveRate: number
  grossCommission: number
  netCommission: number
  tierLevel?: number
  tierName?: string
}

// ============================================
// Main Entry Points
// ============================================

/**
 * Create commission calculation for a payment
 *
 * This is the main entry point, called after payment COMPLETED.
 * Follows TransactionCost pattern: create immutable financial record.
 *
 * @param paymentId - Payment ID that triggered this calculation
 * @returns Commission calculation result or null if skipped
 */
export async function createCommissionForPayment(paymentId: string): Promise<CommissionCalculationResult | null> {
  logger.info('Creating commission for payment', { paymentId })

  // ========================================
  // Step 1: Load Payment with Relations
  // ========================================

  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      order: {
        select: {
          id: true,
          createdById: true,
          servedById: true,
          subtotal: true,
          discountAmount: true,
          taxAmount: true,
        },
      },
      shift: {
        select: {
          id: true,
        },
      },
      venue: {
        select: {
          id: true,
          timezone: true,
        },
      },
    },
  })

  if (!payment) {
    throw new NotFoundError(`Payment ${paymentId} not found`)
  }

  // ========================================
  // Step 2: Eligibility Validation
  // ========================================

  // Skip TEST payments (no real money)
  if (payment.type === PaymentType.TEST) {
    logger.info('Skipping commission: TEST payment', { paymentId })
    return null
  }

  // Skip non-COMPLETED payments
  if (payment.status !== 'COMPLETED') {
    logger.info('Skipping commission: Payment not COMPLETED', {
      paymentId,
      status: payment.status,
    })
    return null
  }

  // Idempotency: Check if commission already exists
  if (await commissionExistsForPayment(paymentId)) {
    logger.info('Commission already exists for payment', { paymentId })
    return null
  }

  // ========================================
  // Step 3: Find Active Commission Config
  // ========================================

  const config = await findActiveCommissionConfig(payment.venueId, payment.createdAt)

  if (!config) {
    logger.info('No active commission config for venue', {
      paymentId,
      venueId: payment.venueId,
    })
    return null
  }

  // ========================================
  // Step 4: Determine Recipient Staff
  // ========================================

  const recipientStaffId = getRecipientStaffId({ processedById: payment.processedById }, payment.order, config.recipient)

  if (!recipientStaffId) {
    logger.warn('Could not determine commission recipient', {
      paymentId,
      recipientType: config.recipient,
      orderId: payment.orderId,
    })
    return null
  }

  // Validate staff is active and can receive commissions
  const staffInfo = await validateStaffForCommission(recipientStaffId, payment.venueId)
  if (!staffInfo) {
    logger.info('Staff not eligible for commission', {
      paymentId,
      staffId: recipientStaffId,
    })
    return null
  }

  // ========================================
  // Step 5: Check for Override
  // ========================================

  const override = await findActiveOverride(config.id, recipientStaffId, payment.createdAt)

  // If staff is excluded from commissions
  if (override?.excludeFromCommissions) {
    logger.info('Staff excluded from commissions via override', {
      paymentId,
      staffId: recipientStaffId,
      overrideId: override.id,
    })
    return null
  }

  // ========================================
  // Step 6: Calculate Base Amount
  // ========================================

  const { baseAmount, tipAmount, discountAmount, taxAmount } = calculateBaseAmount(
    {
      amount: payment.amount,
      tipAmount: payment.tipAmount,
      taxAmount: payment.order?.taxAmount,
      discountAmount: payment.order?.discountAmount,
    },
    config,
  )

  if (baseAmount <= 0) {
    logger.info('Skipping commission: Base amount is zero or negative', {
      paymentId,
      baseAmount,
    })
    return null
  }

  // ========================================
  // Step 7: Determine Rate
  // ========================================

  let tierLevel: number | undefined
  let tierName: string | undefined
  let tierRate: number | null = null

  // Check for tier rate if config is TIERED
  if (config.calcType === CommissionCalcType.TIERED) {
    const tierInfo = await getApplicableTierRate(config.id, recipientStaffId, payment.venueId)
    if (tierInfo) {
      tierLevel = tierInfo.tierLevel
      tierName = tierInfo.tierName
      tierRate = tierInfo.rate
    }
  }

  // Calculate final rate with cascade
  const effectiveRate = calculateFinalRate(config, override, staffInfo.role, tierRate)

  // ========================================
  // Step 8: Calculate Commission
  // ========================================

  let grossCommission: number
  let netCommission: number

  switch (config.calcType) {
    case CommissionCalcType.FIXED:
      // Fixed amount per transaction
      grossCommission = decimalToNumber(config.defaultRate) // For FIXED, defaultRate is the fixed amount
      break

    case CommissionCalcType.PERCENTAGE:
    case CommissionCalcType.TIERED:
    default:
      // Percentage of base amount
      grossCommission = baseAmount * effectiveRate
      break
  }

  // Apply min/max bounds
  netCommission = applyCommissionBounds(grossCommission, config)

  // Round to 2 decimal places
  grossCommission = Math.round(grossCommission * 100) / 100
  netCommission = Math.round(netCommission * 100) / 100

  logger.info('Commission calculated', {
    paymentId,
    staffId: recipientStaffId,
    baseAmount,
    effectiveRate,
    grossCommission,
    netCommission,
    tierLevel,
  })

  // ========================================
  // Step 9: Create Immutable Record
  // ========================================

  const calculation = await prisma.commissionCalculation.create({
    data: {
      venueId: payment.venueId,
      staffId: recipientStaffId,
      paymentId: payment.id,
      orderId: payment.orderId,
      shiftId: payment.shift?.id,
      configId: config.id,

      // Snapshot of amounts at calculation time
      baseAmount,
      tipAmount,
      discountAmount,
      taxAmount,

      // Commission calculation
      effectiveRate,
      grossCommission,
      netCommission,

      // Metadata
      calcType: config.calcType,
      tier: tierLevel,
      tierName,

      status: CommissionCalcStatus.CALCULATED,
      calculatedAt: new Date(),
    },
  })

  logger.info('Commission calculation created', {
    calculationId: calculation.id,
    paymentId,
    staffId: recipientStaffId,
    netCommission,
  })

  return {
    calculationId: calculation.id,
    paymentId,
    staffId: recipientStaffId,
    baseAmount,
    effectiveRate,
    grossCommission,
    netCommission,
    tierLevel,
    tierName,
  }
}

/**
 * Create negative commission record for a refund
 *
 * Mirrors the original payment's commission proportionally.
 * This ensures SUM(netCommission) reflects actual earnings after refunds.
 *
 * @param refundPaymentId - The refund Payment ID
 * @param originalPaymentId - The original Payment that was refunded
 * @returns Commission calculation result or null if skipped
 */
export async function createRefundCommission(
  refundPaymentId: string,
  originalPaymentId: string,
): Promise<CommissionCalculationResult | null> {
  logger.info('Creating refund commission', { refundPaymentId, originalPaymentId })

  // Find original commission calculation
  const originalCalc = await prisma.commissionCalculation.findFirst({
    where: {
      paymentId: originalPaymentId,
      status: { not: CommissionCalcStatus.VOIDED },
    },
  })

  if (!originalCalc) {
    logger.info('No commission found for original payment, skipping refund commission', {
      refundPaymentId,
      originalPaymentId,
    })
    return null
  }

  // Fetch refund payment
  const refundPayment = await prisma.payment.findUnique({
    where: { id: refundPaymentId },
  })

  if (!refundPayment) {
    throw new NotFoundError(`Refund payment ${refundPaymentId} not found`)
  }

  // Calculate refund ratio (for partial refunds)
  const originalBaseAmount = decimalToNumber(originalCalc.baseAmount)
  const refundAmount = Math.abs(decimalToNumber(refundPayment.amount))
  const refundRatio = originalBaseAmount > 0 ? refundAmount / originalBaseAmount : 1

  // Calculate negative commission proportionally
  const negativeGrossCommission = -decimalToNumber(originalCalc.grossCommission) * refundRatio
  const negativeNetCommission = -decimalToNumber(originalCalc.netCommission) * refundRatio

  // Create negative commission record
  const calculation = await prisma.commissionCalculation.create({
    data: {
      venueId: originalCalc.venueId,
      staffId: originalCalc.staffId,
      paymentId: refundPaymentId,
      orderId: originalCalc.orderId,
      shiftId: originalCalc.shiftId,
      configId: originalCalc.configId,

      // Negative amounts
      baseAmount: -refundAmount,
      tipAmount: -decimalToNumber(originalCalc.tipAmount) * refundRatio,
      discountAmount: -decimalToNumber(originalCalc.discountAmount) * refundRatio,
      taxAmount: -decimalToNumber(originalCalc.taxAmount) * refundRatio,

      // Negative commission (same rate as original)
      effectiveRate: originalCalc.effectiveRate,
      grossCommission: negativeGrossCommission,
      netCommission: negativeNetCommission,

      // Metadata
      calcType: originalCalc.calcType,
      tier: originalCalc.tier,
      tierName: originalCalc.tierName,

      status: CommissionCalcStatus.CALCULATED,
      calculatedAt: new Date(),
    },
  })

  logger.info('Refund commission created', {
    calculationId: calculation.id,
    refundPaymentId,
    originalPaymentId,
    refundRatio,
    negativeNetCommission,
  })

  return {
    calculationId: calculation.id,
    paymentId: refundPaymentId,
    staffId: originalCalc.staffId,
    baseAmount: -refundAmount,
    effectiveRate: decimalToNumber(originalCalc.effectiveRate),
    grossCommission: negativeGrossCommission,
    netCommission: negativeNetCommission,
  }
}

// ============================================
// Void / Correction Operations
// ============================================

/**
 * Void a commission calculation (mark as VOIDED with reason)
 *
 * Used when a calculation was created in error or needs to be excluded.
 * Does NOT delete the record - maintains audit trail.
 */
export async function voidCommissionCalculation(calculationId: string, venueId: string, voidedById: string, reason: string): Promise<void> {
  const calculation = await prisma.commissionCalculation.findFirst({
    where: {
      id: calculationId,
      venueId,
      status: { not: CommissionCalcStatus.VOIDED },
    },
  })

  if (!calculation) {
    throw new NotFoundError(`Commission calculation ${calculationId} not found`)
  }

  // Cannot void if already aggregated into a summary
  if (calculation.status === CommissionCalcStatus.AGGREGATED) {
    throw new BadRequestError('Cannot void calculation that has been aggregated. Create a correction instead.')
  }

  await prisma.commissionCalculation.update({
    where: { id: calculationId },
    data: {
      status: CommissionCalcStatus.VOIDED,
      voidedAt: new Date(),
      voidedBy: voidedById,
      voidReason: reason,
    },
  })

  logger.info('Commission calculation voided', {
    calculationId,
    venueId,
    voidedById,
    reason,
  })
}

/**
 * Create a manual commission calculation (for adjustments/corrections)
 */
export async function createManualCommission(
  venueId: string,
  staffId: string,
  amount: number,
  reason: string,
  createdById: string,
  orderId?: string,
  shiftId?: string,
): Promise<CommissionCalculationResult> {
  // Validate staff
  const staffInfo = await validateStaffForCommission(staffId, venueId)
  if (!staffInfo) {
    throw new BadRequestError(`Staff ${staffId} is not active in venue ${venueId}`)
  }

  // Find any active config (for reference, not for rate calculation)
  const config = await findActiveCommissionConfig(venueId)

  const calculation = await prisma.commissionCalculation.create({
    data: {
      venueId,
      staffId,
      orderId,
      shiftId,
      configId: config?.id ?? '', // May be empty for pure manual adjustments

      baseAmount: Math.abs(amount), // Store absolute value
      tipAmount: 0,
      discountAmount: 0,
      taxAmount: 0,

      effectiveRate: amount >= 0 ? 1 : -1, // +1 for bonus, -1 for deduction
      grossCommission: amount,
      netCommission: amount,

      calcType: CommissionCalcType.MANUAL,

      status: CommissionCalcStatus.CALCULATED,
      calculatedAt: new Date(),
    },
  })

  logger.info('Manual commission created', {
    calculationId: calculation.id,
    venueId,
    staffId,
    amount,
    reason,
    createdById,
  })

  return {
    calculationId: calculation.id,
    paymentId: '', // No payment for manual
    staffId,
    baseAmount: Math.abs(amount),
    effectiveRate: amount >= 0 ? 1 : -1,
    grossCommission: amount,
    netCommission: amount,
  }
}

// ============================================
// Query Operations
// ============================================

/**
 * Get commission calculations for a staff member
 * Returns calculations, summaries, stats, and tier progress
 */
export async function getStaffCommissions(
  staffId: string,
  venueId: string,
  filters: {
    startDate?: Date
    endDate?: Date
    status?: CommissionCalcStatus
    limit?: number
    offset?: number
  } = {},
): Promise<{
  calculations: any[]
  total: number
  summaries: any[]
  stats: {
    thisMonth: number
    lastMonth: number
    total: number
  }
  tierProgress: {
    currentTier: string | null
    nextTier: string | null
    currentAmount: number
    nextThreshold: number | null
    progress: number
  } | null
}> {
  const where: Prisma.CommissionCalculationWhereInput = {
    staffId,
    venueId,
  }

  if (filters.status) {
    where.status = filters.status
  }

  if (filters.startDate || filters.endDate) {
    where.calculatedAt = {}
    if (filters.startDate) where.calculatedAt.gte = filters.startDate
    if (filters.endDate) where.calculatedAt.lte = filters.endDate
  }

  // Calculate date ranges for stats
  const now = new Date()
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)

  const [calculations, total, summaries, thisMonthStats, lastMonthStats, totalStats] = await Promise.all([
    // Calculations
    prisma.commissionCalculation.findMany({
      where,
      include: {
        payment: {
          select: {
            id: true,
            amount: true,
            tipAmount: true,
            method: true,
          },
        },
        order: {
          select: {
            id: true,
            orderNumber: true,
          },
        },
        config: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: { calculatedAt: 'desc' },
      take: filters.limit ?? 50,
      skip: filters.offset ?? 0,
    }),
    // Total count
    prisma.commissionCalculation.count({ where }),
    // Summaries for this staff member
    prisma.commissionSummary.findMany({
      where: {
        staffId,
        venueId,
      },
      orderBy: { periodEnd: 'desc' },
      take: 12, // Last 12 periods
    }),
    // This month stats
    prisma.commissionCalculation.aggregate({
      where: {
        staffId,
        venueId,
        status: { not: CommissionCalcStatus.VOIDED },
        calculatedAt: { gte: thisMonthStart },
      },
      _sum: { netCommission: true },
    }),
    // Last month stats
    prisma.commissionCalculation.aggregate({
      where: {
        staffId,
        venueId,
        status: { not: CommissionCalcStatus.VOIDED },
        calculatedAt: { gte: lastMonthStart, lte: lastMonthEnd },
      },
      _sum: { netCommission: true },
    }),
    // Total all-time stats
    prisma.commissionCalculation.aggregate({
      where: {
        staffId,
        venueId,
        status: { not: CommissionCalcStatus.VOIDED },
      },
      _sum: { netCommission: true },
    }),
  ])

  // Calculate stats
  const stats = {
    thisMonth: decimalToNumber(thisMonthStats._sum.netCommission),
    lastMonth: decimalToNumber(lastMonthStats._sum.netCommission),
    total: decimalToNumber(totalStats._sum.netCommission),
  }

  // Get tier progress (if tiered config exists)
  let tierProgress: {
    currentTier: string | null
    nextTier: string | null
    currentAmount: number
    nextThreshold: number | null
    progress: number
  } | null = null

  // Find active tiered config for this venue
  const tieredConfig = await prisma.commissionConfig.findFirst({
    where: {
      venueId,
      active: true,
      calcType: CommissionCalcType.TIERED,
    },
    include: {
      tiers: {
        orderBy: { tierLevel: 'asc' },
      },
    },
  })

  if (tieredConfig && tieredConfig.tiers.length > 0) {
    // Get current period sales for tier calculation
    const currentPeriodAmount = stats.thisMonth // Use this month for now (could be configurable)

    // Find current and next tier
    let currentTier: string | null = null
    let nextTier: string | null = null
    let nextThreshold: number | null = null

    for (let i = 0; i < tieredConfig.tiers.length; i++) {
      const tier = tieredConfig.tiers[i]
      const minThreshold = decimalToNumber(tier.minThreshold)
      const maxThreshold = tier.maxThreshold ? decimalToNumber(tier.maxThreshold) : Infinity

      if (currentPeriodAmount >= minThreshold && currentPeriodAmount < maxThreshold) {
        currentTier = tier.tierName
        if (i + 1 < tieredConfig.tiers.length) {
          nextTier = tieredConfig.tiers[i + 1].tierName
          nextThreshold = decimalToNumber(tieredConfig.tiers[i + 1].minThreshold)
        }
        break
      }
    }

    // If no tier matched, they're below the first tier
    if (!currentTier && tieredConfig.tiers.length > 0) {
      nextTier = tieredConfig.tiers[0].tierName
      nextThreshold = decimalToNumber(tieredConfig.tiers[0].minThreshold)
    }

    tierProgress = {
      currentTier,
      nextTier,
      currentAmount: currentPeriodAmount,
      nextThreshold,
      progress: nextThreshold ? Math.min((currentPeriodAmount / nextThreshold) * 100, 100) : 100,
    }
  }

  return { calculations, total, summaries, stats, tierProgress }
}

/**
 * Get commission summary stats for a staff member
 */
export async function getStaffCommissionStats(
  staffId: string,
  venueId: string,
  startDate: Date,
  endDate: Date,
): Promise<{
  totalEarned: number
  totalCalculations: number
  averageCommission: number
  averageRate: number
}> {
  const aggregation = await prisma.commissionCalculation.aggregate({
    where: {
      staffId,
      venueId,
      status: { not: CommissionCalcStatus.VOIDED },
      calculatedAt: { gte: startDate, lte: endDate },
    },
    _sum: {
      netCommission: true,
    },
    _count: {
      id: true,
    },
    _avg: {
      netCommission: true,
      effectiveRate: true,
    },
  })

  return {
    totalEarned: decimalToNumber(aggregation._sum.netCommission),
    totalCalculations: aggregation._count.id,
    averageCommission: decimalToNumber(aggregation._avg.netCommission),
    averageRate: decimalToNumber(aggregation._avg.effectiveRate),
  }
}

/**
 * Get pending (non-aggregated) calculations for a venue
 */
export async function getPendingCalculations(venueId: string, staffId?: string): Promise<any[]> {
  const where: Prisma.CommissionCalculationWhereInput = {
    venueId,
    status: CommissionCalcStatus.CALCULATED,
  }

  if (staffId) {
    where.staffId = staffId
  }

  return prisma.commissionCalculation.findMany({
    where,
    include: {
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
    orderBy: { calculatedAt: 'desc' },
  })
}

/**
 * Get venue-wide commission statistics
 */
export async function getVenueCommissionStats(venueId: string): Promise<{
  totalPaid: number
  totalPending: number
  totalApproved: number
  staffWithCommissions: number
  averageCommission: number
  topEarners: Array<{
    staffId: string
    staffName: string
    totalEarned: number
    calculationCount: number
  }>
}> {
  // Get summary stats by status
  const summaryStats = await prisma.commissionSummary.groupBy({
    by: ['status'],
    where: { venueId },
    _sum: { netAmount: true },
  })

  const totalPaid = decimalToNumber(summaryStats.find(s => s.status === 'PAID')?._sum.netAmount)
  const totalPending = decimalToNumber(summaryStats.find(s => s.status === 'PENDING_APPROVAL')?._sum.netAmount)
  const totalApproved = decimalToNumber(summaryStats.find(s => s.status === 'APPROVED')?._sum.netAmount)

  // Count unique staff with commissions
  const staffCount = await prisma.commissionCalculation.groupBy({
    by: ['staffId'],
    where: {
      venueId,
      status: { not: CommissionCalcStatus.VOIDED },
    },
  })

  // Get average commission
  const avgStats = await prisma.commissionCalculation.aggregate({
    where: {
      venueId,
      status: { not: CommissionCalcStatus.VOIDED },
    },
    _avg: { netCommission: true },
  })

  // Get top earners
  const topEarnersRaw = await prisma.commissionCalculation.groupBy({
    by: ['staffId'],
    where: {
      venueId,
      status: { not: CommissionCalcStatus.VOIDED },
    },
    _sum: { netCommission: true },
    _count: { id: true },
    orderBy: { _sum: { netCommission: 'desc' } },
    take: 5,
  })

  // Get staff names for top earners
  const staffIds = topEarnersRaw.map(e => e.staffId)
  const staffMembers = await prisma.staff.findMany({
    where: { id: { in: staffIds } },
    select: { id: true, firstName: true, lastName: true },
  })

  const staffMap = new Map(staffMembers.map(s => [s.id, s]))

  const topEarners = topEarnersRaw.map(e => {
    const staff = staffMap.get(e.staffId)
    return {
      staffId: e.staffId,
      staffName: staff ? `${staff.firstName} ${staff.lastName}` : 'Unknown',
      totalEarned: decimalToNumber(e._sum.netCommission),
      calculationCount: e._count.id,
    }
  })

  return {
    totalPaid,
    totalPending,
    totalApproved,
    staffWithCommissions: staffCount.length,
    averageCommission: decimalToNumber(avgStats._avg.netCommission),
    topEarners,
  }
}
