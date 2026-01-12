/**
 * Commission Aggregation Service
 *
 * Aggregates individual commission calculations into summaries.
 * Summaries are the basis for approval and payout.
 *
 * Key Business Rules:
 * - Runs daily (or on-demand) to aggregate CALCULATED records
 * - Creates one CommissionSummary per staff per period
 * - Summaries require approval before payout
 * - Uses optimistic concurrency (version field) for updates
 */

import prisma from '../../../utils/prismaClient'
import logger from '../../../config/logger'
import { Prisma, CommissionCalcStatus, CommissionSummaryStatus, TierPeriod } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../../errors/AppError'
import { decimalToNumber, getPeriodDateRange } from './commission-utils'

// ============================================
// Type Definitions
// ============================================

export interface AggregationResult {
  venueId: string
  summariesCreated: number
  summariesUpdated: number
  calculationsAggregated: number
}

export interface SummaryFilters {
  staffId?: string
  status?: CommissionSummaryStatus
  periodStart?: Date
  periodEnd?: Date
}

// ============================================
// Aggregation Operations
// ============================================

/**
 * Aggregate all pending calculations for a venue
 *
 * Creates or updates CommissionSummary records for each staff member.
 */
export async function aggregateVenueCommissions(venueId: string, period: TierPeriod = TierPeriod.WEEKLY): Promise<AggregationResult> {
  logger.info('Starting commission aggregation', { venueId, period })

  const { start: periodStart, end: periodEnd } = getPeriodDateRange(period)

  // Get all pending calculations grouped by staff
  const pendingByStaff = await prisma.commissionCalculation.groupBy({
    by: ['staffId'],
    where: {
      venueId,
      status: CommissionCalcStatus.CALCULATED,
      calculatedAt: { gte: periodStart, lte: periodEnd },
    },
    _sum: {
      baseAmount: true,
      netCommission: true,
    },
    _count: {
      id: true,
    },
  })

  let summariesCreated = 0
  let summariesUpdated = 0
  let calculationsAggregated = 0

  for (const group of pendingByStaff) {
    // Check if summary already exists for this staff/period
    const existingSummary = await prisma.commissionSummary.findFirst({
      where: {
        venueId,
        staffId: group.staffId,
        periodStart,
        periodEnd,
      },
    })

    const totalSales = decimalToNumber(group._sum.baseAmount)
    const totalCommissions = decimalToNumber(group._sum.netCommission)
    const paymentCount = group._count.id

    // Get milestone bonuses for this period
    const milestoneBonuses = await prisma.milestoneAchievement.aggregate({
      where: {
        staffId: group.staffId,
        venueId,
        achievedAt: { gte: periodStart, lte: periodEnd },
        includedInSummaryId: null, // Not yet included in any summary
      },
      _sum: {
        bonusAmount: true,
      },
    })

    const totalBonuses = decimalToNumber(milestoneBonuses._sum?.bonusAmount)
    const grossAmount = totalCommissions + totalBonuses

    if (existingSummary) {
      // Update existing summary
      await prisma.$transaction(async tx => {
        // Check version for optimistic concurrency
        const current = await tx.commissionSummary.findUnique({
          where: { id: existingSummary.id },
        })

        if (!current || current.version !== existingSummary.version) {
          throw new BadRequestError('Summary was modified by another process')
        }

        // Update summary
        await tx.commissionSummary.update({
          where: { id: existingSummary.id },
          data: {
            totalSales: { increment: totalSales },
            totalCommissions: { increment: totalCommissions },
            totalBonuses: { increment: totalBonuses },
            grossAmount: { increment: grossAmount },
            netAmount: { increment: grossAmount }, // Deductions applied later
            paymentCount: { increment: paymentCount },
            version: { increment: 1 },
            status: CommissionSummaryStatus.CALCULATED,
          },
        })

        // Mark calculations as aggregated
        await tx.commissionCalculation.updateMany({
          where: {
            venueId,
            staffId: group.staffId,
            status: CommissionCalcStatus.CALCULATED,
            calculatedAt: { gte: periodStart, lte: periodEnd },
          },
          data: {
            status: CommissionCalcStatus.AGGREGATED,
            aggregatedAt: new Date(),
            summaryId: existingSummary.id,
          },
        })

        // Link milestone achievements to summary
        await tx.milestoneAchievement.updateMany({
          where: {
            staffId: group.staffId,
            venueId,
            achievedAt: { gte: periodStart, lte: periodEnd },
            includedInSummaryId: null,
          },
          data: {
            includedInSummaryId: existingSummary.id,
          },
        })
      })

      summariesUpdated++
    } else {
      // Create new summary
      await prisma.$transaction(async tx => {
        const summary = await tx.commissionSummary.create({
          data: {
            venueId,
            staffId: group.staffId,
            periodType: period,
            periodStart,
            periodEnd,
            totalSales,
            totalCommissions,
            totalBonuses,
            deductionAmount: 0,
            grossAmount,
            netAmount: grossAmount,
            grandTotal: grossAmount,
            paymentCount,
            status: CommissionSummaryStatus.CALCULATED,
            version: 1,
          },
        })

        // Mark calculations as aggregated
        await tx.commissionCalculation.updateMany({
          where: {
            venueId,
            staffId: group.staffId,
            status: CommissionCalcStatus.CALCULATED,
            calculatedAt: { gte: periodStart, lte: periodEnd },
          },
          data: {
            status: CommissionCalcStatus.AGGREGATED,
            aggregatedAt: new Date(),
            summaryId: summary.id,
          },
        })

        // Link milestone achievements to summary
        await tx.milestoneAchievement.updateMany({
          where: {
            staffId: group.staffId,
            venueId,
            achievedAt: { gte: periodStart, lte: periodEnd },
            includedInSummaryId: null,
          },
          data: {
            includedInSummaryId: summary.id,
          },
        })
      })

      summariesCreated++
    }

    calculationsAggregated += paymentCount
  }

  logger.info('Commission aggregation completed', {
    venueId,
    period,
    summariesCreated,
    summariesUpdated,
    calculationsAggregated,
  })

  return {
    venueId,
    summariesCreated,
    summariesUpdated,
    calculationsAggregated,
  }
}

