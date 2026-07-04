/**
 * Settlement Calendar — shared per-payment projection helper
 *
 * Projects a single completed card payment onto its settlement date + amounts,
 * reusing the same settlement engine (`calculateSettlementDate`) as Saldo
 * Disponible. This is the ONE code path shared by:
 * - `computeSettlementProjection` (sales-summary.dashboard.service.ts) — Entrega 2 breakdown
 * - the weekly settlement calendar view (Task 2)
 *
 * Money is pesos in MAJOR units (Prisma Decimal fields are `Number(...)`-ed by
 * callers before being passed in here).
 */

import { SettlementDayType, TransactionCardType } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'

import { calculateSettlementDate } from '@/services/payments/settlementCalculation.service'

export interface ProjectablePayment {
  amount: number | { toString(): string }
  tipAmount: number | { toString(): string } | null
  createdAt: Date
  merchantAccountId: string
  transactionCost: {
    transactionType: TransactionCardType
    venueChargeAmount: number | { toString(): string }
    venueFixedFee: number | { toString(): string }
  } | null
}

export interface ActiveConfig {
  merchantAccountId: string
  cardType: TransactionCardType
  settlementDays: number
  settlementDayType: SettlementDayType
  cutoffTime: string
  cutoffTimezone: string
  effectiveFrom: Date
  effectiveTo: Date | null
}

export interface ProjectedSettlement {
  settlementDateKey: string
  gross: number
  commission: number
  net: number
}

/**
 * Projects one payment's settlement date + amounts.
 *
 * Returns null when it can't be honestly projected: no transactionCost yet,
 * or no active SettlementConfiguration matching merchant × cardType at the
 * payment's createdAt (matched by effectiveFrom/effectiveTo window, not just
 * whichever config is active today).
 */
export function projectPaymentSettlement(
  p: ProjectablePayment,
  configs: ActiveConfig[],
  venueTimezone: string,
): ProjectedSettlement | null {
  const tc = p.transactionCost
  if (!tc) return null

  const config = configs.find(
    c =>
      c.merchantAccountId === p.merchantAccountId &&
      c.cardType === tc.transactionType &&
      c.effectiveFrom <= p.createdAt &&
      (c.effectiveTo === null || c.effectiveTo >= p.createdAt),
  )
  if (!config) return null

  const settlementDate = calculateSettlementDate(p.createdAt, {
    settlementDays: config.settlementDays,
    settlementDayType: config.settlementDayType,
    cutoffTime: config.cutoffTime,
    cutoffTimezone: config.cutoffTimezone,
  })

  const gross = Number(p.amount) + Number(p.tipAmount ?? 0)
  const commission = Number(tc.venueChargeAmount) + Number(tc.venueFixedFee)

  return {
    settlementDateKey: formatInTimeZone(settlementDate, venueTimezone, 'yyyy-MM-dd'),
    gross,
    commission,
    net: gross - commission,
  }
}
