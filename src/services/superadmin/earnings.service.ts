import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { Prisma } from '@prisma/client'
import * as paymentAnalyticsService from './paymentAnalytics.service'

export interface DateRange {
  startDate?: Date
  endDate?: Date
}

/** EcommerceMerchant stores Avoqado's fee in integer centavos; UI works in MXN. */
export function centsToMxn(cents: number | bigint | null | undefined): number {
  return Number(cents ?? 0) / 100
}

interface TerminalVenueAgg {
  venueId: string
  venueName: string
  profit: number
  volume: number
  transactions: number
}
interface OnlineVenueAgg {
  venueId: string
  venueName: string
  fees: number
  volume: number
  transactions: number
}

export interface VenueEarnings {
  venueId: string
  venueName: string
  profit: number
  terminalProfit: number
  onlineFees: number
  volume: number
  transactions: number
}

/** Combine per-venue terminal profit and online fees into one list, sorted by total profit. */
export function mergeByVenue(terminal: TerminalVenueAgg[], online: OnlineVenueAgg[]): VenueEarnings[] {
  const map = new Map<string, VenueEarnings>()
  for (const t of terminal) {
    map.set(t.venueId, {
      venueId: t.venueId,
      venueName: t.venueName,
      terminalProfit: t.profit,
      onlineFees: 0,
      profit: t.profit,
      volume: t.volume,
      transactions: t.transactions,
    })
  }
  for (const o of online) {
    const existing = map.get(o.venueId)
    if (existing) {
      existing.onlineFees += o.fees
      existing.profit += o.fees
      existing.volume += o.volume
      existing.transactions += o.transactions
    } else {
      map.set(o.venueId, {
        venueId: o.venueId,
        venueName: o.venueName,
        terminalProfit: 0,
        onlineFees: o.fees,
        profit: o.fees,
        volume: o.volume,
        transactions: o.transactions,
      })
    }
  }
  return Array.from(map.values()).sort((a, b) => b.profit - a.profit)
}

export interface EarningsTimePoint {
  date: string
  terminalProfit: number
  onlineFees: number
  profit: number
}

/** Merge terminal-profit and online-fee time series by date bucket, filling gaps with 0. */
export function mergeTimeSeries(
  terminal: { date: string; profit: number }[],
  online: { date: string; fees: number }[],
): EarningsTimePoint[] {
  const map = new Map<string, EarningsTimePoint>()
  for (const t of terminal) {
    map.set(t.date, { date: t.date, terminalProfit: t.profit, onlineFees: 0, profit: t.profit })
  }
  for (const o of online) {
    const existing = map.get(o.date)
    if (existing) {
      existing.onlineFees += o.fees
      existing.profit += o.fees
    } else {
      map.set(o.date, { date: o.date, terminalProfit: 0, onlineFees: o.fees, profit: o.fees })
    }
  }
  return Array.from(map.values()).sort((a, b) => (a.date < b.date ? -1 : 1))
}

export interface EarningsTotals {
  grossProfit: number
  terminalProfit: number
  onlineFees: number
  volume: number
  transactions: number
  averageMargin: number
}
export interface MerchantEarnings {
  merchantAccountId: string
  label: string
  providerCode: string
  profit: number
  volume: number
  transactions: number
}
export interface ProviderEarnings {
  providerId: string
  providerCode: string
  providerName: string
  volume: number
  cost: number
  transactions: number
}
export interface CardTypeEarnings {
  type: string
  transactions: number
  volume: number
  profit: number
  margin: number
}
export interface ChannelEarnings {
  ecommerceMerchantId: string
  label: string
  providerCode: string
  fees: number
  volume: number
  transactions: number
}
export interface EarningsSummary {
  range: { startDate: string; endDate: string }
  totals: EarningsTotals
  byVenue: VenueEarnings[]
  byMerchant: MerchantEarnings[]
  byProvider: ProviderEarnings[]
  byCardType: CardTypeEarnings[]
  byChannel: ChannelEarnings[]
}

function resolveRange(range?: DateRange): { startDate: Date; endDate: Date } {
  const endDate = range?.endDate ?? new Date()
  const startDate = range?.startDate ?? new Date(endDate.getFullYear(), endDate.getMonth(), 1)
  return { startDate, endDate }
}

