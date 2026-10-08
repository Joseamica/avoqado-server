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
import { decimalToNumber, getPeriodDateRange, getVenueTimezone, reintentarSiHayBloqueoMutuo } from './commission-utils'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { retry, shouldRetryDbConnectionError } from '../../../utils/retry'
import { periodoDeAgregacion, resumenesCalculados } from './resumenesCalculados'

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
  /** Máximo de renglones (el servidor lo acota a `TOPE_RESUMENES`). */
  limite?: number
}

// ============================================
// Aggregation Operations
// ============================================

/**
 * Aggregate all pending calculations for a venue
 *
 * Creates or updates CommissionSummary records for each staff member.
 *
 * Fase 3 (A4, Codex plan r1-5): si Postgres la elige víctima de un bloqueo mutuo con una anulación (que toma las filas y luego
 * el resumen), se repite la pasada COMPLETA: vuelve a sumar lo que siga CALCULATED y lo que ya marcó una transacción anterior
 * no se suma dos veces. 🔴 No garantiza que lo recién anulado quede fuera: la pasada suma ANTES de marcar y fuera de la
 * transacción (H3, aparcado; sólo la pantalla de Comisiones), así que si relee antes de que la anulación confirme, le suma
 * al resumen una fila que ya no marcará. El sobre de Pago al personal lee filas, no resúmenes.
 */
export async function aggregateVenueCommissions(venueId: string, period: TierPeriod = TierPeriod.WEEKLY): Promise<AggregationResult> {
  return reintentarSiHayBloqueoMutuo('aggregateVenueCommissions', () => agregarUnaPasada(venueId, period))
}

async function agregarUnaPasada(venueId: string, period: TierPeriod): Promise<AggregationResult> {
  logger.info('Starting commission aggregation', { venueId, period })

  const timezone = await getVenueTimezone(venueId)
  const { start: periodStart, end: periodEnd } = getPeriodDateRange(period, new Date(), timezone)

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

  // Pre-fetch existing summaries and milestone bonuses for all staff (avoids 2N queries)
  const staffIds = pendingByStaff.map(g => g.staffId)

  const [existingSummaries, milestoneBonusesByStaff] = await Promise.all([
    prisma.commissionSummary.findMany({
      where: {
        venueId,
        staffId: { in: staffIds },
        periodStart,
        periodEnd,
      },
    }),
    prisma.milestoneAchievement.groupBy({
      by: ['staffId'],
      where: {
        staffId: { in: staffIds },
        venueId,
        achievedAt: { gte: periodStart, lte: periodEnd },
        includedInSummaryId: null,
      },
      _sum: { bonusAmount: true },
    }),
  ])

  const summaryByStaff = new Map(existingSummaries.map(s => [s.staffId, s]))
  const bonusesByStaff = new Map(milestoneBonusesByStaff.map(b => [b.staffId, b._sum.bonusAmount]))

  for (const group of pendingByStaff) {
    const existingSummary = summaryByStaff.get(group.staffId) || null

    const totalSales = decimalToNumber(group._sum.baseAmount)
    const totalCommissions = decimalToNumber(group._sum.netCommission)
    const paymentCount = group._count.id

    const totalBonuses = decimalToNumber(bonusesByStaff.get(group.staffId))
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
 *
 * Reads the aggregationPeriod from each venue's active CommissionConfig
 * to determine how to group commissions (weekly, biweekly, monthly, etc.)
 */
export async function aggregateAllPendingCommissions(): Promise<{
  venues: number
  summarized: number
}> {
  // Get all venues with pending calculations. Entry read of the
  // commission-aggregation cron — retried on transient connection errors per
  // .claude/rules/cron-jobs.md.
  const venuesWithPending = await retry(
    () =>
      prisma.commissionCalculation.groupBy({
        by: ['venueId'],
        where: {
          status: CommissionCalcStatus.CALCULATED,
        },
        _count: {
          id: true,
        },
      }),
    { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'commission-aggregation.groupPending' },
  )

  let totalSummarized = 0

  for (const { venueId } of venuesWithPending) {
    try {
      // El periodo del esquema activo de mayor prioridad (mensual sin esquema): la MISMA regla con la que la tabla agrupa.
      const period = await periodoDeAgregacion(venueId)

      const result = await aggregateVenueCommissions(venueId, period)
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
 * «Resumen de Comisiones»: lo CALCULADO por persona y periodo, con la fuente del KPI «Calculado» (E6a-fix2 C6). Los montos
 * ya no salen de lo que guarda este job (ver `resumenesCalculados.ts`): la forma de la respuesta es la misma.
 */
export async function getCommissionSummaries(venueId: string, filters: SummaryFilters = {}): Promise<any[]> {
  return (await resumenesCalculados(venueId, filters)).filas
}
/** Con el total antes del tope (`GET /summaries` lo manda, aditivo, junto a `data`). */
export { resumenesCalculados }

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
// Summary Operations
// ============================================

/**
 * Recalculate a summary (for disputes/corrections). Con `db`, dentro de la transacción de quien llama (la anulación de una
 * comisión ya sumada, fase 3 A4); sin ella, en su propia transacción, con su auditoría.
 *
 * 🔴 Ronda 1: escribe totales ABSOLUTOS, así que antes de leer bloquea el resumen. Sin el candado, una lectura que cae entre
 * el `increment` del agregador y su COMMIT no ve las filas que éste acaba de marcar y las borra del resumen al escribir.
 * El orden de candados no cambia: quien llama ya tiene las filas; el resumen va después.
 */
export async function recalculateSummary(summaryId: string, venueId: string, db?: Prisma.TransactionClient): Promise<any> {
  if (!db) return prisma.$transaction(tx => recalculateSummary(summaryId, venueId, tx))
  await db.$queryRaw(Prisma.sql`SELECT id FROM "CommissionSummary" WHERE id = ${summaryId} AND "venueId" = ${venueId} FOR UPDATE`)
  const summary = await db.commissionSummary.findFirst({
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
  const bonuses = await db.milestoneAchievement.aggregate({
    where: { includedInSummaryId: summaryId },
    _sum: { bonusAmount: true },
  })

  const totalBonuses = decimalToNumber(bonuses._sum?.bonusAmount)
  const grossAmount = totalCommissions + totalBonuses
  const netAmount = grossAmount - decimalToNumber(summary.deductionAmount)

  const updated = await db.commissionSummary.update({
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

  await writeLegacyActivityAuditTx(db, {
    venueId,
    action: 'COMMISSION_SUMMARY_RECALCULATED',
    entity: 'CommissionSummary',
    entityId: summaryId,
    data: { totalSales, totalCommissions, netAmount },
  })

  return updated
}
