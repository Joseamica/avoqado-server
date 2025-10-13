import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { TransactionCardType } from '@prisma/client'

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
 * @param dateRange Optional date range (defaults to current month)
 * @returns Aggregated profit metrics
 */
export async function getProfitMetrics(dateRange?: DateRange): Promise<ProfitMetrics> {
  const { startDate, endDate } = getDateRange(dateRange)

  logger.info('Calculating profit metrics', { startDate, endDate })

  // Get all transaction costs in the date range
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
            },
          },
        },
      },
      merchantAccount: {
        include: {
          provider: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
        },
      },
    },
  })

  // Calculate overall metrics
  const totalTransactions = transactionCosts.length
  const totalVolume = transactionCosts.reduce((sum, tc) => sum + parseFloat(tc.amount.toString()), 0)
  const totalProviderCost = transactionCosts.reduce(
    (sum, tc) => sum + parseFloat(tc.providerCostAmount.toString()) + parseFloat(tc.providerFixedFee.toString()),
    0,
  )
  const totalVenueCharge = transactionCosts.reduce(
    (sum, tc) => sum + parseFloat(tc.venueChargeAmount.toString()) + parseFloat(tc.venueFixedFee.toString()),
    0,
  )
  const totalProfit = transactionCosts.reduce((sum, tc) => sum + parseFloat(tc.grossProfit.toString()), 0)

  const averageTransactionSize = totalTransactions > 0 ? totalVolume / totalTransactions : 0
  const averageMargin = totalVenueCharge > 0 ? totalProfit / totalVenueCharge : 0

  // Group by card type
  const byCardType = Object.values(TransactionCardType).map(type => {
    const typeCosts = transactionCosts.filter(tc => tc.transactionType === type)
    const typeVolume = typeCosts.reduce((sum, tc) => sum + parseFloat(tc.amount.toString()), 0)
    const typeProviderCost = typeCosts.reduce(
      (sum, tc) => sum + parseFloat(tc.providerCostAmount.toString()) + parseFloat(tc.providerFixedFee.toString()),
      0,
    )
    const typeVenueCharge = typeCosts.reduce(
      (sum, tc) => sum + parseFloat(tc.venueChargeAmount.toString()) + parseFloat(tc.venueFixedFee.toString()),
      0,
    )
    const typeProfit = typeCosts.reduce((sum, tc) => sum + parseFloat(tc.grossProfit.toString()), 0)

    return {
      type,
      transactions: typeCosts.length,
      volume: typeVolume,
      providerCost: typeProviderCost,
      venueCharge: typeVenueCharge,
      profit: typeProfit,
      margin: typeVenueCharge > 0 ? typeProfit / typeVenueCharge : 0,
    }
  })

  // Group by venue
  const venueMap = new Map<string, any>()
  transactionCosts.forEach(tc => {
    const venueId = tc.payment.venue.id
    if (!venueMap.has(venueId)) {
      venueMap.set(venueId, {
        venueId,
        venueName: tc.payment.venue.name,
        transactions: 0,
        volume: 0,
        providerCost: 0,
        venueCharge: 0,
        profit: 0,
      })
    }

    const venue = venueMap.get(venueId)
    venue.transactions++
    venue.volume += parseFloat(tc.amount.toString())
    venue.providerCost += parseFloat(tc.providerCostAmount.toString()) + parseFloat(tc.providerFixedFee.toString())
    venue.venueCharge += parseFloat(tc.venueChargeAmount.toString()) + parseFloat(tc.venueFixedFee.toString())
    venue.profit += parseFloat(tc.grossProfit.toString())
  })

  const topVenues = Array.from(venueMap.values())
    .map(v => ({
      ...v,
      margin: v.venueCharge > 0 ? v.profit / v.venueCharge : 0,
    }))
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 10)

  // Group by provider
  const providerMap = new Map<string, any>()
  transactionCosts.forEach(tc => {
    const providerId = tc.merchantAccount.provider.id
    if (!providerMap.has(providerId)) {
      providerMap.set(providerId, {
        providerId,
        providerCode: tc.merchantAccount.provider.code,
        providerName: tc.merchantAccount.provider.name,
        transactions: 0,
        volume: 0,
        cost: 0,
      })
    }

    const provider = providerMap.get(providerId)
    provider.transactions++
    provider.volume += parseFloat(tc.amount.toString())
    provider.cost += parseFloat(tc.providerCostAmount.toString()) + parseFloat(tc.providerFixedFee.toString())
  })

  const topProviders = Array.from(providerMap.values())
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 10)

  logger.info('Profit metrics calculated', {
    totalTransactions,
    totalProfit,
    averageMargin,
  })

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
 * @param venueId Venue ID
 * @param dateRange Optional date range
 * @returns Venue profit metrics
 */
