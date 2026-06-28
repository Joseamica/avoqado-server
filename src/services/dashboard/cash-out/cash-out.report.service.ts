/**
 * Cash Out — Finanzas dispersion report (the 18:15 corte deliverable).
 *
 * Aggregates a venue's REQUESTED withdrawals into the rows Finanzas needs to run
 * SPEI (promotor, CLABE, monto neto, folio), totals them, and atomically marks
 * them REPORTED so they aren't reported twice. Money is PESOS, 1:1. Gated.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { assertCashOutEnabled } from './cash-out.config.service'

export interface DispersionRow {
  withdrawalId: string
  folio: string
  promoterId: string
  promoterName: string
  clabe: string | null // null = promoter has no bank account on file yet (Finanzas must resolve)
  netAmount: string // pesos
}

export interface DispersionReport {
  venueId: string
  rows: DispersionRow[]
  totalNet: string // pesos
  count: number
}

/**
 * Generate the dispersion report and commit the corte (REQUESTED → REPORTED).
 * `opts.businessDate` ('yyyy-MM-dd') scopes to one day; omit for all pending.
 */
export async function generateDispersionReport(
  venueId: string,
  opts: { businessDate?: string },
  actor: { staffId: string },
): Promise<DispersionReport> {
  await assertCashOutEnabled(venueId)

  const out = await prisma.$transaction(async tx => {
    const where: Prisma.CashOutWithdrawalWhereInput = { venueId, status: 'REQUESTED' }
    if (opts.businessDate) where.businessDate = new Date(`${opts.businessDate}T00:00:00.000Z`)

    const withdrawals = await tx.cashOutWithdrawal.findMany({
      where,
      select: { id: true, folio: true, staffId: true, clabe: true, netAmount: true },
      orderBy: { createdAt: 'asc' },
    })
    if (!withdrawals.length) return { rows: [] as DispersionRow[], total: new Prisma.Decimal(0) }

    const staff = await tx.staff.findMany({
      where: { id: { in: withdrawals.map(w => w.staffId) } },
      select: { id: true, firstName: true, lastName: true },
    })
    const nameById = new Map(staff.map(s => [s.id, `${s.firstName ?? ''} ${s.lastName ?? ''}`.trim()]))

    const rows: DispersionRow[] = withdrawals.map(w => ({
      withdrawalId: w.id,
      folio: w.folio,
      promoterId: w.staffId,
      promoterName: nameById.get(w.staffId) || w.staffId,
      clabe: w.clabe,
      netAmount: w.netAmount.toString(),
    }))
    const total = withdrawals.reduce((acc, w) => acc.add(w.netAmount), new Prisma.Decimal(0))

    await tx.cashOutWithdrawal.updateMany({
      where: { id: { in: withdrawals.map(w => w.id) } },
      data: { status: 'REPORTED', reportedAt: new Date() },
    })

    return { rows, total }
  })

  if (out.rows.length) {
    void logAction({
      action: 'CASH_OUT_REPORT_GENERATED',
      entity: 'CashOutWithdrawal',
      entityId: venueId,
      staffId: actor.staffId,
      venueId,
      data: { count: out.rows.length, totalNet: out.total.toString() },
    })
  }

  return { venueId, rows: out.rows, totalNet: out.total.toString(), count: out.rows.length }
}
