import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { TransactionCardType, Prisma } from '@prisma/client'

/**
 * PaymentAnalytics Service
 *
 * Provides comprehensive analytics and reporting for payment processing economics.
 * This service aggregates data from TransactionCost records to provide insights into:
 * - Revenue (what Avoqado charges venues)
 * - Costs (what Avoqado pays providers)
 * - Profit (revenue - costs)
 * - Margins (profit / revenue)
 *
 * Key Metrics:
 * 1. System-Wide Metrics - Total revenue, costs, profit across all venues
 * 2. Venue-Specific Metrics - Per-venue profitability analysis
 * 3. Provider Analysis - Cost comparison across payment providers
 * 4. Card Type Breakdown - Performance by transaction type (DEBIT/CREDIT/AMEX/INTERNATIONAL)
 * 5. Time-Series Analysis - Trends over time (daily, weekly, monthly)
 *
 * Use Cases:
 * - Superadmin dashboard overview
 * - Monthly financial reporting
 * - Provider cost comparison (optimize provider selection)
 * - Venue profitability analysis (identify high/low margin venues)
 * - Pricing strategy optimization
 */

interface DateRange {
  startDate?: Date
  endDate?: Date
}

interface ProfitMetrics {
  // Volume metrics
  totalTransactions: number
  totalVolume: number
  averageTransactionSize: number

  // By card type
  byCardType: {
    type: TransactionCardType
    transactions: number
    volume: number
    providerCost: number
    venueCharge: number
    profit: number
    margin: number
  }[]

  // Financial metrics
  totalProviderCost: number
  totalVenueCharge: number
  totalProfit: number
  averageMargin: number

  // Top performers
  topVenues: {
    venueId: string
    venueName: string
    transactions: number
    volume: number
    profit: number
    margin: number
  }[]

  topProviders: {
    providerId: string
    providerCode: string
    providerName: string
    transactions: number
    volume: number
    cost: number
  }[]
}

/**
 * Get comprehensive profit metrics for a date range
 * Uses aggregate/groupBy/raw SQL instead of loading all rows into memory.
 * @param dateRange Optional date range (defaults to current month)
 * @returns Aggregated profit metrics
 */
