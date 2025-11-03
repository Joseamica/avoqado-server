import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { TransactionCardType, SettlementStatus, SimulationType } from '@prisma/client'
import { NotFoundError } from '../../errors/AppError'
import { calculateSettlementDate, findActiveSettlementConfig } from '../payments/settlementCalculation.service'
import { addDays } from 'date-fns'

/**
 * Available Balance Dashboard Service
 *
 * Provides high-level functions for the Available Balance feature.
 * This service aggregates settlement data and presents it in a user-friendly format.
 *
 * Key functions:
 * - Get available balance summary (now, pending, next settlement)
 * - Breakdown by card type (Debit, Credit, Amex)
 * - Settlement timeline (past + future)
 * - Simulate transactions
 * - Project future balance based on historical patterns
 */

export interface AvailableBalanceSummary {
  totalSales: number
  totalFees: number
  availableNow: number // Already settled
  pendingSettlement: number // Awaiting settlement
  estimatedNextSettlement: {
    date: Date | null
    amount: number
  }
}

export interface CardTypeBreakdown {
  cardType: TransactionCardType
  totalSales: number
  fees: number
  netAmount: number
  settlementDays: number | null // Typical settlement days
  pendingAmount: number
  settledAmount: number
  transactionCount: number
}

export interface TimelineEntry {
  date: Date
  transactionCount: number
  grossAmount: number
  fees: number
  netAmount: number
  status: SettlementStatus
  estimatedSettlementDate: Date | null
}

/**
 * Get available balance summary for a venue
 *
 * @param venueId - Venue ID
 * @param dateRange - Optional date range filter
 * @returns Available balance summary
 */
export async function getAvailableBalance(venueId: string, dateRange?: { from: Date; to: Date }): Promise<AvailableBalanceSummary> {
  logger.info('Fetching available balance summary', { venueId, dateRange })

  // Build where clause
  const whereClause: any = {
    venueId,
    status: 'COMPLETED',
  }

  if (dateRange) {
    whereClause.createdAt = {
      gte: dateRange.from,
      lte: dateRange.to,
    }
  }

  // Get all completed payments with settlement info
  const payments = await prisma.payment.findMany({
    where: whereClause,
    include: {
      transaction: true,
      transactionCost: {
        select: {
          venueChargeAmount: true,
        },
      },
    },
  })

  // Calculate totals
  let totalSales = 0
  let totalFees = 0
  let availableNow = 0
  let pendingSettlement = 0
  const upcomingSettlements: { date: Date; amount: number }[] = []

  for (const payment of payments) {
    const amount = Number(payment.amount)
    const fees = payment.transactionCost ? Number(payment.transactionCost.venueChargeAmount) : 0
    const netAmount = amount - fees

    totalSales += amount
    totalFees += fees

    if (payment.transaction) {
      const { status, estimatedSettlementDate, netSettlementAmount } = payment.transaction

      if (status === SettlementStatus.SETTLED) {
        // Already settled
        availableNow += Number(netSettlementAmount || netAmount)
      } else {
        // Pending settlement
        pendingSettlement += Number(netSettlementAmount || netAmount)

        if (estimatedSettlementDate) {
          upcomingSettlements.push({
            date: estimatedSettlementDate,
            amount: Number(netSettlementAmount || netAmount),
          })
        }
      }
    } else {
      // No transaction record, assume pending
      pendingSettlement += netAmount
    }
  }

  // Find next settlement date and amount
  let estimatedNextSettlement: { date: Date | null; amount: number } = {
    date: null,
    amount: 0,
  }

  if (upcomingSettlements.length > 0) {
    // Sort by date ascending
    upcomingSettlements.sort((a, b) => a.date.getTime() - b.date.getTime())

    // Group by date and sum amounts
    const settlementsByDate = new Map<string, number>()
    for (const settlement of upcomingSettlements) {
      const dateKey = settlement.date.toISOString().split('T')[0]
      const currentAmount = settlementsByDate.get(dateKey) || 0
      settlementsByDate.set(dateKey, currentAmount + settlement.amount)
    }

    // Get first upcoming settlement
    const firstDate = upcomingSettlements[0].date
    const firstDateKey = firstDate.toISOString().split('T')[0]
    estimatedNextSettlement = {
      date: firstDate,
      amount: settlementsByDate.get(firstDateKey) || 0,
    }
  }

  logger.info('Available balance calculated', {
    venueId,
    totalSales,
    availableNow,
    pendingSettlement,
  })

  return {
    totalSales,
    totalFees,
    availableNow,
    pendingSettlement,
    estimatedNextSettlement,
  }
}

/**
 * Get balance breakdown by card type
 *
 * @param venueId - Venue ID
 * @param dateRange - Optional date range filter
 * @returns Array of card type breakdowns
 */
