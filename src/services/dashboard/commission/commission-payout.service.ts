/**
 * Commission Payout Service
 *
 * Manages commission payouts to staff members.
 * Only OWNER can create and process payouts.
 *
 * Key Business Rules:
 * - Each payout is tied to a single CommissionSummary
 * - Tracks payment method and reference
 * - Status flow: PENDING → APPROVED → PROCESSING → PAID
 * - Once PAID, summary status becomes PAID
 */

import prisma from '../../../utils/prismaClient'
import logger from '../../../config/logger'
import { Prisma, CommissionPayoutStatus, CommissionSummaryStatus } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../../errors/AppError'
import { decimalToNumber } from './commission-utils'

// ============================================
// Type Definitions
// ============================================

export interface CreatePayoutInput {
  summaryIds: string[]
  paymentMethod?: string
  paymentReference?: string
  notes?: string
}

export interface PayoutFilters {
  staffId?: string
  status?: CommissionPayoutStatus
  startDate?: Date
  endDate?: Date
}

// ============================================
// Read Operations
// ============================================

/**
 * Get all payouts for a venue
 */
export async function getPayouts(venueId: string, filters: PayoutFilters = {}): Promise<any[]> {
  const where: Prisma.CommissionPayoutWhereInput = { venueId }

  if (filters.staffId) where.staffId = filters.staffId
  if (filters.status) where.status = filters.status

  if (filters.startDate || filters.endDate) {
    where.createdAt = {}
    if (filters.startDate) where.createdAt.gte = filters.startDate
    if (filters.endDate) where.createdAt.lte = filters.endDate
  }

  return prisma.commissionPayout.findMany({
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
      processedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      summary: {
        select: {
          id: true,
          periodStart: true,
          periodEnd: true,
          netAmount: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })
}

/**
 * Get a single payout by ID
 */
export async function getPayoutById(payoutId: string, venueId: string): Promise<any> {
  const payout = await prisma.commissionPayout.findFirst({
    where: { id: payoutId, venueId },
    include: {
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
        },
      },
      processedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      summary: {
        include: {
          calculations: {
            take: 50,
            orderBy: { calculatedAt: 'desc' },
          },
        },
      },
    },
  })

  if (!payout) {
    throw new NotFoundError(`Payout ${payoutId} not found`)
  }

  return payout
}

/**
 * Get payouts for a specific staff member
 */
export async function getStaffPayouts(staffId: string, venueId: string, limit: number = 10): Promise<any[]> {
  return prisma.commissionPayout.findMany({
    where: {
      staffId,
      venueId,
      status: CommissionPayoutStatus.PAID,
    },
    include: {
      summary: {
        select: {
          periodStart: true,
          periodEnd: true,
          totalCommissions: true,
          totalBonuses: true,
          netAmount: true,
        },
      },
    },
    orderBy: { paidAt: 'desc' },
    take: limit,
  })
}

// ============================================
// Create Operations
// ============================================

/**
 * Create payouts for approved summaries
 * Creates one payout per summary
 *
 * @param venueId - Venue ID
 * @param data - Input data containing summary IDs
 * @param createdById - Staff ID creating the payouts
 * @returns Array of created payouts
 */
