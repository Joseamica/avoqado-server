/**
 * Cash Out — configuration service (rate tables + active-days calendar).
 *
 * EVERY exported operation is gated by SERIALIZED_INVENTORY so cash-out appears
 * by default wherever serialized inventory is on (SIM sellers / PlayTelecom) —
 * NOT a separate module. Spec: Avoqado-HQ/specs/2026-06-25-cash-out-promoter-commissions.md
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { moduleService, MODULE_CODES } from '@/services/modules/module.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { validateRateTable, type RateTier } from './cash-out.domain'

/** Thrown when a non-CASH_OUT venue tries to reach a cash-out path. Spanish (shown to users). */
export class CashOutModuleDisabledError extends Error {
  statusCode = 403
  constructor(venueId: string) {
    super(`El esquema Cash Out requiere el módulo de inventario serializado (SERIALIZED_INVENTORY), que no está activo en este local (${venueId}).`)
    this.name = 'CashOutModuleDisabledError'
  }
}

/** Isolation gate — call at the top of every cash-out config operation. */
export async function assertCashOutEnabled(venueId: string): Promise<void> {
  const enabled = await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY)
  if (!enabled) throw new CashOutModuleDisabledError(venueId)
}

/** The active escalated-commission rate tiers for a venue (gated). */
export async function listCommissionRates(venueId: string) {
  await assertCashOutEnabled(venueId)
  return prisma.cashOutCommissionRate.findMany({
    where: { venueId, active: true },
    orderBy: [{ saleType: 'asc' }, { minCount: 'asc' }],
  })
}

/** Thrown when a rate table fails validation. Carries the Spanish messages. statusCode 400. */
export class CashOutValidationError extends Error {
  statusCode = 400
  errors: string[]
  constructor(errors: string[]) {
    super(errors.join(' '))
    this.name = 'CashOutValidationError'
    this.errors = errors
  }
}

/**
 * Replace a venue's escalated rate table: validate the ladder first, then
 * atomically deactivate the current active tiers and create the new ones.
 * Audited via ActivityLog. Gated by SERIALIZED_INVENTORY.
 */
export async function replaceCommissionRates(venueId: string, rates: RateTier[], actor: { staffId: string; orgId?: string | null }) {
  await assertCashOutEnabled(venueId)

  const errors = validateRateTable(rates)
  if (errors.length) throw new CashOutValidationError(errors)

  const created = await prisma.$transaction(async tx => {
    await tx.cashOutCommissionRate.updateMany({ where: { venueId, active: true }, data: { active: false } })
    await tx.cashOutCommissionRate.createMany({
      data: rates.map(r => ({
        venueId,
        orgId: actor.orgId ?? null,
        saleType: r.saleType,
        minCount: r.minCount,
        maxCount: r.maxCount,
        amount: new Prisma.Decimal(r.amount),
        createdById: actor.staffId,
      })),
    })
    return tx.cashOutCommissionRate.findMany({
      where: { venueId, active: true },
      orderBy: [{ saleType: 'asc' }, { minCount: 'asc' }],
    })
  })

  void logAction({
    action: 'CASH_OUT_RATES_UPDATED',
    entity: 'CashOutCommissionRate',
    entityId: venueId,
    staffId: actor.staffId,
    venueId,
    data: { tiers: rates.length },
  })

  return created
}

/** The venue's active cash-out days as 'yyyy-MM-dd' strings (gated, optional range). */
export async function listActiveDays(venueId: string, from?: string, to?: string): Promise<string[]> {
  await assertCashOutEnabled(venueId)
  const where: Prisma.CashOutScheduleDayWhereInput = { venueId, active: true }
  if (from || to) {
    const day: Prisma.DateTimeFilter = {}
    if (from) day.gte = new Date(`${from}T00:00:00.000Z`)
    if (to) day.lte = new Date(`${to}T00:00:00.000Z`)
    where.day = day
  }
  const rows = await prisma.cashOutScheduleDay.findMany({ where, orderBy: { day: 'asc' } })
  return rows.map(r => r.day.toISOString().slice(0, 10))
}

/**
 * Replace the venue's active cash-out days (ADMIN day-selection). Atomic, audited.
 * Days are stored as fake-UTC midnight to keep the calendar date tz-stable (@db.Date).
 */
export async function setActiveDays(venueId: string, days: string[], actor: { staffId: string; orgId?: string | null }) {
  await assertCashOutEnabled(venueId)
  const unique = Array.from(new Set(days))

  await prisma.$transaction(async tx => {
    await tx.cashOutScheduleDay.deleteMany({ where: { venueId } })
    if (unique.length) {
      await tx.cashOutScheduleDay.createMany({
        data: unique.map(d => ({
          venueId,
          orgId: actor.orgId ?? null,
          day: new Date(`${d}T00:00:00.000Z`),
          active: true,
          createdById: actor.staffId,
        })),
      })
    }
  })

  void logAction({
    action: 'CASH_OUT_DAYS_UPDATED',
    entity: 'CashOutScheduleDay',
    entityId: venueId,
    staffId: actor.staffId,
    venueId,
    data: { days: unique.length },
  })

  return unique
}