export async function getBalanceByCardType(venueId: string, dateRange?: { from: Date; to: Date }): Promise<CardTypeBreakdown[]> {
  logger.info('Fetching balance by card type', { venueId, dateRange })

  // Build where clause
  const whereClause: any = {
    venueId,
    transactionCost: {
      isNot: null, // Must have transaction cost
    },
  }

  if (dateRange) {
    whereClause.createdAt = {
      gte: dateRange.from,
      lte: dateRange.to,
    }
  }

  // Get payments with transaction costs
  const payments = await prisma.payment.findMany({
    where: whereClause,
    include: {
      transaction: true,
      transactionCost: {
        select: {
          transactionType: true,
          venueChargeAmount: true,
          merchantAccountId: true,
        },
      },
    },
  })

  // Group by card type
  const byCardType = new Map<
    TransactionCardType,
    {
      totalSales: number
      fees: number
      pendingAmount: number
      settledAmount: number
      transactionCount: number
      settlementDays: number[]
    }
  >()

  for (const payment of payments) {
    if (!payment.transactionCost) continue

    const cardType = payment.transactionCost.transactionType
    const amount = Number(payment.amount)
    const fees = Number(payment.transactionCost.venueChargeAmount)
    const netAmount = amount - fees

    // Get or initialize card type entry
    if (!byCardType.has(cardType)) {
      byCardType.set(cardType, {
        totalSales: 0,
        fees: 0,
        pendingAmount: 0,
        settledAmount: 0,
        transactionCount: 0,
        settlementDays: [],
      })
    }

    const entry = byCardType.get(cardType)!
    entry.totalSales += amount
    entry.fees += fees
    entry.transactionCount += 1

    // Check settlement status
    if (payment.transaction) {
      if (payment.transaction.status === SettlementStatus.SETTLED) {
        entry.settledAmount += Number(payment.transaction.netSettlementAmount || netAmount)
      } else {
        entry.pendingAmount += Number(payment.transaction.netSettlementAmount || netAmount)
      }

      // Track settlement days for average calculation
      if (payment.transaction.estimatedSettlementDate) {
        const daysDiff = Math.ceil(
          (payment.transaction.estimatedSettlementDate.getTime() - payment.createdAt.getTime()) / (1000 * 60 * 60 * 24),
        )
        entry.settlementDays.push(daysDiff)
      }
    } else {
      entry.pendingAmount += netAmount
    }
  }

  // Convert map to array
  const breakdown: CardTypeBreakdown[] = []
  for (const [cardType, data] of byCardType) {
    const avgSettlementDays =
      data.settlementDays.length > 0 ? Math.round(data.settlementDays.reduce((a, b) => a + b, 0) / data.settlementDays.length) : null

    breakdown.push({
      cardType,
      totalSales: data.totalSales,
      fees: data.fees,
      netAmount: data.totalSales - data.fees,
      settlementDays: avgSettlementDays,
      pendingAmount: data.pendingAmount,
      settledAmount: data.settledAmount,
      transactionCount: data.transactionCount,
    })
  }

  logger.info('Balance by card type calculated', { venueId, cardTypeCount: breakdown.length })

  return breakdown
}

/**
 * Get settlement timeline (past and future settlements)
 *
 * @param venueId - Venue ID
 * @param dateRange - Date range to show
 * @returns Array of timeline entries grouped by date
 */
export async function getSettlementTimeline(venueId: string, dateRange: { from: Date; to: Date }): Promise<TimelineEntry[]> {
  logger.info('Fetching settlement timeline', { venueId, dateRange })

  // Get payments within date range
  const payments = await prisma.payment.findMany({
    where: {
      venueId,
      status: 'COMPLETED',
      createdAt: {
        gte: dateRange.from,
        lte: dateRange.to,
      },
    },
    include: {
      transaction: true,
      transactionCost: {
        select: {
          venueChargeAmount: true,
        },
      },
    },
    orderBy: {
      createdAt: 'asc',
    },
  })

  // Group by transaction date
  const timelineMap = new Map<string, TimelineEntry>()

  for (const payment of payments) {
    const dateKey = payment.createdAt.toISOString().split('T')[0]
    const amount = Number(payment.amount)
    const fees = payment.transactionCost ? Number(payment.transactionCost.venueChargeAmount) : 0
    const netAmount = amount - fees

    if (!timelineMap.has(dateKey)) {
      timelineMap.set(dateKey, {
        date: new Date(dateKey),
        transactionCount: 0,
        grossAmount: 0,
        fees: 0,
        netAmount: 0,
        status: SettlementStatus.PENDING,
        estimatedSettlementDate: null,
      })
    }

    const entry = timelineMap.get(dateKey)!
    entry.transactionCount += 1
    entry.grossAmount += amount
    entry.fees += fees
    entry.netAmount += netAmount

    // Use first estimated settlement date as representative
    if (payment.transaction?.estimatedSettlementDate && !entry.estimatedSettlementDate) {
      entry.estimatedSettlementDate = payment.transaction.estimatedSettlementDate
    }

    // If any transaction is settled, mark day as settled
    if (payment.transaction?.status === SettlementStatus.SETTLED) {
      entry.status = SettlementStatus.SETTLED
    }
  }

  const timeline = Array.from(timelineMap.values()).sort((a, b) => a.date.getTime() - b.date.getTime())

  logger.info('Settlement timeline calculated', { venueId, entryCount: timeline.length })

  return timeline
}

