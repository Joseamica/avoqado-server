import prisma from '../../utils/prismaClient'
import { Prisma } from '@prisma/client'
import logger from '../../config/logger'
import { computeRevenueSplit, type CardType, type MerchantRevenueShareConfig } from '../payments/revenueShare.service'

export interface DateRange {
  startDate?: Date
  endDate?: Date
}

/** Optional scope for the earnings detail pages. Mutually exclusive in practice. */
export interface EarningsFilter {
  venueId?: string
  merchantAccountId?: string
}

export type Granularity = 'daily' | 'weekly' | 'monthly'

const round2 = (n: number) => Math.round(n * 100) / 100

/** EcommerceMerchant stores Avoqado's fee in integer centavos; UI works in MXN. */
export function centsToMxn(cents: number | bigint | null | undefined): number {
  return Number(cents ?? 0) / 100
}

/** UTC time-bucket key for the trend. Weekly keys to the Monday of the week. */
export function bucketKey(date: Date, granularity: Granularity): string {
  const iso = date.toISOString()
  if (granularity === 'monthly') return iso.slice(0, 7) // YYYY-MM
  if (granularity === 'weekly') {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    const dow = (d.getUTCDay() + 6) % 7 // Monday = 0
    d.setUTCDate(d.getUTCDate() - dow)
    return d.toISOString().slice(0, 10)
  }
  return iso.slice(0, 10) // YYYY-MM-DD
}

function resolveRange(range?: DateRange): { startDate: Date; endDate: Date } {
  const endDate = range?.endDate ?? new Date()
  const startDate = range?.startDate ?? new Date(endDate.getFullYear(), endDate.getMonth(), 1)
  return { startDate, endDate }
}

/** TransactionCost.transactionType may be OTHER; treat as CREDIT (rate already
 *  snapshotted; type only matters to resolve aggregatorPrice[cardType]). */
function toCardType(t: string): CardType {
  if (t === 'DEBIT' || t === 'CREDIT' || t === 'AMEX' || t === 'INTERNATIONAL') return t
  return 'CREDIT'
}

function mapShare(
  ms: {
    aggregatorPrice: unknown
    aggregatorPriceIncludesTax: boolean
    avoqadoShareOfProviderMargin: unknown
    avoqadoShareOfAggregatorMargin: unknown
    taxRate: unknown
  } | null,
): MerchantRevenueShareConfig | null {
  if (!ms) return null
  return {
    aggregatorPrice:
      ms.aggregatorPrice && typeof ms.aggregatorPrice === 'object' && !Array.isArray(ms.aggregatorPrice)
        ? (ms.aggregatorPrice as Record<CardType, number>)
        : null,
    aggregatorPriceIncludesTax: ms.aggregatorPriceIncludesTax,
    avoqadoShareOfProviderMargin: Number(ms.avoqadoShareOfProviderMargin),
    avoqadoShareOfAggregatorMargin: ms.avoqadoShareOfAggregatorMargin == null ? null : Number(ms.avoqadoShareOfAggregatorMargin),
    taxRate: Number(ms.taxRate),
  }
}

