/**
 * Commission Clawback Service
 *
 * Handles clawback of commissions after payout.
 * Clawbacks occur when refunds happen after commission was already paid.
 *
 * Fase 3 (A4): un clawback nuevo ANULA la comisión con `anularComision` (con sus reversos y su resumen) y ya no crea
 * `CommissionClawback`; lo ya pagado lo descuenta el siguiente sobre de Pago al personal. Aquí quedan las lecturas y la
 * anulación de los `CommissionClawback` históricos.
 */

import prisma from '../../../utils/prismaClient'
import { STAFF_PUBLIC_SELECT } from '../../../utils/staffPublicSelect'
import logger from '../../../config/logger'
import { Prisma, ClawbackReason } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../../errors/AppError'
import { decimalToNumber } from './commission-utils'
import { logAction } from '../activity-log.service'
import { anularComision } from './commission-calculation.service'

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
          staff: { select: STAFF_PUBLIC_SELECT },
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
 * «Clawback» desde el dashboard (fase 3, A4; spec §8): SIEMPRE anula la comisión con la operación única `anularComision`
 * —también con motivo CORRECTION y aunque su resumen ya se haya pagado por el flujo viejo— y ya no crea
 * `CommissionClawback` (nadie lo aplicaba: H2b). Si la comisión ya estaba en un recibo de Pago al personal, el siguiente
 * cierre le resta su monto solo (spec §6.4). `data.refundPaymentId` se acepta por compatibilidad y no se usa.
 */
export async function createClawback(
  calculationId: string,
  venueId: string,
  data: CreateClawbackInput,
  createdById: string,
): Promise<{ voided: true; calculationId: string; anuladas: string[] }> {
  const { anuladas } = await anularComision({
    calculationId,
    venueId,
    actorId: createdById ?? null,
    motivo: `${data.reason}: ${data.notes ?? 'Sin notas'}`,
  })
  return { voided: true, calculationId, anuladas }
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

  logAction({
    staffId: voidedById,
    venueId,
    action: 'COMMISSION_CLAWBACK_VOIDED',
    entity: 'CommissionClawback',
    entityId: clawbackId,
    data: { reason },
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