/**
 * Aggregate all pending commissions across all venues
 * Called by the daily aggregation job
 */
export async function aggregateAllPendingCommissions(): Promise<{
  venues: number
  summarized: number
}> {
  // Get all venues with pending calculations
  const venuesWithPending = await prisma.commissionCalculation.groupBy({
    by: ['venueId'],
    where: {
      status: CommissionCalcStatus.CALCULATED,
    },
    _count: {
      id: true,
    },
  })

  let totalSummarized = 0

  for (const { venueId } of venuesWithPending) {
    try {
      const result = await aggregateVenueCommissions(venueId)
      totalSummarized += result.calculationsAggregated
    } catch (error) {
      logger.error('Failed to aggregate commissions for venue', {
        venueId,
        error,
      })
    }
  }

  return {
    venues: venuesWithPending.length,
    summarized: totalSummarized,
  }
}

// ============================================
// Summary CRUD Operations
// ============================================

/**
 * Get commission summaries for a venue
 */
export async function getCommissionSummaries(venueId: string, filters: SummaryFilters = {}): Promise<any[]> {
  const where: Prisma.CommissionSummaryWhereInput = { venueId }

  if (filters.staffId) where.staffId = filters.staffId
  if (filters.status) where.status = filters.status

  if (filters.periodStart || filters.periodEnd) {
    if (filters.periodStart) {
      where.periodStart = { gte: filters.periodStart }
    }
    if (filters.periodEnd) {
      where.periodEnd = { lte: filters.periodEnd }
    }
  }

  return prisma.commissionSummary.findMany({
    where,
    include: {
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      approvedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      _count: {
        select: {
          calculations: true,
          payouts: true,
        },
      },
    },
    orderBy: [{ periodStart: 'desc' }, { staff: { lastName: 'asc' } }],
  })
}

/**
 * Get a single summary by ID
 */