export interface EarningsTotals {
  netProfit: number // terminalNet + onlineFees — the headline (Avoqado's real take)
  terminalNet: number // Σ avoqadoNet across terminal transactions (both tramos)
  onlineFees: number // Σ applicationFeeCents / 100 (already Avoqado's net)
  tramoProvider: number // Σ Avoqado's cut of the provider→aggregator margin
  tramoAggregator: number // Σ Avoqado's cut of the aggregator→venue margin
  aggregatorKept: number // Σ what the aggregator kept (context)
  volume: number
  transactions: number
  averageMargin: number // terminalNet / terminalVolume (Avoqado's effective take rate)
}
export interface VenueEarnings {
  venueId: string
  venueName: string
  netProfit: number
  terminalNet: number
  onlineFees: number
  volume: number
  transactions: number
}
export interface MerchantEarnings {
  merchantAccountId: string
  label: string
  providerCode: string
  hasAggregator: boolean
  netProfit: number
  tramoProvider: number
  tramoAggregator: number
  volume: number
  transactions: number
}
export interface ProviderEarnings {
  providerId: string
  providerCode: string
  providerName: string
  volume: number
  netProfit: number
  transactions: number
}
export interface CardTypeEarnings {
  type: string
  transactions: number
  volume: number
  netProfit: number
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
export interface EarningsTimePoint {
  date: string
  terminalNet: number
  onlineFees: number
  net: number
}

const TX_INCLUDE = {
  payment: { select: { venue: { select: { id: true, name: true } } } },
  merchantAccount: {
    select: {
      id: true,
      alias: true,
      displayName: true,
      externalMerchantId: true,
      provider: { select: { id: true, code: true, name: true } },
      merchantRevenueShare: true,
    },
  },
} as const

export async function getEarningsSummary(range?: DateRange, filter?: EarningsFilter): Promise<EarningsSummary> {
  const { startDate, endDate } = resolveRange(range)
  logger.info('Calculating earnings summary (revenue-share net)', { startDate, endDate, filter })

  const terminalWhere: Prisma.TransactionCostWhereInput = {
    createdAt: { gte: startDate, lte: endDate },
    ...(filter?.venueId ? { payment: { venueId: filter.venueId } } : {}),
    ...(filter?.merchantAccountId ? { merchantAccountId: filter.merchantAccountId } : {}),
  }
  // E-commerce is never tied to a POS merchant account → skip online when merchant-scoped.
  const includeOnline = !filter?.merchantAccountId
  const onlineVenueClause = filter?.venueId ? Prisma.sql`AND em."venueId" = ${filter.venueId}` : Prisma.empty

  const txs = await prisma.transactionCost.findMany({ where: terminalWhere, include: TX_INCLUDE })

  let onlineByVenue: Array<{ venueId: string; venueName: string; fees: bigint; volume: unknown; transactions: bigint }> = []
  let onlineFees = 0
  let onlineVolume = 0
  let onlineTxns = 0
  let channelRows: Array<{
    ecommerceMerchantId: string
    channelName: string | null
    businessName: string | null
    providerCode: string
    fees: bigint
    volume: unknown
    transactions: bigint
  }> = []

  if (includeOnline) {
    const [obv, oTotals, cr] = await Promise.all([
      prisma.$queryRaw<Array<{ venueId: string; venueName: string; fees: bigint; volume: unknown; transactions: bigint }>>(Prisma.sql`
        SELECT v.id as "venueId", v.name as "venueName",
               COALESCE(SUM(cs."applicationFeeCents"), 0) as fees,
               COALESCE(SUM(cs.amount), 0) as volume,
               COUNT(*) as transactions
        FROM "CheckoutSession" cs
        JOIN "EcommerceMerchant" em ON cs."ecommerceMerchantId" = em.id
        JOIN "Venue" v ON em."venueId" = v.id
        WHERE cs.status = 'COMPLETED' AND cs."createdAt" >= ${startDate} AND cs."createdAt" <= ${endDate} ${onlineVenueClause}
        GROUP BY v.id, v.name
      `),
      prisma.checkoutSession.aggregate({
        where: {
          status: 'COMPLETED',
          createdAt: { gte: startDate, lte: endDate },
          ...(filter?.venueId ? { ecommerceMerchant: { venueId: filter.venueId } } : {}),
        },
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
          volume: unknown
          transactions: bigint
        }>
      >(Prisma.sql`
        SELECT em.id as "ecommerceMerchantId", em."channelName", em."businessName", pp.code as "providerCode",
               COALESCE(SUM(cs."applicationFeeCents"), 0) as fees,
               COALESCE(SUM(cs.amount), 0) as volume,
               COUNT(*) as transactions
        FROM "CheckoutSession" cs
        JOIN "EcommerceMerchant" em ON cs."ecommerceMerchantId" = em.id
        JOIN "PaymentProvider" pp ON em."providerId" = pp.id
        WHERE cs.status = 'COMPLETED' AND cs."createdAt" >= ${startDate} AND cs."createdAt" <= ${endDate} ${onlineVenueClause}
        GROUP BY em.id, em."channelName", em."businessName", pp.code
        ORDER BY fees DESC
      `),
    ])
    onlineByVenue = obv
    onlineFees = centsToMxn(oTotals._sum.applicationFeeCents)
    onlineVolume = Number(oTotals._sum.amount) || 0
    onlineTxns = oTotals._count
    channelRows = cr
  }

  const venueMap = new Map<string, VenueEarnings>()
  const merchantMap = new Map<string, MerchantEarnings>()
  const providerMap = new Map<string, ProviderEarnings>()
  const cardMap = new Map<string, CardTypeEarnings>()

  let terminalNet = 0
  let tramoProvider = 0
  let tramoAggregator = 0
  let aggregatorKept = 0
  let terminalVolume = 0
  let terminalTxns = 0

  for (const tc of txs) {
    const m = tc.merchantAccount
    const cardType = toCardType(tc.transactionType)
    const share = mapShare(m.merchantRevenueShare)
    const split = computeRevenueSplit({
      amount: Number(tc.amount),
      cardType,
      providerCostRate: Number(tc.providerRate),
      providerCostIncludesTax: true,
      venueChargeRate: Number(tc.venueRate),
      venueChargeIncludesTax: true,
      share,
    })
    const amount = Number(tc.amount)
    const net = split.avoqadoNet

    terminalNet += net
    tramoProvider += split.avoqadoFromProviderMargin
    tramoAggregator += split.avoqadoFromAggregatorMargin
    aggregatorKept += split.aggregatorNet
    terminalVolume += amount
    terminalTxns += 1

    const v = tc.payment.venue
    const ve = venueMap.get(v.id) ?? {
      venueId: v.id,
      venueName: v.name,
      netProfit: 0,
      terminalNet: 0,
      onlineFees: 0,
      volume: 0,
      transactions: 0,
    }
    ve.terminalNet += net
    ve.netProfit += net
    ve.volume += amount
    ve.transactions += 1
    venueMap.set(v.id, ve)

    const me = merchantMap.get(m.id) ?? {
      merchantAccountId: m.id,
      label: m.displayName || m.alias || m.externalMerchantId,
      providerCode: m.provider.code,
      hasAggregator: !!share?.aggregatorPrice,
      netProfit: 0,
      tramoProvider: 0,
      tramoAggregator: 0,
      volume: 0,
      transactions: 0,
    }
    me.netProfit += net
    me.tramoProvider += split.avoqadoFromProviderMargin
    me.tramoAggregator += split.avoqadoFromAggregatorMargin
    me.volume += amount
    me.transactions += 1
    merchantMap.set(m.id, me)

    const pe = providerMap.get(m.provider.id) ?? {
      providerId: m.provider.id,
      providerCode: m.provider.code,
      providerName: m.provider.name,
      volume: 0,
      netProfit: 0,
      transactions: 0,
    }
    pe.netProfit += net
    pe.volume += amount
    pe.transactions += 1
    providerMap.set(m.provider.id, pe)

    const ce = cardMap.get(cardType) ?? { type: cardType, transactions: 0, volume: 0, netProfit: 0 }
    ce.netProfit += net
    ce.volume += amount
    ce.transactions += 1
    cardMap.set(cardType, ce)
  }

  for (const o of onlineByVenue) {
    const fees = centsToMxn(o.fees)
    const vol = Number(o.volume)
    const txns = Number(o.transactions)
    const ve = venueMap.get(o.venueId) ?? {
      venueId: o.venueId,
      venueName: o.venueName,
      netProfit: 0,
      terminalNet: 0,
      onlineFees: 0,
      volume: 0,
      transactions: 0,
    }
    ve.onlineFees += fees
    ve.netProfit += fees
    ve.volume += vol
    ve.transactions += txns
    venueMap.set(o.venueId, ve)
  }

  const totals: EarningsTotals = {
    netProfit: round2(terminalNet + onlineFees),
    terminalNet: round2(terminalNet),
    onlineFees: round2(onlineFees),
    tramoProvider: round2(tramoProvider),
    tramoAggregator: round2(tramoAggregator),
    aggregatorKept: round2(aggregatorKept),
    volume: round2(terminalVolume + onlineVolume),
    transactions: terminalTxns + onlineTxns,
    averageMargin: terminalVolume > 0 ? terminalNet / terminalVolume : 0,
  }

  return {
    range: { startDate: startDate.toISOString(), endDate: endDate.toISOString() },
    totals,
    byVenue: Array.from(venueMap.values())
      .map(r => ({
        ...r,
        netProfit: round2(r.netProfit),
        terminalNet: round2(r.terminalNet),
        onlineFees: round2(r.onlineFees),
        volume: round2(r.volume),
      }))
      .sort((a, b) => b.netProfit - a.netProfit),
    byMerchant: Array.from(merchantMap.values())
      .map(r => ({
        ...r,
        netProfit: round2(r.netProfit),
        tramoProvider: round2(r.tramoProvider),
        tramoAggregator: round2(r.tramoAggregator),
        volume: round2(r.volume),
      }))
      .sort((a, b) => b.netProfit - a.netProfit),
    byProvider: Array.from(providerMap.values())
      .map(r => ({ ...r, netProfit: round2(r.netProfit), volume: round2(r.volume) }))
      .sort((a, b) => b.volume - a.volume),
    byCardType: Array.from(cardMap.values()).map(r => ({ ...r, netProfit: round2(r.netProfit), volume: round2(r.volume) })),
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
  granularity: Granularity = 'daily',
  filter?: EarningsFilter,
): Promise<EarningsTimePoint[]> {
  const { startDate, endDate } = resolveRange(range)

  const txs = await prisma.transactionCost.findMany({
    where: {
      createdAt: { gte: startDate, lte: endDate },
      ...(filter?.venueId ? { payment: { venueId: filter.venueId } } : {}),
      ...(filter?.merchantAccountId ? { merchantAccountId: filter.merchantAccountId } : {}),
    },
    include: TX_INCLUDE,
  })
  const onlineSessions = filter?.merchantAccountId
    ? []
    : await prisma.checkoutSession.findMany({
        where: {
          status: 'COMPLETED',
          createdAt: { gte: startDate, lte: endDate },
          ...(filter?.venueId ? { ecommerceMerchant: { venueId: filter.venueId } } : {}),
        },
        select: { createdAt: true, applicationFeeCents: true },
      })

  const map = new Map<string, EarningsTimePoint>()
  const at = (k: string): EarningsTimePoint => {
    let p = map.get(k)
    if (!p) {
      p = { date: k, terminalNet: 0, onlineFees: 0, net: 0 }
      map.set(k, p)
    }
    return p
  }

  for (const tc of txs) {
    const m = tc.merchantAccount
    const split = computeRevenueSplit({
      amount: Number(tc.amount),
      cardType: toCardType(tc.transactionType),
      providerCostRate: Number(tc.providerRate),
      providerCostIncludesTax: true,
      venueChargeRate: Number(tc.venueRate),
      venueChargeIncludesTax: true,
      share: mapShare(m.merchantRevenueShare),
    })
    const p = at(bucketKey(tc.createdAt, granularity))
    p.terminalNet += split.avoqadoNet
    p.net += split.avoqadoNet
  }
  for (const cs of onlineSessions) {
    const fees = centsToMxn(cs.applicationFeeCents)
    const p = at(bucketKey(cs.createdAt, granularity))
    p.onlineFees += fees
    p.net += fees
  }

  return Array.from(map.values())
    .map(p => ({ date: p.date, terminalNet: round2(p.terminalNet), onlineFees: round2(p.onlineFees), net: round2(p.net) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
}
