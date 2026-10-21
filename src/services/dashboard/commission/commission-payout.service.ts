/**
 * Commission Payout Service — SÓLO LECTURA (fase 3 de pago por servicio, spec §8).
 *
 * Desde octubre de 2026 las comisiones se pagan en el recibo de Pago al personal (`staffPay/`). Aquí queda el historial
 * de los pagos hechos con el flujo viejo (en producción: ninguno), detrás de `commissions:payout`. Las escrituras se
 * retiraron: sus rutas responden 410.
 */

import prisma from '../../../utils/prismaClient'
import { Prisma, CommissionPayoutStatus } from '@prisma/client'
import { NotFoundError } from '../../../errors/AppError'
import { decimalToNumber } from './commission-utils'

// ============================================
// Type Definitions
// ============================================

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