export async function getSummaryById(summaryId: string, venueId: string): Promise<any> {
  const summary = await prisma.commissionSummary.findFirst({
    where: { id: summaryId, venueId },
    include: {
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      calculations: {
        orderBy: { calculatedAt: 'desc' },
        take: 100,
        include: {
          payment: {
            select: {
              id: true,
              amount: true,
              method: true,
            },
          },
          order: {
            select: {
              id: true,
              orderNumber: true,
            },
          },
        },
      },
      approvedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  if (!summary) {
    throw new NotFoundError(`Commission summary ${summaryId} not found`)
  }

  return summary
}

// ============================================
// Approval Operations
// ============================================

/**
 * Approve a commission summary
 * Only ADMIN/OWNER can approve
 */
export async function approveSummary(summaryId: string, venueId: string, approvedById: string): Promise<any> {
  const summary = await prisma.commissionSummary.findFirst({
    where: { id: summaryId, venueId },
  })

  if (!summary) {
    throw new NotFoundError(`Commission summary ${summaryId} not found`)
  }

  if (
    summary.status !== CommissionSummaryStatus.CALCULATED &&
    summary.status !== CommissionSummaryStatus.PENDING_APPROVAL &&
    summary.status !== CommissionSummaryStatus.DISPUTED
  ) {
    throw new BadRequestError(`Cannot approve summary with status ${summary.status}`)
  }

  const updated = await prisma.commissionSummary.update({
    where: { id: summaryId },
    data: {
      status: CommissionSummaryStatus.APPROVED,
      approvedById,
      approvedAt: new Date(),
      version: { increment: 1 },
    },
    include: {
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  logger.info('Commission summary approved', {
    summaryId,
    venueId,
    staffId: summary.staffId,
    netAmount: summary.netAmount,
    approvedById,
  })

  return updated
}

/**
 * Dispute a commission summary
 */
export async function disputeSummary(summaryId: string, venueId: string, disputedById: string, reason: string): Promise<any> {
  const summary = await prisma.commissionSummary.findFirst({
    where: { id: summaryId, venueId },
  })

  if (!summary) {
    throw new NotFoundError(`Commission summary ${summaryId} not found`)
  }

  if (summary.status === CommissionSummaryStatus.PAID) {
    throw new BadRequestError('Cannot dispute a paid summary')
  }

  const updated = await prisma.commissionSummary.update({
    where: { id: summaryId },
    data: {
      status: CommissionSummaryStatus.DISPUTED,
      notes: `DISPUTED by ${disputedById}: ${reason}`,
      version: { increment: 1 },
    },
  })

  logger.info('Commission summary disputed', {
    summaryId,
    venueId,
    disputedById,
    reason,
  })

  return updated
}

/**
 * Recalculate a summary (for disputes/corrections)
 */
export async function recalculateSummary(summaryId: string, venueId: string): Promise<any> {
  const summary = await prisma.commissionSummary.findFirst({
    where: { id: summaryId, venueId },
    include: {
      calculations: {
        where: { status: { not: CommissionCalcStatus.VOIDED } },
      },
    },
  })

  if (!summary) {
    throw new NotFoundError(`Commission summary ${summaryId} not found`)
  }

  if (summary.status === CommissionSummaryStatus.PAID) {
    throw new BadRequestError('Cannot recalculate a paid summary')
  }

  // Recalculate totals from calculations
  let totalSales = 0
  let totalCommissions = 0

  for (const calc of summary.calculations) {
    totalSales += decimalToNumber(calc.baseAmount)
    totalCommissions += decimalToNumber(calc.netCommission)
  }

  // Get milestone bonuses
  const bonuses = await prisma.milestoneAchievement.aggregate({
    where: { includedInSummaryId: summaryId },
    _sum: { bonusAmount: true },
  })

  const totalBonuses = decimalToNumber(bonuses._sum?.bonusAmount)
  const grossAmount = totalCommissions + totalBonuses
  const netAmount = grossAmount - decimalToNumber(summary.deductionAmount)

  const updated = await prisma.commissionSummary.update({
    where: { id: summaryId },
    data: {
      totalSales,
      totalCommissions,
      totalBonuses,
      grossAmount,
      netAmount,
      paymentCount: summary.calculations.length,
      status: CommissionSummaryStatus.CALCULATED,
      version: { increment: 1 },
    },
  })

  logger.info('Commission summary recalculated', {
    summaryId,
    venueId,
    totalSales,
    totalCommissions,
    totalBonuses,
    netAmount,
  })

  return updated
}

/**
 * Apply a deduction to a summary
 */
export async function applyDeduction(summaryId: string, venueId: string, amount: number, reason: string): Promise<any> {
  const summary = await prisma.commissionSummary.findFirst({
    where: { id: summaryId, venueId },
  })

  if (!summary) {
    throw new NotFoundError(`Commission summary ${summaryId} not found`)
  }

  if (summary.status === CommissionSummaryStatus.PAID) {
    throw new BadRequestError('Cannot apply deduction to a paid summary')
  }

  const currentDeduction = decimalToNumber(summary.deductionAmount)
  const newDeduction = currentDeduction + amount
  const newNetAmount = decimalToNumber(summary.grossAmount) - newDeduction

  const updated = await prisma.commissionSummary.update({
    where: { id: summaryId },
    data: {
      deductionAmount: newDeduction,
      netAmount: newNetAmount,
      notes: summary.notes ? `${summary.notes}\nDeduction: ${amount} - ${reason}` : `Deduction: ${amount} - ${reason}`,
      version: { increment: 1 },
    },
  })

  logger.info('Deduction applied to summary', {
    summaryId,
    venueId,
    amount,
    reason,
    newNetAmount,
  })

  return updated
}

// ============================================
// Bulk Operations
// ============================================

/**
 * Approve multiple summaries at once
 */
export async function bulkApproveSummaries(summaryIds: string[], venueId: string, approvedById: string): Promise<number> {
  const result = await prisma.commissionSummary.updateMany({
    where: {
      id: { in: summaryIds },
      venueId,
      status: {
        in: [CommissionSummaryStatus.CALCULATED, CommissionSummaryStatus.PENDING_APPROVAL],
      },
    },
    data: {
      status: CommissionSummaryStatus.APPROVED,
      approvedById,
      approvedAt: new Date(),
    },
  })

  logger.info('Bulk approval completed', {
    venueId,
    requested: summaryIds.length,
    approved: result.count,
    approvedById,
  })

  return result.count
}
