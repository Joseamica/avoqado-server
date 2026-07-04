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

import { PaymentMethod, SettlementDayType, TransactionCardType } from '@prisma/client'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'

import { calculateSettlementDate } from '@/services/payments/settlementCalculation.service'
import prisma from '@/utils/prismaClient'

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
  settlementDays: number
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
    settlementDays: config.settlementDays,
  }
}

// ── Weekly settlement view (Task 2) ─────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * Monday–Sunday week bounds (as UTC instants) for the venue-local week that
 * contains `anchorDateKey` (yyyy-MM-dd). Omit `anchorDateKey` to use today in the
 * venue tz. Bounds: Monday 00:00 → Sunday 23:59:59.999 venue-local, as UTC.
 */
export function venueWeekBounds(anchorDateKey: string | undefined, venueTimezone: string): { weekStart: Date; weekEnd: Date } {
  const anchor = anchorDateKey ?? formatInTimeZone(new Date(), venueTimezone, 'yyyy-MM-dd')
  const [y, m, d] = anchor.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0=Sun … 6=Sat (calendar dow of a date-only value)
  const sinceMonday = (dow + 6) % 7
  const key = (dt: Date) => `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
  const mondayKey = key(new Date(Date.UTC(y, m - 1, d - sinceMonday)))
  const sundayKey = key(new Date(Date.UTC(y, m - 1, d - sinceMonday + 6)))
  return {
    weekStart: fromZonedTime(`${mondayKey}T00:00:00.000`, venueTimezone),
    weekEnd: fromZonedTime(`${sundayKey}T23:59:59.999`, venueTimezone),
  }
}
// Lookback ≥ max settlement days + weekend/holiday slack: a payment sold this
// far before the week can still settle inside it.
const LOOKBACK_DAYS = 21

interface WeekAgg {
  gross: number
  commission: number
  net: number
  count: number
}
export interface SettlementWeekMerchant extends WeekAgg {
  merchantAccountId: string
  displayName: string
  provider: string
}
export interface SettlementWeekCardType extends WeekAgg {
  cardType: TransactionCardType
}
export interface SettlementWeekDay extends WeekAgg {
  date: string
  status: 'settled' | 'today' | 'projected'
  byMerchant: SettlementWeekMerchant[]
  byCardType: SettlementWeekCardType[]
}
export interface SettlementWeek {
  weekStart: string
  weekEnd: string
  days: SettlementWeekDay[]
  weekTotal: WeekAgg
}

/**
 * Card money LANDING in the bank during [weekStart, weekEnd] (venue-local),
 * regardless of when the sale happened — a Friday sale settling Monday appears
 * on Monday. Recomputed on read via the corrected settlement engine, so it does
 * NOT depend on stored (possibly stale) settlement dates. Cash is excluded
 * (immediate). Payments with no active settlement rule can't be placed on a
 * landing day and are omitted here (the report-scoped "sin fecha estimada"
 * surfaces that money instead — it belongs to no single week).
 */
export async function getSettlementsLandingInWeek(
  venueId: string,
  weekStart: Date,
  weekEnd: Date,
  venueTimezone: string,
): Promise<SettlementWeek> {
  const from = new Date(weekStart.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
  const payments = await prisma.payment.findMany({
    where: {
      venueId,
      status: 'COMPLETED',
      merchantAccountId: { not: null },
      method: { not: PaymentMethod.CASH },
      createdAt: { gte: from, lte: weekEnd },
    },
    select: {
      amount: true,
      tipAmount: true,
      createdAt: true,
      merchantAccountId: true,
      transactionCost: { select: { transactionType: true, venueChargeAmount: true, venueFixedFee: true } },
      merchantAccount: { select: { displayName: true, alias: true, provider: { select: { name: true } } } },
    },
  })

  const merchantIds = Array.from(new Set(payments.map(p => p.merchantAccountId).filter((x): x is string => Boolean(x))))
  const configs: ActiveConfig[] = merchantIds.length
    ? await prisma.settlementConfiguration.findMany({
        where: { merchantAccountId: { in: merchantIds } },
        select: {
          merchantAccountId: true,
          cardType: true,
          settlementDays: true,
          settlementDayType: true,
          cutoffTime: true,
          cutoffTimezone: true,
          effectiveFrom: true,
          effectiveTo: true,
        },
        orderBy: { effectiveFrom: 'desc' },
      })
    : []

  const startKey = formatInTimeZone(weekStart, venueTimezone, 'yyyy-MM-dd')
  const endKey = formatInTimeZone(weekEnd, venueTimezone, 'yyyy-MM-dd')
  const todayKey = formatInTimeZone(new Date(), venueTimezone, 'yyyy-MM-dd')

  const newAgg = (): WeekAgg => ({ gross: 0, commission: 0, net: 0, count: 0 })
  const bump = (a: WeekAgg, pr: ProjectedSettlement) => {
    a.gross += pr.gross
    a.commission += pr.commission
    a.net += pr.net
    a.count += 1
  }
  const dayMap = new Map<
    string,
    { total: WeekAgg; byMerchant: Map<string, WeekAgg & { displayName: string; provider: string }>; byCardType: Map<TransactionCardType, WeekAgg> }
  >()

  for (const p of payments) {
    const merchantId = p.merchantAccountId
    if (!merchantId || !p.transactionCost) continue
    const projected = projectPaymentSettlement(
      { amount: p.amount, tipAmount: p.tipAmount, createdAt: p.createdAt, merchantAccountId: merchantId, transactionCost: p.transactionCost },
      configs,
      venueTimezone,
    )
    if (!projected) continue
    const key = projected.settlementDateKey
    if (key < startKey || key > endKey) continue // lands outside this week

    if (!dayMap.has(key)) dayMap.set(key, { total: newAgg(), byMerchant: new Map(), byCardType: new Map() })
    const day = dayMap.get(key)!
    bump(day.total, projected)
    if (!day.byMerchant.has(merchantId)) {
      day.byMerchant.set(merchantId, {
        ...newAgg(),
        displayName: p.merchantAccount?.displayName || p.merchantAccount?.alias || 'Comercio',
        provider: p.merchantAccount?.provider?.name ?? '',
      })
    }
    bump(day.byMerchant.get(merchantId)!, projected)
    const ct = p.transactionCost.transactionType
    if (!day.byCardType.has(ct)) day.byCardType.set(ct, newAgg())
    bump(day.byCardType.get(ct)!, projected)
  }

  const roundAgg = (a: WeekAgg): WeekAgg => ({ gross: round2(a.gross), commission: round2(a.commission), net: round2(a.net), count: a.count })
  const days: SettlementWeekDay[] = Array.from(dayMap.entries())
    .map(([date, d]) => ({
      date,
      status: (date < todayKey ? 'settled' : date === todayKey ? 'today' : 'projected') as SettlementWeekDay['status'],
      ...roundAgg(d.total),
      byMerchant: Array.from(d.byMerchant.entries())
        .map(([merchantAccountId, m]) => ({ merchantAccountId, displayName: m.displayName, provider: m.provider, ...roundAgg(m) }))
        .sort((a, b) => b.net - a.net),
      byCardType: Array.from(d.byCardType.entries())
        .map(([cardType, c]) => ({ cardType, ...roundAgg(c) }))
        .sort((a, b) => b.net - a.net),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  const weekTotal = roundAgg(
    days.reduce((acc, d) => ({ gross: acc.gross + d.gross, commission: acc.commission + d.commission, net: acc.net + d.net, count: acc.count + d.count }), newAgg()),
  )

  return { weekStart: startKey, weekEnd: endKey, days, weekTotal }
}
