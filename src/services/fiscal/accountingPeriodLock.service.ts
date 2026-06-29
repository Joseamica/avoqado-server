import { AccountingPeriodStatus, Prisma } from '@prisma/client'

import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import { resolveScopeOrNull } from './chartOfAccounts.service'

/**
 * Candado de periodo contable (Capa B fiscal). Un periodo CERRADO no admite pólizas nuevas ni edición
 * dentro de él — protege lo ya declarado. Scope = (organizationId, rfc). Reabrir conserva la bitácora
 * (quién/cuándo/por qué), nunca borra el row. Gated igual que el resto de Capa B (CFDI + accounting:manage).
 */

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/**
 * ¿El periodo (YYYY-MM) está CERRADO para este contribuyente? Bloquea postear pólizas dentro de él.
 * Acepta un cliente de transacción (`db`) para chequear DENTRO de la tx Serializable del posteo y
 * cerrar el race TOCTOU (que el periodo se cierre entre el check y el commit de la póliza).
 */
export async function isPeriodLocked(
  organizationId: string,
  rfc: string,
  period: string,
  db: Prisma.TransactionClient = prisma,
): Promise<boolean> {
  const lock = await db.accountingPeriodLock.findUnique({
    where: { organizationId_rfc_period: { organizationId, rfc, period } },
    select: { status: true },
  })
  return lock?.status === AccountingPeriodStatus.CLOSED
}

export interface PeriodLockResult {
  needsFiscalSetup: boolean
  period: string
  status: AccountingPeriodStatus | null
}

/** Cierra un periodo: ninguna póliza nueva podrá postearse dentro. Idempotente (re-cerrar no falla). */
export async function closePeriod(
  venueId: string,
  period: string,
  actor: { staffId?: string | null },
  reason?: string | null,
): Promise<PeriodLockResult> {
  if (!PERIOD_RE.test(period)) throw new BadRequestError('El periodo debe tener formato AAAA-MM (mes 01-12).')

  const scope = await resolveScopeOrNull(venueId)
  if (!scope) return { needsFiscalSetup: true, period, status: null }

  // Serializable: si una póliza se está posteando concurrentemente en este periodo (su tx también lee
  // el candado bajo Serializable), SSI detecta el conflicto read-write y aborta una de las dos — el
  // posteo reintenta, re-lee CLOSED y se rechaza. Sin esto, una póliza podría colarse al cerrar.
  await prisma.$transaction(
    async tx =>
      tx.accountingPeriodLock.upsert({
        where: { organizationId_rfc_period: { organizationId: scope.organizationId, rfc: scope.rfc, period } },
        create: {
          organizationId: scope.organizationId,
          rfc: scope.rfc,
          period,
          status: AccountingPeriodStatus.CLOSED,
          closedById: actor.staffId ?? null,
          reason: reason ?? null,
        },
        // Re-cerrar un periodo reabierto: vuelve a CLOSED y limpia los datos de reapertura.
        update: {
          status: AccountingPeriodStatus.CLOSED,
          closedById: actor.staffId ?? null,
          closedAt: new Date(),
          reopenedById: null,
          reopenedAt: null,
          reason: reason ?? null,
        },
      }),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  )

  await logAction({
    action: 'ACCOUNTING_PERIOD_CLOSED',
    entity: 'AccountingPeriodLock',
    entityId: `${scope.rfc}:${period}`,
    staffId: actor.staffId ?? null,
    venueId,
    data: { period, rfc: scope.rfc, reason: reason ?? null },
  })

  return { needsFiscalSetup: false, period, status: AccountingPeriodStatus.CLOSED }
}

/** Reabre un periodo cerrado (permite correcciones). Conserva el row con la bitácora de reapertura. */
export async function reopenPeriod(
  venueId: string,
  period: string,
  actor: { staffId?: string | null },
  reason?: string | null,
): Promise<PeriodLockResult> {
  if (!PERIOD_RE.test(period)) throw new BadRequestError('El periodo debe tener formato AAAA-MM (mes 01-12).')

  const scope = await resolveScopeOrNull(venueId)
  if (!scope) return { needsFiscalSetup: true, period, status: null }

  const existing = await prisma.accountingPeriodLock.findUnique({
    where: { organizationId_rfc_period: { organizationId: scope.organizationId, rfc: scope.rfc, period } },
    select: { status: true },
  })
  // Nunca estuvo cerrado (o ya está abierto) → no-op, sin bitácora de reapertura.
  if (!existing || existing.status === AccountingPeriodStatus.OPEN) {
    return { needsFiscalSetup: false, period, status: AccountingPeriodStatus.OPEN }
  }

  await prisma.accountingPeriodLock.update({
    where: { organizationId_rfc_period: { organizationId: scope.organizationId, rfc: scope.rfc, period } },
    data: { status: AccountingPeriodStatus.OPEN, reopenedById: actor.staffId ?? null, reopenedAt: new Date(), reason: reason ?? null },
  })

  await logAction({
    action: 'ACCOUNTING_PERIOD_REOPENED',
    entity: 'AccountingPeriodLock',
    entityId: `${scope.rfc}:${period}`,
    staffId: actor.staffId ?? null,
    venueId,
    data: { period, rfc: scope.rfc, reason: reason ?? null },
  })

  return { needsFiscalSetup: false, period, status: AccountingPeriodStatus.OPEN }
}

export interface PeriodLockRow {
  period: string
  status: AccountingPeriodStatus
  closedAt: Date
  reopenedAt: Date | null
  reason: string | null
}

export interface ListPeriodLocksResult {
  needsFiscalSetup: boolean
  rfc: string | null
  locks: PeriodLockRow[]
}

/** Lista los candados de periodo del contribuyente (más recientes primero). */
export async function listPeriodLocks(venueId: string): Promise<ListPeriodLocksResult> {
  const scope = await resolveScopeOrNull(venueId)
  if (!scope) return { needsFiscalSetup: true, rfc: null, locks: [] }

  const locks = await prisma.accountingPeriodLock.findMany({
    where: { organizationId: scope.organizationId, rfc: scope.rfc },
    orderBy: { period: 'desc' },
    select: { period: true, status: true, closedAt: true, reopenedAt: true, reason: true },
  })

  return { needsFiscalSetup: false, rfc: scope.rfc, locks }
}
