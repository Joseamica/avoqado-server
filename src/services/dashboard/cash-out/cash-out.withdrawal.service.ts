/**
 * Cash Out — withdrawal service ("Retirar").
 *
 * Sums a promoter's AVAILABLE entries into a single REQUESTED withdrawal and
 * atomically marks those entries WITHDRAWN. TOCTOU-safe: the claim is a
 * conditional updateMany (status:'AVAILABLE') whose row count must match — a
 * concurrent withdrawal claiming the same entries rolls the whole thing back.
 * Money is PESOS, 1:1. Gated by SERIALIZED_INVENTORY.
 */
import { Prisma, CashOutWithdrawalStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { assertCashOutEnabled } from './cash-out.config.service'
import { venueBusinessDate } from './cash-out.domain'

export class NothingToWithdrawError extends Error {
  statusCode = 400
  constructor() {
    super('No hay saldo disponible para retirar.')
    this.name = 'NothingToWithdrawError'
  }
}

export class ConcurrentWithdrawalError extends Error {
  statusCode = 409
  constructor() {
    super('El saldo cambió durante el retiro; intenta de nuevo.')
    this.name = 'ConcurrentWithdrawalError'
  }
}

/** Human-facing receipt folio. Uniqueness is also enforced by the DB @unique. */
function makeFolio(): string {
  return `CO-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1e4)
    .toString()
    .padStart(4, '0')}`
}

export interface WithdrawalResult {
  id: string
  folio: string
  grossAmount: Prisma.Decimal
  netAmount: Prisma.Decimal
  entries: number
}

/**
 * Create a withdrawal for a promoter from their AVAILABLE saldo. v1: no SPEI fee
 * (net == gross); Finanzas disperses externally. `actor` is who triggered it
 * (back-office in v1; the promoter on TPV in v2).
 */
export async function createWithdrawal(
  venueId: string,
  staffId: string,
  actor: { staffId: string; timeZone?: string },
): Promise<WithdrawalResult> {
  await assertCashOutEnabled(venueId)

  const result = await prisma.$transaction(async tx => {
    const entries = await tx.promoterCommissionEntry.findMany({
      where: { venueId, staffId, status: 'AVAILABLE' },
      select: { id: true, amount: true },
    })
    if (!entries.length) throw new NothingToWithdrawError()

    const gross = entries.reduce((acc, e) => acc.add(e.amount), new Prisma.Decimal(0))
    if (gross.lte(0)) throw new NothingToWithdrawError()

    const bank = await tx.promoterBankAccount.findUnique({ where: { staffId }, select: { clabe: true } })
    const tz = actor.timeZone ?? 'America/Mexico_City'
    const businessDate = new Date(`${venueBusinessDate(new Date(), tz)}T00:00:00.000Z`)

    const withdrawal = await tx.cashOutWithdrawal.create({
      data: {
        venueId,
        staffId,
        businessDate,
        grossAmount: gross,
        feeMxn: new Prisma.Decimal(0),
        netAmount: gross,
        clabe: bank?.clabe ?? null,
        folio: makeFolio(),
        status: 'REQUESTED',
        requestedById: actor.staffId,
      },
    })

    const ids = entries.map(e => e.id)
    const claimed = await tx.promoterCommissionEntry.updateMany({
      where: { id: { in: ids }, status: 'AVAILABLE' },
      data: { status: 'WITHDRAWN', withdrawalId: withdrawal.id },
    })
    if (claimed.count !== ids.length) throw new ConcurrentWithdrawalError() // rolls back the whole tx

    return { id: withdrawal.id, folio: withdrawal.folio, grossAmount: gross, netAmount: gross, entries: ids.length }
  })

  void logAction({
    action: 'CASH_OUT_WITHDRAWAL_REQUESTED',
    entity: 'CashOutWithdrawal',
    entityId: result.id,
    staffId: actor.staffId,
    venueId,
    data: { gross: result.grossAmount.toString(), entries: result.entries, folio: result.folio },
  })

  return result
}

/** List a venue's withdrawals (back-office history), newest first. Gated. */
export async function listWithdrawals(venueId: string, opts: { businessDate?: string; status?: CashOutWithdrawalStatus } = {}) {
  await assertCashOutEnabled(venueId)
  const where: Prisma.CashOutWithdrawalWhereInput = { venueId }
  if (opts.businessDate) where.businessDate = new Date(`${opts.businessDate}T00:00:00.000Z`)
  if (opts.status) where.status = opts.status
  return prisma.cashOutWithdrawal.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 })
}