export async function getEarningsSummary(range?: DateRange): Promise<EarningsSummary> {
  const { startDate, endDate } = resolveRange(range)
  logger.info('Calculating earnings summary', { startDate, endDate })

  // REUSE (unchanged shared service): terminal totals, card-type + provider breakdowns.
  const terminal = await paymentAnalyticsService.getProfitMetrics({ startDate, endDate })

  // CREATE: full per-venue terminal, per-merchant terminal, and the online (e-commerce) aggregates.
  const [terminalByVenue, merchantRows, onlineByVenue, onlineTotals, channelRows] = await Promise.all([
    prisma.$queryRaw<Array<{ venueId: string; venueName: string; profit: Prisma.Decimal; volume: Prisma.Decimal; transactions: bigint }>>`
      SELECT v.id as "venueId", v.name as "venueName",
             COALESCE(SUM(tc."grossProfit"), 0) as profit,
             COALESCE(SUM(tc.amount), 0) as volume,
             COUNT(*) as transactions
      FROM "TransactionCost" tc
      JOIN "Payment" p ON tc."paymentId" = p.id
      JOIN "Venue" v ON p."venueId" = v.id
      WHERE tc."createdAt" >= ${startDate} AND tc."createdAt" <= ${endDate}
      GROUP BY v.id, v.name
    `,
    prisma.$queryRaw<
      Array<{
        merchantAccountId: string
        displayName: string | null
        alias: string | null
        externalMerchantId: string
        providerCode: string
        profit: Prisma.Decimal
        volume: Prisma.Decimal
        transactions: bigint
      }>
    >`
      SELECT ma.id as "merchantAccountId", ma."displayName", ma.alias, ma."externalMerchantId",
             pp.code as "providerCode",
             COALESCE(SUM(tc."grossProfit"), 0) as profit,
             COALESCE(SUM(tc.amount), 0) as volume,
             COUNT(*) as transactions
      FROM "TransactionCost" tc
      JOIN "MerchantAccount" ma ON tc."merchantAccountId" = ma.id
      JOIN "PaymentProvider" pp ON ma."providerId" = pp.id
      WHERE tc."createdAt" >= ${startDate} AND tc."createdAt" <= ${endDate}
      GROUP BY ma.id, ma."displayName", ma.alias, ma."externalMerchantId", pp.code
      ORDER BY profit DESC
    `,
    prisma.$queryRaw<Array<{ venueId: string; venueName: string; fees: bigint; volume: Prisma.Decimal; transactions: bigint }>>`
      SELECT v.id as "venueId", v.name as "venueName",
             COALESCE(SUM(cs."applicationFeeCents"), 0) as fees,
             COALESCE(SUM(cs.amount), 0) as volume,
             COUNT(*) as transactions
      FROM "CheckoutSession" cs
      JOIN "EcommerceMerchant" em ON cs."ecommerceMerchantId" = em.id
      JOIN "Venue" v ON em."venueId" = v.id
      WHERE cs.status = 'COMPLETED' AND cs."createdAt" >= ${startDate} AND cs."createdAt" <= ${endDate}
      GROUP BY v.id, v.name
    `,
    prisma.checkoutSession.aggregate({
      where: { status: 'COMPLETED', createdAt: { gte: startDate, lte: endDate } },
      _count: true,
      _sum: { amount: true, applicationFeeCents: true },
    }),
    prisma.$queryRaw<
      Array<{
        ecommerceMerchantId: string
        channelName: string | null
        businessName: string | null
        providerCode: string
        fees: bigint
        volume: Prisma.Decimal
        transactions: bigint
      }>
    >`
      SELECT em.id as "ecommerceMerchantId", em."channelName", em."businessName",
             pp.code as "providerCode",
             COALESCE(SUM(cs."applicationFeeCents"), 0) as fees,
             COALESCE(SUM(cs.amount), 0) as volume,
             COUNT(*) as transactions
      FROM "CheckoutSession" cs
      JOIN "EcommerceMerchant" em ON cs."ecommerceMerchantId" = em.id
      JOIN "PaymentProvider" pp ON em."providerId" = pp.id
      WHERE cs.status = 'COMPLETED' AND cs."createdAt" >= ${startDate} AND cs."createdAt" <= ${endDate}
      GROUP BY em.id, em."channelName", em."businessName", pp.code
      ORDER BY fees DESC
    `,
  ])

  const byVenue = mergeByVenue(
    terminalByVenue.map(r => ({
      venueId: r.venueId,
      venueName: r.venueName,
      profit: Number(r.profit),
      volume: Number(r.volume),
      transactions: Number(r.transactions),
    })),
    onlineByVenue.map(r => ({
      venueId: r.venueId,
      venueName: r.venueName,
      fees: centsToMxn(r.fees),
      volume: Number(r.volume),
      transactions: Number(r.transactions),
    })),
  )

  const onlineFees = centsToMxn(onlineTotals._sum.applicationFeeCents)
  const onlineVolume = Number(onlineTotals._sum.amount) || 0
  const onlineTransactions = onlineTotals._count

  return {
    range: { startDate: startDate.toISOString(), endDate: endDate.toISOString() },
    totals: {
      grossProfit: terminal.totalProfit + onlineFees,
      terminalProfit: terminal.totalProfit,
      onlineFees,
      volume: terminal.totalVolume + onlineVolume,
      transactions: terminal.totalTransactions + onlineTransactions,
      averageMargin: terminal.averageMargin,
    },
    byVenue,
    byMerchant: merchantRows.map(r => ({
      merchantAccountId: r.merchantAccountId,
      label: r.displayName || r.alias || r.externalMerchantId,
      providerCode: r.providerCode,
      profit: Number(r.profit),
      volume: Number(r.volume),
      transactions: Number(r.transactions),
    })),
    byProvider: terminal.topProviders.map(p => ({
      providerId: p.providerId,
      providerCode: p.providerCode,
      providerName: p.providerName,
      volume: p.volume,
      cost: p.cost,
      transactions: p.transactions,
    })),
    byCardType: terminal.byCardType.map(c => ({
      type: c.type,
      transactions: c.transactions,
      volume: c.volume,
      profit: c.profit,
      margin: c.margin,
    })),
    byChannel: channelRows.map(r => ({
      ecommerceMerchantId: r.ecommerceMerchantId,
      label: r.channelName || r.businessName || r.ecommerceMerchantId,
      providerCode: r.providerCode,
      fees: centsToMxn(r.fees),
      volume: Number(r.volume),
      transactions: Number(r.transactions),
    })),
  }
}