export async function getProfitMetrics(dateRange?: DateRange): Promise<ProfitMetrics> {
  const { startDate, endDate } = getDateRange(dateRange)

  logger.info('Calculating profit metrics', { startDate, endDate })

  const dateFilter = { createdAt: { gte: startDate, lte: endDate } }

  // 1. Overall totals via aggregate (single query, no row loading)
  // 2. By card type via groupBy
  // 3. Top venues via raw SQL (need venue name from join)
  // 4. Top providers via raw SQL (need provider name from join)
  const [totals, byCardTypeRaw, topVenuesRaw, topProvidersRaw] = await Promise.all([
    prisma.transactionCost.aggregate({
      where: dateFilter,
      _count: true,
      _sum: {
        amount: true,
        providerCostAmount: true,
        providerFixedFee: true,
        venueChargeAmount: true,
        venueFixedFee: true,
        grossProfit: true,
      },
    }),
    prisma.transactionCost.groupBy({
      by: ['transactionType'],
      where: dateFilter,
      _count: true,
      _sum: {
        amount: true,
        providerCostAmount: true,
        providerFixedFee: true,
        venueChargeAmount: true,
        venueFixedFee: true,
        grossProfit: true,
      },
    }),
    prisma.$queryRaw<
      Array<{
        venueId: string
        venueName: string
        transactions: bigint
        volume: Prisma.Decimal
        venueCharge: Prisma.Decimal
        profit: Prisma.Decimal
      }>
    >`
      SELECT
        v.id as "venueId",
        v.name as "venueName",
        COUNT(*) as transactions,
        COALESCE(SUM(tc.amount), 0) as volume,
        COALESCE(SUM(tc."venueChargeAmount" + tc."venueFixedFee"), 0) as "venueCharge",
        COALESCE(SUM(tc."grossProfit"), 0) as profit
      FROM "TransactionCost" tc
      JOIN "Payment" p ON tc."paymentId" = p.id
      JOIN "Venue" v ON p."venueId" = v.id
      WHERE tc."createdAt" >= ${startDate} AND tc."createdAt" <= ${endDate}
      GROUP BY v.id, v.name
      ORDER BY profit DESC
      LIMIT 10
    `,
    prisma.$queryRaw<
      Array<{
        providerId: string
        providerCode: string
        providerName: string
        transactions: bigint
        volume: Prisma.Decimal
        cost: Prisma.Decimal
      }>
    >`
      SELECT
        pp.id as "providerId",
        pp.code as "providerCode",
        pp.name as "providerName",
        COUNT(*) as transactions,
        COALESCE(SUM(tc.amount), 0) as volume,
        COALESCE(SUM(tc."providerCostAmount" + tc."providerFixedFee"), 0) as cost
      FROM "TransactionCost" tc
      JOIN "MerchantAccount" ma ON tc."merchantAccountId" = ma.id
      JOIN "PaymentProvider" pp ON ma."providerId" = pp.id
      WHERE tc."createdAt" >= ${startDate} AND tc."createdAt" <= ${endDate}
      GROUP BY pp.id, pp.code, pp.name
      ORDER BY volume DESC
      LIMIT 10
    `,
  ])

  const totalTransactions = totals._count
  const totalVolume = Number(totals._sum.amount) || 0
  const totalProviderCost = (Number(totals._sum.providerCostAmount) || 0) + (Number(totals._sum.providerFixedFee) || 0)
  const totalVenueCharge = (Number(totals._sum.venueChargeAmount) || 0) + (Number(totals._sum.venueFixedFee) || 0)
  const totalProfit = Number(totals._sum.grossProfit) || 0
  const averageTransactionSize = totalTransactions > 0 ? totalVolume / totalTransactions : 0
  const averageMargin = totalVenueCharge > 0 ? totalProfit / totalVenueCharge : 0

  // Map groupBy results by card type
  const cardTypeMap = new Map(byCardTypeRaw.map(r => [r.transactionType, r]))
  const byCardType = Object.values(TransactionCardType).map(type => {
    const row = cardTypeMap.get(type)
    if (!row) return { type, transactions: 0, volume: 0, providerCost: 0, venueCharge: 0, profit: 0, margin: 0 }
    const volume = Number(row._sum.amount) || 0
    const providerCost = (Number(row._sum.providerCostAmount) || 0) + (Number(row._sum.providerFixedFee) || 0)
    const venueCharge = (Number(row._sum.venueChargeAmount) || 0) + (Number(row._sum.venueFixedFee) || 0)
    const profit = Number(row._sum.grossProfit) || 0
    return {
      type,
      transactions: row._count,
      volume,
      providerCost,
      venueCharge,
      profit,
      margin: venueCharge > 0 ? profit / venueCharge : 0,
    }
  })

  const topVenues = topVenuesRaw.map(v => {
    const venueCharge = Number(v.venueCharge)
    const profit = Number(v.profit)
    return {
      venueId: v.venueId,
      venueName: v.venueName,
      transactions: Number(v.transactions),
      volume: Number(v.volume),
      profit,
      margin: venueCharge > 0 ? profit / venueCharge : 0,
    }
  })

  const topProviders = topProvidersRaw.map(p => ({
    providerId: p.providerId,
    providerCode: p.providerCode,
    providerName: p.providerName,
    transactions: Number(p.transactions),
    volume: Number(p.volume),
    cost: Number(p.cost),
  }))

  logger.info('Profit metrics calculated', { totalTransactions, totalProfit, averageMargin })

  return {
    totalTransactions,
    totalVolume,
    averageTransactionSize,
    byCardType,
    totalProviderCost,
    totalVenueCharge,
    totalProfit,
    averageMargin,
    topVenues,
    topProviders,
  }
}

/**
 * Get venue-specific profit metrics
 * Uses aggregate/groupBy + raw SQL instead of loading all rows.
 * @param venueId Venue ID
 * @param dateRange Optional date range
 * @returns Venue profit metrics
 */
