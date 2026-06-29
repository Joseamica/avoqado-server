/**
 * Cash Out — promoter self-service (TPV "Mis Comisiones", v2).
 *
 * Lets a logged-in promoter read their OWN available balance and request a
 * withdrawal ("Retirar") from the PAX terminal. SELF-SCOPED: venueId + staffId
 * come from the authenticated TPV session (authContext), NEVER from the request
 * body — a promoter can only ever see/withdraw their own commission.
 *
 * Two gates on top of the back-office flow:
 *  1. SERIALIZED_INVENTORY module (via assertCashOutEnabled / underlying services).
 *  2. Active-days calendar — the promoter may only withdraw on a day the venue
 *     marked active (CashOutScheduleDay). Back-office dispersion is unaffected;
 *     this gate lives only in the promoter path.
 *
 * Money is PESOS, 1:1 (no cents). Dates are venue-local (the "now" instant is
 * converted to the venue's calendar day via venueBusinessDate).
 * Spec: Avoqado-HQ/specs/2026-06-25-cash-out-promoter-commissions.md
 */
import prisma from '@/utils/prismaClient'
import AppError from '@/errors/AppError'
import { materializeEntries, getSaldo } from './cash-out.ledger.service'
import { createWithdrawal, type WithdrawalResult } from './cash-out.withdrawal.service'
import { assertCashOutEnabled, listActiveDays } from './cash-out.config.service'
import { venueBusinessDate, isSchemeActiveOn } from './cash-out.domain'

/** Thrown when a promoter tries to withdraw on a day outside the active-days calendar (403). */
export class CashOutNotActiveTodayError extends AppError {
  constructor() {
    super('Hoy no es un día habilitado para retirar tu comisión.', 403)
    this.name = 'CashOutNotActiveTodayError'
  }
}

async function venueTimeZone(venueId: string): Promise<string> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  return venue?.timezone ?? 'America/Mexico_City'
}

export interface PromoterCashOut {
  /** Available balance, pesos 1:1, as a decimal string (e.g. "30"). */
  saldo: string
  /** Whether TODAY (venue-local) is a configured active withdrawal day. */
  activeToday: boolean
  /** The venue-local calendar day used for activeToday (yyyy-mm-dd). */
  businessDate: string
}

/** The promoter's own current balance + whether today is a withdrawal day. */
export async function getPromoterCashOut(venueId: string, staffId: string, now: Date = new Date()): Promise<PromoterCashOut> {
  await assertCashOutEnabled(venueId) // SERIALIZED_INVENTORY gate (403 if off)
  await materializeEntries(venueId) // keep saldo current (idempotent)
  const tz = await venueTimeZone(venueId)
  const [saldo, activeDays] = await Promise.all([getSaldo(venueId, staffId), listActiveDays(venueId)])
  const businessDate = venueBusinessDate(now, tz)
  return { saldo: saldo.toString(), activeToday: isSchemeActiveOn(activeDays, businessDate), businessDate }
}

/** Promoter requests a withdrawal of their full available balance (active-day gated). */
export async function withdrawAsPromoter(venueId: string, staffId: string, now: Date = new Date()): Promise<WithdrawalResult> {
  await assertCashOutEnabled(venueId) // SERIALIZED_INVENTORY gate (403 if off)
  const tz = await venueTimeZone(venueId)
  const businessDate = venueBusinessDate(now, tz)
  const activeDays = await listActiveDays(venueId)
  if (!isSchemeActiveOn(activeDays, businessDate)) throw new CashOutNotActiveTodayError()
  await materializeEntries(venueId) // make today's COMPLETED sales withdrawable before claiming
  return createWithdrawal(venueId, staffId, { staffId, timeZone: tz })
}