export async function getEarningsTimeSeries(
  range?: DateRange,
  granularity: 'daily' | 'weekly' | 'monthly' = 'daily',
): Promise<EarningsTimePoint[]> {
  const { startDate, endDate } = resolveRange(range)

  // REUSE: terminal profit series (unchanged shared service).
  const terminalSeries = await paymentAnalyticsService.getProfitTimeSeries({ startDate, endDate }, granularity)

  // CREATE: online fee series (same DATE_TRUNC buckets).
  const truncInterval = granularity === 'weekly' ? 'week' : granularity === 'monthly' ? 'month' : 'day'
  const dateFormat = granularity === 'monthly' ? 'YYYY-MM' : 'YYYY-MM-DD'
  const onlineRows = await prisma.$queryRaw<Array<{ date: string; fees: bigint }>>(
    Prisma.sql`
      SELECT TO_CHAR(DATE_TRUNC(${Prisma.raw(`'${truncInterval}'`)}, "createdAt"), ${Prisma.raw(`'${dateFormat}'`)}) as date,
             COALESCE(SUM("applicationFeeCents"), 0) as fees
      FROM "CheckoutSession"
      WHERE status = 'COMPLETED' AND "createdAt" >= ${startDate} AND "createdAt" <= ${endDate}
      GROUP BY date
      ORDER BY date
    `,
  )

  return mergeTimeSeries(
    terminalSeries.map(t => ({ date: t.date, profit: t.profit })),
    onlineRows.map(o => ({ date: o.date, fees: centsToMxn(o.fees) })),
  )
}