export async function getVenueProfitMetrics(venueId: string, dateRange?: DateRange) {
  const { startDate, endDate } = getDateRange(dateRange)

  logger.info('Calculating venue profit metrics', { venueId, startDate, endDate })

  const transactionCosts = await prisma.transactionCost.findMany({
    where: {
      payment: {
        venueId,
      },
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
    },
    include: {
      payment: true,
      merchantAccount: {
        include: {
          provider: true,
        },
      },
    },
  })

  const totalTransactions = transactionCosts.length
  const totalVolume = transactionCosts.reduce((sum, tc) => sum + parseFloat(tc.amount.toString()), 0)
  const totalProviderCost = transactionCosts.reduce(
    (sum, tc) => sum + parseFloat(tc.providerCostAmount.toString()) + parseFloat(tc.providerFixedFee.toString()),
    0,
  )
  const totalVenueCharge = transactionCosts.reduce(
    (sum, tc) => sum + parseFloat(tc.venueChargeAmount.toString()) + parseFloat(tc.venueFixedFee.toString()),
    0,
  )
  const totalProfit = transactionCosts.reduce((sum, tc) => sum + parseFloat(tc.grossProfit.toString()), 0)

  const averageMargin = totalVenueCharge > 0 ? totalProfit / totalVenueCharge : 0

  // By card type
  const byCardType = Object.values(TransactionCardType).map(type => {
    const typeCosts = transactionCosts.filter(tc => tc.transactionType === type)
    const typeVolume = typeCosts.reduce((sum, tc) => sum + parseFloat(tc.amount.toString()), 0)
    const typeProfit = typeCosts.reduce((sum, tc) => sum + parseFloat(tc.grossProfit.toString()), 0)

    return {
      type,
      transactions: typeCosts.length,
      volume: typeVolume,
      profit: typeProfit,
    }
  })

  // By provider
  const providerMap = new Map<string, any>()
  transactionCosts.forEach(tc => {
    const providerId = tc.merchantAccount.provider.id
    if (!providerMap.has(providerId)) {
      providerMap.set(providerId, {
        providerId,
        providerCode: tc.merchantAccount.provider.code,
        providerName: tc.merchantAccount.provider.name,
        transactions: 0,
        volume: 0,
        cost: 0,
      })
    }

    const provider = providerMap.get(providerId)
    provider.transactions++
    provider.volume += parseFloat(tc.amount.toString())
    provider.cost += parseFloat(tc.providerCostAmount.toString()) + parseFloat(tc.providerFixedFee.toString())
  })

  const byProvider = Array.from(providerMap.values())

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
 * Get time-series profit data (daily aggregation)
 * @param dateRange Date range
 * @param granularity Aggregation granularity (daily, weekly, monthly)
 * @returns Time-series data
 */
export async function getProfitTimeSeries(
  dateRange?: DateRange,
  granularity: 'daily' | 'weekly' | 'monthly' = 'daily',
) {
  const { startDate, endDate } = getDateRange(dateRange)

  logger.info('Calculating profit time series', { startDate, endDate, granularity })

  // Fetch all transaction costs in range
  const transactionCosts = await prisma.transactionCost.findMany({
    where: {
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
    },
    orderBy: {
      createdAt: 'asc',
    },
  })

  // Group by date
  const dataByDate = new Map<string, any>()

  transactionCosts.forEach(tc => {
    const dateKey = getDateKey(tc.createdAt, granularity)

    if (!dataByDate.has(dateKey)) {
      dataByDate.set(dateKey, {
        date: dateKey,
        transactions: 0,
        volume: 0,
        providerCost: 0,
        venueCharge: 0,
        profit: 0,
      })
    }

    const data = dataByDate.get(dateKey)
    data.transactions++
    data.volume += parseFloat(tc.amount.toString())
    data.providerCost += parseFloat(tc.providerCostAmount.toString()) + parseFloat(tc.providerFixedFee.toString())
    data.venueCharge += parseFloat(tc.venueChargeAmount.toString()) + parseFloat(tc.venueFixedFee.toString())
    data.profit += parseFloat(tc.grossProfit.toString())
  })

  const timeSeries = Array.from(dataByDate.values())
    .map(d => ({
      ...d,
      margin: d.venueCharge > 0 ? d.profit / d.venueCharge : 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return timeSeries
}

/**
 * Get provider comparison data
 * Shows cost comparison across all providers
 * @param dateRange Optional date range
 * @returns Provider comparison metrics
 */
export async function getProviderComparison(dateRange?: DateRange) {
  const { startDate, endDate } = getDateRange(dateRange)

  logger.info('Calculating provider comparison', { startDate, endDate })

  const transactionCosts = await prisma.transactionCost.findMany({
    where: {
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
    },
    include: {
      merchantAccount: {
        include: {
          provider: true,
        },
      },
    },
  })

  const providerMap = new Map<string, any>()

  transactionCosts.forEach(tc => {
    const providerId = tc.merchantAccount.provider.id
    if (!providerMap.has(providerId)) {
      providerMap.set(providerId, {
        providerId,
        providerCode: tc.merchantAccount.provider.code,
        providerName: tc.merchantAccount.provider.name,
        transactions: 0,
        volume: 0,
        totalCost: 0,
        byCardType: {
          [TransactionCardType.DEBIT]: { transactions: 0, volume: 0, cost: 0 },
          [TransactionCardType.CREDIT]: { transactions: 0, volume: 0, cost: 0 },
          [TransactionCardType.AMEX]: { transactions: 0, volume: 0, cost: 0 },
          [TransactionCardType.INTERNATIONAL]: { transactions: 0, volume: 0, cost: 0 },
          [TransactionCardType.OTHER]: { transactions: 0, volume: 0, cost: 0 },
        },
      })
    }

    const provider = providerMap.get(providerId)
    const cost = parseFloat(tc.providerCostAmount.toString()) + parseFloat(tc.providerFixedFee.toString())
    const volume = parseFloat(tc.amount.toString())

    provider.transactions++
    provider.volume += volume
    provider.totalCost += cost

    // By card type
    const cardType = tc.transactionType
    provider.byCardType[cardType].transactions++
    provider.byCardType[cardType].volume += volume
    provider.byCardType[cardType].cost += cost
  })

  const providers = Array.from(providerMap.values()).map(p => ({
    ...p,
    averageCostPerTransaction: p.transactions > 0 ? p.totalCost / p.transactions : 0,
    effectiveRate: p.volume > 0 ? p.totalCost / p.volume : 0,
    byCardType: Object.entries(p.byCardType).map(([type, data]: [string, any]) => ({
      type,
      ...data,
      effectiveRate: data.volume > 0 ? data.cost / data.volume : 0,
    })),
  }))

  return providers
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
 * Helper: Get date key for grouping
 */
function getDateKey(date: Date, granularity: 'daily' | 'weekly' | 'monthly'): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  switch (granularity) {
    case 'daily':
      return `${year}-${month}-${day}`
    case 'weekly':
      const weekStart = new Date(date)
      weekStart.setDate(date.getDate() - date.getDay())
      const weekYear = weekStart.getFullYear()
      const weekMonth = String(weekStart.getMonth() + 1).padStart(2, '0')
      const weekDay = String(weekStart.getDate()).padStart(2, '0')
      return `${weekYear}-${weekMonth}-${weekDay}`
    case 'monthly':
      return `${year}-${month}`
    default:
      return `${year}-${month}-${day}`
  }
}

/**
 * Export profit data for a date range
 * Returns data in a format suitable for CSV/Excel export
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