export async function getVenueProfitMetrics(venueId: string, dateRange?: DateRange) {
  const { startDate, endDate } = getDateRange(dateRange)

  logger.info('Calculating venue profit metrics', { venueId, startDate, endDate })

  const dateFilter = {
    payment: { venueId },
    createdAt: { gte: startDate, lte: endDate },
  }

  // Run all aggregations in parallel
  const [totals, byCardTypeRaw, byProviderRaw] = await Promise.all([
    // 1. Overall totals
    prisma.transactionCost.aggregate({
      where: dateFilter,
      _count: true,
      _sum: {
        amount: true,
        providerCostAmount: true,
        providerFixedFee: true,
        venueChargeAmount: true,
        venueFixedFee: true,
        grossProfit: true,
      },
    }),
    // 2. By card type
    prisma.transactionCost.groupBy({
      by: ['transactionType'],
      where: dateFilter,
      _count: true,
      _sum: { amount: true, grossProfit: true },
    }),
    // 3. By provider via raw SQL (need provider name/code from join)
    prisma.$queryRaw<
      Array<{
        providerId: string
        providerCode: string
        providerName: string
        transactions: bigint
        volume: Prisma.Decimal
        cost: Prisma.Decimal
      }>
    >`
      SELECT
        pp.id as "providerId",
        pp.code as "providerCode",
        pp.name as "providerName",
        COUNT(*) as transactions,
        COALESCE(SUM(tc.amount), 0) as volume,
        COALESCE(SUM(tc."providerCostAmount" + tc."providerFixedFee"), 0) as cost
      FROM "TransactionCost" tc
      JOIN "Payment" p ON tc."paymentId" = p.id
      JOIN "MerchantAccount" ma ON tc."merchantAccountId" = ma.id
      JOIN "PaymentProvider" pp ON ma."providerId" = pp.id
      WHERE p."venueId" = ${venueId}
        AND tc."createdAt" >= ${startDate} AND tc."createdAt" <= ${endDate}
      GROUP BY pp.id, pp.code, pp.name
    `,
  ])

  const totalTransactions = totals._count
  const totalVolume = Number(totals._sum.amount) || 0
  const totalProviderCost = (Number(totals._sum.providerCostAmount) || 0) + (Number(totals._sum.providerFixedFee) || 0)
  const totalVenueCharge = (Number(totals._sum.venueChargeAmount) || 0) + (Number(totals._sum.venueFixedFee) || 0)
  const totalProfit = Number(totals._sum.grossProfit) || 0
  const averageMargin = totalVenueCharge > 0 ? totalProfit / totalVenueCharge : 0

  const cardTypeMap = new Map(byCardTypeRaw.map(r => [r.transactionType, r]))
  const byCardType = Object.values(TransactionCardType).map(type => {
    const row = cardTypeMap.get(type)
    if (!row) return { type, transactions: 0, volume: 0, profit: 0 }
    return {
      type,
      transactions: row._count,
      volume: Number(row._sum.amount) || 0,
      profit: Number(row._sum.grossProfit) || 0,
    }
  })

  const byProvider = byProviderRaw.map(p => ({
    providerId: p.providerId,
    providerCode: p.providerCode,
    providerName: p.providerName,
    transactions: Number(p.transactions),
    volume: Number(p.volume),
    cost: Number(p.cost),
  }))

  return {
    venueId,
    totalTransactions,
    totalVolume,
    totalProviderCost,
    totalVenueCharge,
    totalProfit,
    averageMargin,
    byCardType,
    byProvider,
  }
}

/**
 * Get time-series profit data via raw SQL with DATE_TRUNC.
 * @param dateRange Date range
 * @param granularity Aggregation granularity (daily, weekly, monthly)
 * @returns Time-series data
 */
export async function getProfitTimeSeries(dateRange?: DateRange, granularity: 'daily' | 'weekly' | 'monthly' = 'daily') {
  const { startDate, endDate } = getDateRange(dateRange)

  logger.info('Calculating profit time series', { startDate, endDate, granularity })

  // Map TS enum to safe SQL keywords (no user input in these values)
  const truncInterval = granularity === 'weekly' ? 'week' : granularity === 'monthly' ? 'month' : 'day'
  const dateFormat = granularity === 'monthly' ? 'YYYY-MM' : 'YYYY-MM-DD'

  const rows = await prisma.$queryRaw<
    Array<{
      date: string
      transactions: bigint
      volume: Prisma.Decimal
      providerCost: Prisma.Decimal
      venueCharge: Prisma.Decimal
      profit: Prisma.Decimal
    }>
  >(
    Prisma.sql`
      SELECT
        TO_CHAR(DATE_TRUNC(${Prisma.raw(`'${truncInterval}'`)}, "createdAt"), ${Prisma.raw(`'${dateFormat}'`)}) as date,
        COUNT(*) as transactions,
        COALESCE(SUM(amount), 0) as volume,
        COALESCE(SUM("providerCostAmount" + "providerFixedFee"), 0) as "providerCost",
        COALESCE(SUM("venueChargeAmount" + "venueFixedFee"), 0) as "venueCharge",
        COALESCE(SUM("grossProfit"), 0) as profit
      FROM "TransactionCost"
      WHERE "createdAt" >= ${startDate} AND "createdAt" <= ${endDate}
      GROUP BY date
      ORDER BY date
    `,
  )

  return rows.map(d => {
    const venueCharge = Number(d.venueCharge)
    const profit = Number(d.profit)
    return {
      date: d.date,
      transactions: Number(d.transactions),
      volume: Number(d.volume),
      providerCost: Number(d.providerCost),
      venueCharge,
      profit,
      margin: venueCharge > 0 ? profit / venueCharge : 0,
    }
  })
}

/**
 * Get provider comparison data via raw SQL with 2-dimensional grouping (provider x cardType).
 * @param dateRange Optional date range
 * @returns Provider comparison metrics
 */