export async function createPayouts(venueId: string, data: CreatePayoutInput, createdById: string): Promise<any[]> {
  if (!data.summaryIds?.length) {
    throw new BadRequestError('At least one summary ID is required')
  }

  // Verify all summaries exist, belong to venue, and are approved
  const summaries = await prisma.commissionSummary.findMany({
    where: {
      id: { in: data.summaryIds },
      venueId,
      status: CommissionSummaryStatus.APPROVED,
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

  if (summaries.length !== data.summaryIds.length) {
    const foundIds = summaries.map(s => s.id)
    const missingIds = data.summaryIds.filter(id => !foundIds.includes(id))
    throw new BadRequestError(`Some summaries not found or not approved: ${missingIds.join(', ')}`)
  }

  // Check for existing payouts
  const existingPayouts = await prisma.commissionPayout.findMany({
    where: {
      summaryId: { in: data.summaryIds },
      status: { not: CommissionPayoutStatus.CANCELLED },
    },
  })

  if (existingPayouts.length > 0) {
    throw new BadRequestError(`Some summaries already have active payouts: ${existingPayouts.map(p => p.summaryId).join(', ')}`)
  }

  // Create one payout per summary
  const payouts = await prisma.$transaction(
    summaries.map(summary =>
      prisma.commissionPayout.create({
        data: {
          venueId,
          staffId: summary.staffId,
          summaryId: summary.id,
          amount: summary.netAmount,
          paymentMethod: data.paymentMethod ?? 'BANK_TRANSFER',
          paymentReference: data.paymentReference,
          notes: data.notes,
          status: CommissionPayoutStatus.PENDING,
        },
        include: {
          staff: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
          summary: {
            select: {
              periodStart: true,
              periodEnd: true,
              netAmount: true,
            },
          },
        },
      }),
    ),
  )

  logger.info('Commission payouts created', {
    venueId,
    payoutCount: payouts.length,
    totalAmount: payouts.reduce((sum, p) => sum + decimalToNumber(p.amount), 0),
    createdById,
  })

  return payouts
}

// ============================================
// Status Operations
// ============================================

/**
 * Approve a pending payout
 */
export async function approvePayout(payoutId: string, venueId: string, approvedById: string): Promise<any> {
  const payout = await prisma.commissionPayout.findFirst({
    where: { id: payoutId, venueId },
  })

  if (!payout) {
    throw new NotFoundError(`Payout ${payoutId} not found`)
  }

  if (payout.status !== CommissionPayoutStatus.PENDING) {
    throw new BadRequestError(`Cannot approve payout with status: ${payout.status}`)
  }

  const updated = await prisma.commissionPayout.update({
    where: { id: payoutId },
    data: {
      status: CommissionPayoutStatus.APPROVED,
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

  logger.info('Payout approved', {
    payoutId,
    venueId,
    approvedById,
  })

  return updated
}

/**
 * Process a payout (mark as processing)
 */
export async function processPayout(payoutId: string, venueId: string, processedById: string): Promise<any> {
  const payout = await prisma.commissionPayout.findFirst({
    where: { id: payoutId, venueId },
  })

  if (!payout) {
    throw new NotFoundError(`Payout ${payoutId} not found`)
  }

  if (payout.status !== CommissionPayoutStatus.APPROVED) {
    throw new BadRequestError(`Cannot process payout with status: ${payout.status}`)
  }

  const updated = await prisma.commissionPayout.update({
    where: { id: payoutId },
    data: {
      status: CommissionPayoutStatus.PROCESSING,
      processedById,
      processedAt: new Date(),
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

  logger.info('Payout processing started', {
    payoutId,
    venueId,
    processedById,
  })

  return updated
}

/**
 * Mark a payout as paid and update summary status
 */
export async function completePayout(payoutId: string, venueId: string, reference?: string): Promise<any> {
  const payout = await prisma.commissionPayout.findFirst({
    where: { id: payoutId, venueId },
    include: {
      summary: true,
    },
  })

  if (!payout) {
    throw new NotFoundError(`Payout ${payoutId} not found`)
  }

  if (payout.status !== CommissionPayoutStatus.PROCESSING && payout.status !== CommissionPayoutStatus.APPROVED) {
    throw new BadRequestError(`Cannot complete payout with status: ${payout.status}`)
  }

  // Update payout and summary in transaction
  const updated = await prisma.$transaction(async tx => {
    // Mark payout as paid
    const updatedPayout = await tx.commissionPayout.update({
      where: { id: payoutId },
      data: {
        status: CommissionPayoutStatus.PAID,
        paidAt: new Date(),
        paymentReference: reference ?? payout.paymentReference,
      },
      include: {
        staff: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        summary: {
          select: {
            periodStart: true,
            periodEnd: true,
            netAmount: true,
          },
        },
      },
    })

    // Update summary status to PAID
    await tx.commissionSummary.update({
      where: { id: payout.summaryId },
      data: {
        status: CommissionSummaryStatus.PAID,
        version: { increment: 1 },
      },
    })

    return updatedPayout
  })

  logger.info('Payout completed', {
    payoutId,
    venueId,
    summaryId: payout.summaryId,
    amount: decimalToNumber(payout.amount),
  })

  return updated
}

/**
 * Cancel a payout (only if not PAID)
 */
export async function cancelPayout(payoutId: string, venueId: string, reason?: string): Promise<any> {
  const payout = await prisma.commissionPayout.findFirst({
    where: { id: payoutId, venueId },
  })

  if (!payout) {
    throw new NotFoundError(`Payout ${payoutId} not found`)
  }

  if (payout.status === CommissionPayoutStatus.PAID) {
    throw new BadRequestError('Cannot cancel a paid payout')
  }

  const updated = await prisma.commissionPayout.update({
    where: { id: payoutId },
    data: {
      status: CommissionPayoutStatus.CANCELLED,
      notes: reason ? `${payout.notes ?? ''}\nCancelled: ${reason}` : payout.notes,
    },
  })

  logger.info('Payout cancelled', {
    payoutId,
    venueId,
    reason,
  })

  return updated
}

/**
 * Mark a payout as failed
 */
export async function failPayout(payoutId: string, venueId: string, failureReason: string): Promise<any> {
  const payout = await prisma.commissionPayout.findFirst({
    where: { id: payoutId, venueId },
  })

  if (!payout) {
    throw new NotFoundError(`Payout ${payoutId} not found`)
  }

  if (payout.status === CommissionPayoutStatus.PAID) {
    throw new BadRequestError('Cannot fail a paid payout')
  }

  const updated = await prisma.commissionPayout.update({
    where: { id: payoutId },
    data: {
      status: CommissionPayoutStatus.FAILED,
      failureReason,
      retryCount: { increment: 1 },
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

  logger.info('Payout failed', {
    payoutId,
    venueId,
    failureReason,
    retryCount: updated.retryCount,
  })

  return updated
}

// ============================================
// Stats Operations
// ============================================

/**
 * Get payout statistics for a venue
 */
export async function getPayoutStats(venueId: string): Promise<{
  totalPaid: number
  totalPending: number
  payoutCount: number
  averagePayout: number
}> {
  // Get paid stats
  const paidStats = await prisma.commissionPayout.aggregate({
    where: {
      venueId,
      status: CommissionPayoutStatus.PAID,
    },
    _sum: {
      amount: true,
    },
    _count: {
      id: true,
    },
    _avg: {
      amount: true,
    },
  })

  // Get pending stats
  const pendingStats = await prisma.commissionPayout.aggregate({
    where: {
      venueId,
      status: {
        in: [CommissionPayoutStatus.PENDING, CommissionPayoutStatus.APPROVED, CommissionPayoutStatus.PROCESSING],
      },
    },
    _sum: {
      amount: true,
    },
  })

  return {
    totalPaid: decimalToNumber(paidStats._sum?.amount),
    totalPending: decimalToNumber(pendingStats._sum?.amount),
    payoutCount: paidStats._count?.id ?? 0,
    averagePayout: decimalToNumber(paidStats._avg?.amount),
  }
}
