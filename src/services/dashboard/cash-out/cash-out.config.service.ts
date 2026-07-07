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
import AppError from '@/errors/AppError'

/** Thrown when a non-CASH_OUT venue tries to reach a cash-out path. Spanish (shown to users). */
export class CashOutModuleDisabledError extends AppError {
  constructor(venueId: string) {
    super(
      `El esquema Cash Out requiere el módulo de inventario serializado (SERIALIZED_INVENTORY), que no está activo en este local (${venueId}).`,
      403,
    )
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
export class CashOutValidationError extends AppError {
  errors: string[]
  constructor(errors: string[]) {
    super(errors.join(' '), 400)
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

// ==========================================
// ORG-SCOPED — uniform config for ALL venues in an organization (venueId: null rows)
// ==========================================

/** Org-level isolation gate — SERIALIZED_INVENTORY enabled at org (canonical check, includes module.active) OR on any of its venues. */
export async function assertCashOutEnabledForOrg(orgId: string): Promise<void> {
  const orgEnabled = await moduleService.isModuleEnabledForOrganization(orgId, MODULE_CODES.SERIALIZED_INVENTORY)
  if (orgEnabled) return
  const venueMod = await prisma.venueModule.findFirst({
    where: { enabled: true, module: { code: MODULE_CODES.SERIALIZED_INVENTORY, active: true }, venue: { organizationId: orgId } },
    select: { id: true },
  })
  if (!venueMod) {
    throw new AppError(
      `El esquema Cash Out requiere el módulo de inventario serializado (SERIALIZED_INVENTORY), que no está activo en esta organización (${orgId}).`,
      403,
    )
  }
}

/** The active org-level escalated-commission rate tiers (org rows only: venueId null). */
export async function listCommissionRatesForOrg(orgId: string) {
  await assertCashOutEnabledForOrg(orgId)
  return prisma.cashOutCommissionRate.findMany({
    where: { orgId, venueId: null, active: true },
    orderBy: [{ saleType: 'asc' }, { minCount: 'asc' }],
  })
}

/** Replace the org-level escalated rate table (uniform for all venues without their own rows). */
export async function replaceCommissionRatesForOrg(orgId: string, rates: RateTier[], actor: { staffId: string }) {
  await assertCashOutEnabledForOrg(orgId)
  const errors = validateRateTable(rates)
  if (errors.length) throw new CashOutValidationError(errors)

  const created = await prisma.$transaction(async tx => {
    await tx.cashOutCommissionRate.updateMany({ where: { orgId, venueId: null, active: true }, data: { active: false } })
    await tx.cashOutCommissionRate.createMany({
      data: rates.map(r => ({
        orgId,
        venueId: null,
        saleType: r.saleType,
        minCount: r.minCount,
        maxCount: r.maxCount,
        amount: new Prisma.Decimal(r.amount),
        createdById: actor.staffId,
      })),
    })
    return tx.cashOutCommissionRate.findMany({
      where: { orgId, venueId: null, active: true },
      orderBy: [{ saleType: 'asc' }, { minCount: 'asc' }],
    })
  })

  void logAction({
    action: 'CASH_OUT_RATES_UPDATED',
    entity: 'CashOutCommissionRate',
    entityId: orgId,
    staffId: actor.staffId,
    data: { scope: 'org', orgId, tiers: rates.length },
  })
  return created
}

/** The org's active cash-out days (org rows only), as 'yyyy-MM-dd'. */
export async function listActiveDaysForOrg(orgId: string, from?: string, to?: string): Promise<string[]> {
  await assertCashOutEnabledForOrg(orgId)
  const where: Prisma.CashOutScheduleDayWhereInput = { orgId, venueId: null, active: true }
  if (from || to) {
    const day: Prisma.DateTimeFilter = {}
    if (from) day.gte = new Date(`${from}T00:00:00.000Z`)
    if (to) day.lte = new Date(`${to}T00:00:00.000Z`)
    where.day = day
  }
  const rows = await prisma.cashOutScheduleDay.findMany({ where, orderBy: { day: 'asc' } })
  return rows.map(r => r.day.toISOString().slice(0, 10))
}

/** Replace the org's active cash-out days (ADMIN day-selection, uniform). */
export async function setActiveDaysForOrg(orgId: string, days: string[], actor: { staffId: string }) {
  await assertCashOutEnabledForOrg(orgId)
  const unique = Array.from(new Set(days))
  await prisma.$transaction(async tx => {
    await tx.cashOutScheduleDay.deleteMany({ where: { orgId, venueId: null } })
    if (unique.length) {
      await tx.cashOutScheduleDay.createMany({
        data: unique.map(d => ({ orgId, venueId: null, day: new Date(`${d}T00:00:00.000Z`), active: true, createdById: actor.staffId })),
      })
    }
  })
  void logAction({
    action: 'CASH_OUT_DAYS_UPDATED',
    entity: 'CashOutScheduleDay',
    entityId: orgId,
    staffId: actor.staffId,
    data: { scope: 'org', orgId, days: unique.length },
  })
  return unique
}

// ==========================================
// RESOLUTION — venue-override-else-org (used by the ledger; NOT gated here,
// materializeEntries already gates the module at its top before calling these)
// ==========================================

/** Resolve a venue's active cash-out days: venue rows if any, else its org rows. 'yyyy-MM-dd'. */
export async function resolveActiveDaysForVenue(venueId: string): Promise<string[]> {
  const venueRows = await prisma.cashOutScheduleDay.findMany({ where: { venueId, active: true }, orderBy: { day: 'asc' } })
  if (venueRows.length) return venueRows.map(r => r.day.toISOString().slice(0, 10))
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
  if (!venue?.organizationId) return []
  const orgRows = await prisma.cashOutScheduleDay.findMany({
    where: { orgId: venue.organizationId, venueId: null, active: true },
    orderBy: { day: 'asc' },
  })
  return orgRows.map(r => r.day.toISOString().slice(0, 10))
}

/** Resolve a venue's escalated rate tiers: venue rows if any, else its org rows. */
export async function resolveRatesForVenue(venueId: string): Promise<RateTier[]> {
  const map = (rows: { saleType: string; minCount: number; maxCount: number | null; amount: unknown }[]): RateTier[] =>
    rows.map(r => ({ saleType: r.saleType as RateTier['saleType'], minCount: r.minCount, maxCount: r.maxCount, amount: Number(r.amount) }))
  const venueRows = await prisma.cashOutCommissionRate.findMany({ where: { venueId, active: true } })
  if (venueRows.length) return map(venueRows)
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
  if (!venue?.organizationId) return []
  const orgRows = await prisma.cashOutCommissionRate.findMany({ where: { orgId: venue.organizationId, venueId: null, active: true } })
  return map(orgRows)
}