export async function getProviderComparison(dateRange?: DateRange) {
  const { startDate, endDate } = getDateRange(dateRange)

  logger.info('Calculating provider comparison', { startDate, endDate })

  // Single query with provider + card type grouping
  const rows = await prisma.$queryRaw<
    Array<{
      providerId: string
      providerCode: string
      providerName: string
      transactionType: string
      transactions: bigint
      volume: Prisma.Decimal
      cost: Prisma.Decimal
    }>
  >`
    SELECT
      pp.id as "providerId",
      pp.code as "providerCode",
      pp.name as "providerName",
      tc."transactionType" as "transactionType",
      COUNT(*) as transactions,
      COALESCE(SUM(tc.amount), 0) as volume,
      COALESCE(SUM(tc."providerCostAmount" + tc."providerFixedFee"), 0) as cost
    FROM "TransactionCost" tc
    JOIN "MerchantAccount" ma ON tc."merchantAccountId" = ma.id
    JOIN "PaymentProvider" pp ON ma."providerId" = pp.id
    WHERE tc."createdAt" >= ${startDate} AND tc."createdAt" <= ${endDate}
    GROUP BY pp.id, pp.code, pp.name, tc."transactionType"
  `

  // Aggregate rows by provider, nesting card types
  const providerMap = new Map<
    string,
    {
      providerId: string
      providerCode: string
      providerName: string
      transactions: number
      volume: number
      totalCost: number
      byCardType: Record<string, { transactions: number; volume: number; cost: number }>
    }
  >()

  for (const row of rows) {
    if (!providerMap.has(row.providerId)) {
      const byCardType: Record<string, { transactions: number; volume: number; cost: number }> = {}
      for (const ct of Object.values(TransactionCardType)) {
        byCardType[ct] = { transactions: 0, volume: 0, cost: 0 }
      }
      providerMap.set(row.providerId, {
        providerId: row.providerId,
        providerCode: row.providerCode,
        providerName: row.providerName,
        transactions: 0,
        volume: 0,
        totalCost: 0,
        byCardType,
      })
    }

    const p = providerMap.get(row.providerId)!
    const txns = Number(row.transactions)
    const vol = Number(row.volume)
    const cost = Number(row.cost)
    p.transactions += txns
    p.volume += vol
    p.totalCost += cost
    if (p.byCardType[row.transactionType]) {
      p.byCardType[row.transactionType].transactions += txns
      p.byCardType[row.transactionType].volume += vol
      p.byCardType[row.transactionType].cost += cost
    }
  }

  return Array.from(providerMap.values()).map(p => ({
    ...p,
    averageCostPerTransaction: p.transactions > 0 ? p.totalCost / p.transactions : 0,
    effectiveRate: p.volume > 0 ? p.totalCost / p.volume : 0,
    byCardType: Object.entries(p.byCardType).map(([type, data]) => ({
      type,
      ...data,
      effectiveRate: data.volume > 0 ? data.cost / data.volume : 0,
    })),
  }))
}

/**
 * Helper: Get date range with defaults
 */
function getDateRange(dateRange?: DateRange): { startDate: Date; endDate: Date } {
  const endDate = dateRange?.endDate || new Date()

  // Default to current month if no start date provided
  let startDate = dateRange?.startDate
  if (!startDate) {
    startDate = new Date(endDate.getFullYear(), endDate.getMonth(), 1)
  }

  return { startDate, endDate }
}

/**
 * Export profit data for a date range
 * Returns data in a format suitable for CSV/Excel export.
 * NOTE: This function intentionally loads all rows — export needs per-row detail.
 * @param dateRange Date range
 * @returns Export data
 */
export async function exportProfitData(dateRange?: DateRange) {
  const { startDate, endDate } = getDateRange(dateRange)

  logger.info('Exporting profit data', { startDate, endDate })

  const transactionCosts = await prisma.transactionCost.findMany({
    where: {
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
    },
    include: {
      payment: {
        include: {
          venue: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
        },
      },
      merchantAccount: {
        include: {
          provider: {
            select: {
              code: true,
              name: true,
            },
          },
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  })

  const exportData = transactionCosts.map(tc => ({
    date: tc.createdAt.toISOString(),
    paymentId: tc.paymentId,
    venueId: tc.payment.venue.id,
    venueName: tc.payment.venue.name,
    venueSlug: tc.payment.venue.slug,
    providerCode: tc.merchantAccount.provider.code,
    providerName: tc.merchantAccount.provider.name,
    transactionType: tc.transactionType,
    amount: parseFloat(tc.amount.toString()),
    providerRate: parseFloat(tc.providerRate.toString()),
    providerCostAmount: parseFloat(tc.providerCostAmount.toString()),
    providerFixedFee: parseFloat(tc.providerFixedFee.toString()),
    venueRate: parseFloat(tc.venueRate.toString()),
    venueChargeAmount: parseFloat(tc.venueChargeAmount.toString()),
    venueFixedFee: parseFloat(tc.venueFixedFee.toString()),
    grossProfit: parseFloat(tc.grossProfit.toString()),
    profitMargin: parseFloat(tc.profitMargin.toString()),
  }))

  logger.info('Profit data exported', {
    rows: exportData.length,
  })

  return exportData
}