/**
 * Simulate a manual transaction
 *
 * @param venueId - Venue ID
 * @param userId - User performing the simulation
 * @param params - Simulation parameters
 * @returns Simulation results
 */
export async function simulateTransaction(
  venueId: string,
  userId: string,
  params: {
    amount: number
    cardType: TransactionCardType
    transactionDate: Date
    transactionTime?: string
  },
): Promise<{
  estimatedSettlementDate: Date | null
  netAmount: number
  fees: number
  settlementDays: number | null
}> {
  logger.info('Simulating transaction', { venueId, params })

  // Get venue payment config to find merchant account
  const venueConfig = await prisma.venuePaymentConfig.findUnique({
    where: { venueId },
    select: {
      primaryAccountId: true,
    },
  })

  if (!venueConfig) {
    throw new NotFoundError('Venue payment configuration not found')
  }

  // Find settlement configuration
  const config = await findActiveSettlementConfig(venueConfig.primaryAccountId, params.cardType, params.transactionDate)

  if (!config) {
    logger.warn('No settlement configuration found for simulation', {
      venueId,
      cardType: params.cardType,
    })

    return {
      estimatedSettlementDate: null,
      netAmount: params.amount,
      fees: 0,
      settlementDays: null,
    }
  }

  // Calculate settlement date
  const estimatedSettlementDate = calculateSettlementDate(params.transactionDate, config)

  // Calculate settlement days
  const settlementDays = Math.ceil((estimatedSettlementDate.getTime() - params.transactionDate.getTime()) / (1000 * 60 * 60 * 24))

  // Estimate fees (simplified - real calculation would need pricing structure)
  // For simulation, we'll use approximate percentages
  const feeRates: Record<TransactionCardType, number> = {
    [TransactionCardType.DEBIT]: 0.03, // 3%
    [TransactionCardType.CREDIT]: 0.035, // 3.5%
    [TransactionCardType.AMEX]: 0.04, // 4%
    [TransactionCardType.INTERNATIONAL]: 0.045, // 4.5%
    [TransactionCardType.OTHER]: 0.03,
  }

  const feeRate = feeRates[params.cardType]
  const fees = params.amount * feeRate
  const netAmount = params.amount - fees

  // Save simulation record
  const simulation = await prisma.settlementSimulation.create({
    data: {
      venueId,
      userId,
      simulationType: SimulationType.MANUAL_TRANSACTION,
      simulatedAmount: params.amount,
      cardType: params.cardType,
      simulatedDate: params.transactionDate,
      simulatedTime: params.transactionTime,
      results: {
        estimatedSettlementDate,
        netAmount,
        fees,
        settlementDays,
        configUsed: config.id,
      },
    },
  })

  logger.info('Transaction simulation completed', { simulationId: simulation.id })

  return {
    estimatedSettlementDate,
    netAmount,
    fees,
    settlementDays,
  }
}

/**
 * Get settlement calendar - transactions grouped by settlement date
 *
 * This shows exactly how much money will be deposited each day.
 * Example: If Amex transaction on Nov 1 settles on Nov 3, and Visa transaction
 * on Nov 2 also settles on Nov 3, both amounts are grouped together for Nov 3.
 *
 * @param venueId - Venue ID
 * @param dateRange - Date range of settlement dates to query
 * @returns Calendar entries grouped by settlement date
 */
export async function getSettlementCalendar(
  venueId: string,
  dateRange: { from: Date; to: Date },
): Promise<
  Array<{
    settlementDate: Date
    totalNetAmount: number
    transactionCount: number
    status: SettlementStatus
    byCardType: Array<{
      cardType: TransactionCardType
      netAmount: number
      transactionCount: number
    }>
  }>
