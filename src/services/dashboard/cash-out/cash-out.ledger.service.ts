/**
 * Cash Out — ledger service (the runtime heart).
 *
 * Turns approved (COMPLETED) sales into a withdrawable balance:
 *  - materializeEntries: idempotently creates one LOCKED entry per COMPLETED sale,
 *    escalating the tier by the promoter's accumulated count in the Lun–Dom week.
 *  - reconcileClawbacks: marks entries whose source sale is no longer COMPLETED.
 *  - getSaldo: Σ AVAILABLE entries (pesos).
 *
 * Gated by SERIALIZED_INVENTORY (cash-out appears wherever serialized inventory is on).
 * Dates: DB timestamps are UTC,
 * converted to venue.timezone (venueBusinessDate) to derive calendar dates.
 * Money is PESOS, 1:1. Spec: Avoqado-HQ/specs/2026-06-25-cash-out-promoter-commissions.md
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { moduleService, MODULE_CODES } from '@/services/modules/module.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { assertCashOutEnabled, listActiveDays } from './cash-out.config.service'
import { buildCommissionEntry, venueBusinessDate, weekStartMonday, type RateTier, type CashOutSaleType } from './cash-out.domain'

/** A calendar date ('yyyy-MM-dd') → @db.Date value (fake-UTC midnight, tz-stable). */
function dbDate(yyyymmdd: string): Date {
  return new Date(`${yyyymmdd}T00:00:00.000Z`)
}

/**
 * Materialize a LOCKED commission entry for every COMPLETED sale of a cash-out
 * venue that doesn't have one yet. Idempotent (the unique saleVerificationId
 * guards re-runs). A mis-configured rate table skips that sale (logged) rather
 * than aborting the whole batch.
 */
export async function materializeEntries(venueId: string): Promise<{ created: number }> {
  if (!(await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY))) return { created: 0 }

  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  if (!venue) return { created: 0 }
  const tz = venue.timezone

  // Cash-out commission is generated ONLY for sales made on a day the ADMIN activated
  // (spec: "ADMIN define los días que aplica el esquema cash out"). This day-based scheme
  // never pays retroactively on pre-scheme history. Without this filter the sweep priced
  // EVERY historical COMPLETED sale — spamming "[cash-out] materialize skipped" warnings
  // while no rate table exists, and (once rates were loaded) would have paid commission on
  // months of past sales. No active days configured → nothing to materialize (fast no-op:
  // also avoids scanning every historical sale on each promoter balance check).
  const activeDays = new Set(await listActiveDays(venueId))
  if (activeDays.size === 0) return { created: 0 }

  const rateRows = await prisma.cashOutCommissionRate.findMany({ where: { venueId, active: true } })
  const rates: RateTier[] = rateRows.map(r => ({
    saleType: r.saleType as CashOutSaleType,
    minCount: r.minCount,
    maxCount: r.maxCount,
    amount: Number(r.amount),
  }))

  const existing = await prisma.promoterCommissionEntry.findMany({ where: { venueId }, select: { saleVerificationId: true } })
  const have = new Set(existing.map(e => e.saleVerificationId))
  const sales = await prisma.saleVerification.findMany({
    where: { venueId, status: 'COMPLETED' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, staffId: true, isPortabilidad: true, createdAt: true },
  })
  // Skip sales that already have an entry (idempotent) AND sales made on a day the ADMIN
  // did not activate (their venue-local business date is not in the calendar → no commission).
  const pending = sales.filter(s => !have.has(s.id) && activeDays.has(venueBusinessDate(s.createdAt, tz)))

  let created = 0
  const counters = new Map<string, number>() // `${staffId}|${weekStart}` → count materialized so far

  for (const sale of pending) {
    try {
      const businessDate = venueBusinessDate(sale.createdAt, tz)
      const weekStart = weekStartMonday(businessDate)
      const key = `${sale.staffId}|${weekStart}`

      let prior = counters.get(key)
      if (prior === undefined) {
        prior = await prisma.promoterCommissionEntry.count({
          where: { staffId: sale.staffId, weekStart: dbDate(weekStart), status: { not: 'CLAWED_BACK' } },
        })
      }

      const draft = buildCommissionEntry({
        saleVerificationId: sale.id,
        venueId,
        staffId: sale.staffId,
        isPortabilidad: sale.isPortabilidad,
        saleAt: sale.createdAt,
        timeZone: tz,
        rates,
        priorWeekCount: prior,
      })

      await prisma.promoterCommissionEntry.create({
        data: {
          saleVerificationId: draft.saleVerificationId,
          venueId,
          staffId: draft.staffId,
          saleType: draft.saleType,
          businessDate: dbDate(draft.businessDate),
          weekStart: dbDate(draft.weekStart),
          tier: draft.tier,
          amount: new Prisma.Decimal(draft.amount),
          status: 'AVAILABLE',
        },
      })

      counters.set(key, prior + 1)
      created++
    } catch (err: any) {
      logger.warn(`[cash-out] materialize skipped sale ${sale.id} on venue ${venueId}: ${err?.message ?? err}`)
    }
  }

  return { created }
}

/** Promoter's available saldo = Σ AVAILABLE entries (pesos). Gated. */
export async function getSaldo(venueId: string, staffId: string): Promise<Prisma.Decimal> {
  await assertCashOutEnabled(venueId)
  const agg = await prisma.promoterCommissionEntry.aggregate({
    where: { venueId, staffId, status: 'AVAILABLE' },
    _sum: { amount: true },
  })
  return agg._sum.amount ?? new Prisma.Decimal(0)
}

/**
 * Reconciliation-based clawback: any AVAILABLE/WITHDRAWN entry whose source sale
 * is no longer COMPLETED (e.g. dropped in audit via an admin edit) is marked
 * CLAWED_BACK. Resilient to ANY path that changed the sale's status.
 */
export async function reconcileClawbacks(venueId: string): Promise<{ clawedBack: number }> {
  if (!(await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY))) return { clawedBack: 0 }

  const entries = await prisma.promoterCommissionEntry.findMany({
    where: { venueId, status: { in: ['AVAILABLE', 'WITHDRAWN'] } },
    select: { id: true, saleVerificationId: true },
  })
  if (!entries.length) return { clawedBack: 0 }

  const stillCompleted = await prisma.saleVerification.findMany({
    where: { id: { in: entries.map(e => e.saleVerificationId) }, status: 'COMPLETED' },
    select: { id: true },
  })
  const completed = new Set(stillCompleted.map(s => s.id))
  const toClaw = entries.filter(e => !completed.has(e.saleVerificationId))
  if (!toClaw.length) return { clawedBack: 0 }

  await prisma.promoterCommissionEntry.updateMany({
    where: { id: { in: toClaw.map(e => e.id) } },
    data: { status: 'CLAWED_BACK', clawedBackAt: new Date() },
  })

  void logAction({
    action: 'CASH_OUT_CLAWBACK',
    entity: 'PromoterCommissionEntry',
    entityId: venueId,
    venueId,
    data: { count: toClaw.length },
  })

  return { clawedBack: toClaw.length }
}
