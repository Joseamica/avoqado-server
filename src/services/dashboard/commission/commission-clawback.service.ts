/**
 * Commission Clawback Service
 *
 * Handles clawback of commissions after payout.
 * Clawbacks occur when refunds happen after commission was already paid.
 *
 * Key Business Rules:
 * - Clawbacks only apply to PAID commissions
 * - Creates negative adjustments for future payouts
 * - Tracks reason (REFUND, CHARGEBACK, CORRECTION, FRAUD)
 * - Maintains full audit trail
 */

import prisma from '../../../utils/prismaClient'
import logger from '../../../config/logger'
import { Prisma, ClawbackReason, CommissionCalcStatus } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../../errors/AppError'
import { decimalToNumber } from './commission-utils'

// ============================================
// Type Definitions
// ============================================

export interface CreateClawbackInput {
  reason: ClawbackReason
  notes?: string
  refundPaymentId?: string
}

export interface ClawbackFilters {
  staffId?: string
  reason?: ClawbackReason
  startDate?: Date
  endDate?: Date
  applied?: boolean
}

// ============================================
// Read Operations
// ============================================

/**
 * Get all clawbacks for a venue
 */
export async function getClawbacks(venueId: string, filters: ClawbackFilters = {}): Promise<any[]> {
  const where: Prisma.CommissionClawbackWhereInput = {
    calculation: { venueId },
  }

  if (filters.staffId) {
    where.calculation = { ...(where.calculation as any), staffId: filters.staffId }
  }

  if (filters.reason) where.reason = filters.reason

  if (filters.startDate || filters.endDate) {
    where.createdAt = {}
    if (filters.startDate) where.createdAt.gte = filters.startDate
    if (filters.endDate) where.createdAt.lte = filters.endDate
  }

  if (filters.applied !== undefined) {
    where.appliedAt = filters.applied ? { not: null } : null
  }

  return prisma.commissionClawback.findMany({
    where,
    include: {
      calculation: {
        include: {
          staff: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
          payment: {
            select: {
              id: true,
              amount: true,
            },
          },
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })
}

/**
 * Get a single clawback by ID
 */
export async function getClawbackById(clawbackId: string, venueId: string): Promise<any> {
  const clawback = await prisma.commissionClawback.findFirst({
    where: {
      id: clawbackId,
      calculation: { venueId },
    },
    include: {
      calculation: {
        include: {
          staff: true,
          payment: true,
          order: true,
          summary: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  if (!clawback) {
    throw new NotFoundError(`Clawback ${clawbackId} not found`)
  }

  return clawback
}

/**
 * Get pending clawbacks for a staff member
 * These need to be deducted from future payouts
 */
export async function getPendingClawbacksForStaff(staffId: string, venueId: string): Promise<{ clawbacks: any[]; totalAmount: number }> {
  const clawbacks = await prisma.commissionClawback.findMany({
    where: {
      calculation: {
        staffId,
        venueId,
      },
      appliedAt: null, // Not yet applied to a payout
    },
    include: {
      calculation: {
        select: {
          id: true,
          paymentId: true,
          netCommission: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  const totalAmount = clawbacks.reduce((sum, c) => sum + decimalToNumber(c.amount), 0)

  return { clawbacks, totalAmount }
}

// ============================================
// Create Operations
// ============================================

/**
 * Create a clawback for a commission calculation
 *
 * Called when:
 * - A refund occurs after commission was paid
 * - A chargeback is received
 * - A manual correction is needed
 * - Fraud is detected
 */
export async function createClawback(calculationId: string, venueId: string, data: CreateClawbackInput, createdById: string): Promise<any> {
  // Verify calculation exists and was paid
  const calculation = await prisma.commissionCalculation.findFirst({
    where: {
      id: calculationId,
      venueId,
    },
    include: {
      summary: {
        include: {
          payouts: {
            where: { status: 'PAID' },
          },
        },
      },
    },
  })

  if (!calculation) {
    throw new NotFoundError(`Commission calculation ${calculationId} not found`)
  }

  // Check if commission was already paid out
  const wasPaid = calculation.summary?.payouts?.some(p => p.status === 'PAID')

  if (!wasPaid && data.reason !== ClawbackReason.CORRECTION) {
    // If not paid, we can just void the calculation instead of clawback
    logger.info('Commission not yet paid, voiding instead of clawback', {
      calculationId,
      reason: data.reason,
    })

    await prisma.commissionCalculation.update({
      where: { id: calculationId },
      data: {
        status: CommissionCalcStatus.VOIDED,
        voidedAt: new Date(),
        voidedBy: createdById,
        voidReason: `${data.reason}: ${data.notes ?? 'No notes'}`,
      },
    })

    return { voided: true, calculationId }
  }

  // Calculate clawback amount (same as original commission)
  const clawbackAmount = decimalToNumber(calculation.netCommission)

  // Check for existing clawback
  const existingClawback = await prisma.commissionClawback.findFirst({
    where: {
      calculationId,
      reason: data.reason,
    },
  })

  if (existingClawback) {
    throw new BadRequestError(`Clawback already exists for this calculation with reason ${data.reason}`)
  }

  // summaryId is required - use calculation's summaryId
  if (!calculation.summaryId) {
    throw new BadRequestError('Commission calculation does not have an associated summary yet')
  }

  const clawback = await prisma.commissionClawback.create({
    data: {
      calculationId,
      summaryId: calculation.summaryId,
      amount: clawbackAmount,
      reason: data.reason,
      notes: data.notes,
      refundPaymentId: data.refundPaymentId,
      createdById,
    },
    include: {
      calculation: {
        select: {
          staffId: true,
          netCommission: true,
        },
      },
    },
  })

  logger.info('Commission clawback created', {
    clawbackId: clawback.id,
    calculationId,
    staffId: calculation.staffId,
    amount: clawbackAmount,
    reason: data.reason,
    createdById,
  })

  return clawback
}

/**
 * Create clawback for a refund (called from refund hook)
 */
export async function createRefundClawback(
  originalPaymentId: string,
  refundPaymentId: string,
  refundAmount: number,
  createdById: string,
): Promise<any | null> {
  // Find commission calculation for original payment
  const calculation = await prisma.commissionCalculation.findFirst({
    where: {
      paymentId: originalPaymentId,
      status: { not: CommissionCalcStatus.VOIDED },
    },
    include: {
      summary: {
        include: {
          payouts: {
            where: { status: 'PAID' },
          },
        },
      },
    },
  })

  if (!calculation) {
    logger.info('No commission found for refunded payment', {
      originalPaymentId,
      refundPaymentId,
    })
    return null
  }

  const wasPaid = calculation.summary?.payouts?.some(p => p.status === 'PAID')

  if (!wasPaid) {
    logger.info('Commission not yet paid, skipping clawback', {
      originalPaymentId,
      calculationId: calculation.id,
    })
    return null
  }

  // summaryId is required
  if (!calculation.summaryId) {
    logger.warn('Commission calculation has no summary, cannot create clawback', {
      originalPaymentId,
      calculationId: calculation.id,
    })
    return null
  }

  // Calculate proportional clawback
  const originalAmount = decimalToNumber(calculation.baseAmount)
  const refundRatio = originalAmount > 0 ? refundAmount / originalAmount : 1
  const clawbackAmount = decimalToNumber(calculation.netCommission) * refundRatio

  const clawback = await prisma.commissionClawback.create({
    data: {
      calculationId: calculation.id,
      summaryId: calculation.summaryId,
      amount: clawbackAmount,
      reason: ClawbackReason.REFUND,
      notes: `Refund of ${refundAmount} (${(refundRatio * 100).toFixed(1)}% of original)`,
      refundPaymentId,
      createdById,
    },
  })

  logger.info('Refund clawback created', {
    clawbackId: clawback.id,
    calculationId: calculation.id,
    originalPaymentId,
    refundPaymentId,
    refundRatio,
    clawbackAmount,
  })

  return clawback
}

// ============================================
// Apply Operations
// ============================================

/**
 * Apply pending clawbacks to a summary
 * Called during aggregation or payout creation
 */
export async function applyClawbacksToSummary(summaryId: string, venueId: string): Promise<number> {
  const summary = await prisma.commissionSummary.findFirst({
    where: { id: summaryId, venueId },
  })

  if (!summary) {
    throw new NotFoundError(`Summary ${summaryId} not found`)
  }

  // Get pending clawbacks for this staff
  const pendingClawbacks = await prisma.commissionClawback.findMany({
    where: {
      calculation: {
        staffId: summary.staffId,
        venueId,
      },
      appliedAt: null,
    },
  })

  if (pendingClawbacks.length === 0) {
    return 0
  }

  const totalClawback = pendingClawbacks.reduce((sum, c) => sum + decimalToNumber(c.amount), 0)

  // Apply clawbacks as deduction
  await prisma.$transaction(async tx => {
    // Update summary with deduction
    const currentDeduction = decimalToNumber(summary.deductionAmount)
    const newDeduction = currentDeduction + totalClawback
    const newNetAmount = decimalToNumber(summary.grossAmount) - newDeduction

    await tx.commissionSummary.update({
      where: { id: summaryId },
      data: {
        deductionAmount: newDeduction,
        netAmount: Math.max(0, newNetAmount), // Don't go negative
        notes: summary.notes ? `${summary.notes}\nClawbacks applied: ${totalClawback}` : `Clawbacks applied: ${totalClawback}`,
        version: { increment: 1 },
      },
    })

    // Mark clawbacks as applied
    await tx.commissionClawback.updateMany({
      where: {
        id: { in: pendingClawbacks.map(c => c.id) },
      },
      data: {
        appliedAt: new Date(),
        appliedToSummaryId: summaryId,
      },
    })
  })

  logger.info('Clawbacks applied to summary', {
    summaryId,
    clawbackCount: pendingClawbacks.length,
    totalClawback,
  })

  return totalClawback
}

// ============================================
// Delete/Void Operations
// ============================================

/**
 * Void a clawback (reverse it)
 * Only possible if not yet applied
 */
export async function voidClawback(clawbackId: string, venueId: string, voidedById: string, reason: string): Promise<void> {
  const clawback = await prisma.commissionClawback.findFirst({
    where: {
      id: clawbackId,
      calculation: { venueId },
    },
  })

  if (!clawback) {
    throw new NotFoundError(`Clawback ${clawbackId} not found`)
  }

  if (clawback.appliedAt) {
    throw new BadRequestError('Cannot void clawback that has been applied. Create a correction instead.')
  }

  await prisma.commissionClawback.delete({
    where: { id: clawbackId },
  })

  logger.info('Clawback voided', {
    clawbackId,
    venueId,
    voidedById,
    reason,
  })
}

// ============================================
// Statistics
// ============================================

/**
 * Get clawback statistics for a venue
 */
export async function getClawbackStats(
  venueId: string,
  startDate: Date,
  endDate: Date,
): Promise<{
  totalClawbacks: number
  clawbackCount: number
  byReason: Record<ClawbackReason, number>
  pendingAmount: number
}> {
  const [stats, byReason, pending] = await Promise.all([
    prisma.commissionClawback.aggregate({
      where: {
        calculation: { venueId },
        createdAt: { gte: startDate, lte: endDate },
      },
      _sum: { amount: true },
      _count: { id: true },
    }),
    prisma.commissionClawback.groupBy({
      by: ['reason'],
      where: {
        calculation: { venueId },
        createdAt: { gte: startDate, lte: endDate },
      },
      _sum: { amount: true },
    }),
    prisma.commissionClawback.aggregate({
      where: {
        calculation: { venueId },
        appliedAt: null,
      },
      _sum: { amount: true },
    }),
  ])

  const byReasonMap = {} as Record<ClawbackReason, number>
  for (const r of byReason) {
    byReasonMap[r.reason] = decimalToNumber(r._sum.amount)
  }

  return {
    totalClawbacks: decimalToNumber(stats._sum.amount),
    clawbackCount: stats._count.id,
    byReason: byReasonMap,
    pendingAmount: decimalToNumber(pending._sum.amount),
  }
}
