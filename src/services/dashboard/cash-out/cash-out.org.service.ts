/**
 * Cash Out — organization aggregation (back-office at org level).
 * Unions the per-venue withdrawals/dispersion across all venues of an org.
 * Money is PESOS, 1:1. Gated by SERIALIZED_INVENTORY (org module OR any venue module).
 */
import { Prisma, CashOutWithdrawalStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { assertCashOutEnabledForOrg } from './cash-out.config.service'
import { materializeEntries, reconcileClawbacks } from './cash-out.ledger.service'
import type { DispersionRow } from './cash-out.report.service'

/** Active venue ids belonging to the org (gated). */
export async function listVenueIdsForOrg(orgId: string): Promise<string[]> {
  await assertCashOutEnabledForOrg(orgId)
  const venues = await prisma.venue.findMany({ where: { organizationId: orgId, active: true }, select: { id: true } })
  return venues.map(v => v.id)
}

/** Org-wide withdrawals (newest first), enriched with promoter + venue name.
 *  Gated via listVenueIdsForOrg. Returns [] when the org has no active venues. */
export async function listWithdrawalsForOrg(orgId: string, opts: { businessDate?: string; status?: CashOutWithdrawalStatus } = {}) {
  const venueIds = await listVenueIdsForOrg(orgId)
  if (!venueIds.length) return []

  const where: Prisma.CashOutWithdrawalWhereInput = { venueId: { in: venueIds } }
  if (opts.businessDate) where.businessDate = new Date(`${opts.businessDate}T00:00:00.000Z`)
  if (opts.status) where.status = opts.status

  const withdrawals = await prisma.cashOutWithdrawal.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 })

  const staff = await prisma.staff.findMany({
    where: { id: { in: withdrawals.map(w => w.staffId) } },
    select: { id: true, firstName: true, lastName: true },
  })
  const nameById = new Map(staff.map(s => [s.id, `${s.firstName ?? ''} ${s.lastName ?? ''}`.trim()]))

  const venues = await prisma.venue.findMany({ where: { id: { in: venueIds } }, select: { id: true, name: true } })
  const venueById = new Map(venues.map(v => [v.id, v.name]))

  return withdrawals.map(w => ({
    ...w,
    promoterName: nameById.get(w.staffId) || w.staffId,
    venueName: venueById.get(w.venueId) || w.venueId,
  }))
}

/** Org-wide Finanzas dispersion: aggregate REQUESTED across the org's venues and mark REPORTED. */
export async function generateOrgDispersionReport(
  orgId: string,
  opts: { businessDate?: string },
  actor: { staffId: string },
): Promise<{ orgId: string; rows: DispersionRow[]; totalNet: string; count: number }> {
  const venueIds = await listVenueIdsForOrg(orgId)
  if (!venueIds.length) return { orgId, rows: [], totalNet: '0', count: 0 }

  const out = await prisma.$transaction(async tx => {
    const where: Prisma.CashOutWithdrawalWhereInput = { venueId: { in: venueIds }, status: 'REQUESTED' }
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
      entityId: orgId,
      staffId: actor.staffId,
      data: { scope: 'org', orgId, count: out.rows.length, totalNet: out.total.toString() },
    })
  }

  return { orgId, rows: out.rows, totalNet: out.total.toString(), count: out.rows.length }
}

/**
 * Org-wide available Cash Out balance per promoter. Reproduces the real fresh-read path
 * (getSaldo only SUMS AVAILABLE entries; freshness + business exclusions — ADMIN active days,
 * MANUAL_ENTRY exclusion — live inside materializeEntries). Per venue: materialize then
 * reconcile clawbacks (both idempotent, module-gated no-ops when off), then group AVAILABLE by
 * staff. Perf: runs materialize across all org venues on read; idempotent (skips existing).
 */
export async function getSaldosForOrg(
  orgId: string,
): Promise<Array<{ venueId: string; staffId: string; promoterName: string; saldo: string }>> {
  const venueIds = await listVenueIdsForOrg(orgId)
  if (venueIds.length === 0) return []

  for (const venueId of venueIds) {
    await materializeEntries(venueId)
    await reconcileClawbacks(venueId)
  }

  const grouped = await prisma.promoterCommissionEntry.groupBy({
    by: ['venueId', 'staffId'],
    where: { venueId: { in: venueIds }, status: 'AVAILABLE' },
    _sum: { amount: true },
  })

  const staffIds = [...new Set(grouped.map(g => g.staffId))]
  const staff = staffIds.length
    ? await prisma.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, firstName: true, lastName: true } })
    : []
  const nameOf = new Map(staff.map(s => [s.id, `${s.firstName ?? ''} ${s.lastName ?? ''}`.trim()]))

  return grouped
    .map(g => ({
      venueId: g.venueId,
      staffId: g.staffId,
      promoterName: nameOf.get(g.staffId) ?? g.staffId,
      saldo: new Prisma.Decimal(g._sum.amount ?? 0).toString(),
    }))
    .sort((a, b) => Number(b.saldo) - Number(a.saldo))
}