> {
  logger.info('Fetching settlement calendar', { venueId, dateRange })

  // Get all payments with transactions that have settlement dates in range
  const payments = await prisma.payment.findMany({
    where: {
      venueId,
      status: 'COMPLETED',
      transaction: {
        estimatedSettlementDate: {
          gte: dateRange.from,
          lte: dateRange.to,
        },
      },
    },
    include: {
      transaction: true,
      transactionCost: {
        select: {
          transactionType: true,
        },
      },
    },
    orderBy: {
      transaction: {
        estimatedSettlementDate: 'asc',
      },
    },
  })

  // Group by settlement date
  const calendarMap = new Map<
    string,
    {
      settlementDate: Date
      totalNetAmount: number
      transactionCount: number
      status: SettlementStatus
      byCardType: Map<
        TransactionCardType,
        {
          netAmount: number
          transactionCount: number
        }
      >
    }
  >()

  for (const payment of payments) {
    if (!payment.transaction?.estimatedSettlementDate) continue

    const settlementDate = payment.transaction.estimatedSettlementDate
    const dateKey = settlementDate.toISOString().split('T')[0]
    const netAmount = Number(payment.transaction.netSettlementAmount || 0)
    const cardType = payment.transactionCost?.transactionType || TransactionCardType.OTHER

    if (!calendarMap.has(dateKey)) {
      calendarMap.set(dateKey, {
        settlementDate,
        totalNetAmount: 0,
        transactionCount: 0,
        status: payment.transaction.status,
        byCardType: new Map(),
      })
    }

    const entry = calendarMap.get(dateKey)!
    entry.totalNetAmount += netAmount
    entry.transactionCount += 1

    // Update by card type
    if (!entry.byCardType.has(cardType)) {
      entry.byCardType.set(cardType, {
        netAmount: 0,
        transactionCount: 0,
      })
    }

    const cardTypeEntry = entry.byCardType.get(cardType)!
    cardTypeEntry.netAmount += netAmount
    cardTypeEntry.transactionCount += 1

    // Update status: if any transaction is settled, mark day as settled
    if (payment.transaction.status === SettlementStatus.SETTLED) {
      entry.status = SettlementStatus.SETTLED
    }
  }

  // Convert map to array
  const calendar = Array.from(calendarMap.values()).map(entry => ({
    settlementDate: entry.settlementDate,
    totalNetAmount: entry.totalNetAmount,
    transactionCount: entry.transactionCount,
    status: entry.status,
    byCardType: Array.from(entry.byCardType.entries()).map(([cardType, data]) => ({
      cardType,
      netAmount: data.netAmount,
      transactionCount: data.transactionCount,
    })),
  }))

  logger.info('Settlement calendar calculated', { venueId, entryCount: calendar.length })

  return calendar
}

/**
 * Project future balance based on historical patterns
 *
 * @param venueId - Venue ID
 * @param projectionDays - Number of days to project forward
 * @returns Projected daily balances
 */
export async function projectHistoricalBalance(
  venueId: string,
  projectionDays: number = 7,
): Promise<{
  projectedDailyRevenue: number
  projectedDailySettlements: { date: Date; amount: number }[]
}> {
  logger.info('Projecting future balance', { venueId, projectionDays })

  // Get last 30 days of completed payments to establish pattern
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  const historicalPayments = await prisma.payment.findMany({
    where: {
      venueId,
      status: 'COMPLETED',
      createdAt: {
        gte: thirtyDaysAgo,
      },
    },
    select: {
      amount: true,
      createdAt: true,
    },
  })

  // Calculate average daily revenue
  const totalRevenue = historicalPayments.reduce((sum, p) => sum + Number(p.amount), 0)
  const projectedDailyRevenue = historicalPayments.length > 0 ? totalRevenue / 30 : 0

  // Project future settlements (simplified - assumes average settlement time)
  const projectedDailySettlements: { date: Date; amount: number }[] = []
  const avgSettlementDays = 2 // Simplified assumption

  for (let i = 0; i < projectionDays; i++) {
    const settlementDate = addDays(new Date(), i)
    const transactionDate = addDays(settlementDate, -avgSettlementDays)

    // Check if we have historical data for this transaction date
    const historicalAmount = historicalPayments
      .filter(p => {
        const pDate = p.createdAt.toISOString().split('T')[0]
        const tDate = transactionDate.toISOString().split('T')[0]
        return pDate === tDate
      })
      .reduce((sum, p) => sum + Number(p.amount), 0)

    if (historicalAmount > 0) {
      projectedDailySettlements.push({
        date: settlementDate,
        amount: historicalAmount * 0.965, // Assume 3.5% fees
      })
    }
  }

  logger.info('Balance projection completed', {
    venueId,
    projectedDailyRevenue,
    settlementCount: projectedDailySettlements.length,
  })

  return {
    projectedDailyRevenue,
    projectedDailySettlements,
  }
}
