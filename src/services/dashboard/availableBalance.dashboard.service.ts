import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { TransactionCardType, SettlementStatus, SimulationType, PaymentMethod } from '@prisma/client'
import { NotFoundError } from '../../errors/AppError'
import { getEffectivePaymentConfig } from '@/services/organization-payment-config.service'
import { calculateSettlementDate, findActiveSettlementConfig } from '../payments/settlementCalculation.service'
import { addDays } from 'date-fns'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { projectPaymentSettlement, type ActiveConfig } from './settlementCalendar.dashboard.service'
import { DEFAULT_TIMEZONE } from '../../utils/datetime'
import { getLastCloseoutDate } from './cashCloseout.dashboard.service'

// Extended card type that includes CASH (for frontend compatibility)
// CASH is not in Prisma enum but we treat it as a synthetic type
export type ExtendedCardType = TransactionCardType | 'CASH'

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
  // Card money we counted but could NOT cost (no TransactionCost — e.g. a merchant
  // account with no VenuePricingStructure). Surfaced so the UI can explain why the
  // per-card-type breakdown (which excludes these) doesn't sum to the summary:
  //   Σ byCardType.netAmount + uncostedAmount ≈ availableNow + pendingSettlement.
  uncostedCount: number
  uncostedAmount: number
}

export interface CardTypeBreakdown {
  cardType: ExtendedCardType
  baseSales: number // Venta (monto sin propina)
  tips: number // Propina
  totalSales: number // monto + propina (lo que el cliente cargó a la tarjeta)
  fees: number
  netAmount: number // totalSales - fees
  settlementDays: number | null // Typical settlement days (0 for cash - instant)
  pendingAmount: number
  settledAmount: number
  transactionCount: number
}

export interface TimelineEntry {
  date: Date
  cardType: ExtendedCardType
  transactionCount: number
  grossAmount: number
  fees: number
  netAmount: number
  status: SettlementStatus
  estimatedSettlementDate: Date | null
}

/**
 * A card payment's money is "available" (settled) once its estimated settlement
 * date has passed — the funds land on that date — OR it was explicitly confirmed
 * SETTLED. This is AUTOMATIC and date-driven: it does NOT require the manual
 * "confirmar liquidación" step, which venues don't use. Without this, money that
 * already landed would show as perpetually "pending" until someone clicked a
 * button nobody clicks.
 */
function hasSettlementLanded(status: SettlementStatus, estimatedSettlementDate: Date | null, now: Date): boolean {
  if (status === SettlementStatus.SETTLED) return true
  return estimatedSettlementDate != null && estimatedSettlementDate.getTime() <= now.getTime()
}

/**
 * Get available balance summary for a venue
 *
 * @param venueId - Venue ID
 * @param dateRange - Optional date range filter
 * @returns Available balance summary (includes CASH as immediately available)
 */
export async function getAvailableBalance(venueId: string, dateRange?: { from: Date; to: Date }): Promise<AvailableBalanceSummary> {
  logger.info('Fetching available balance summary', { venueId, dateRange })

  // Build base where clause for date range
  const dateFilter: any = {}
  if (dateRange) {
    dateFilter.createdAt = {
      gte: dateRange.from,
      lte: dateRange.to,
    }
  }

  // Get all completed card payments with settlement info
  const cardPayments = await prisma.payment.findMany({
    where: {
      venueId,
      status: 'COMPLETED',
      method: {
        not: PaymentMethod.CASH, // Exclude cash, handle separately
      },
      ...dateFilter,
    },
    include: {
      transaction: true,
      transactionCost: {
        select: {
          venueChargeAmount: true,
          venueFixedFee: true,
        },
      },
    },
  })

  // Get CASH payments separately (instant settlement, 0 fees)
  // Only show cash collected SINCE the last closeout (corte de caja)
  // Both REGULAR and REFUND payments carry status=COMPLETED; refunds have
  // negative amount AND (since 2026-04-19) negative tipAmount so summing
  // signed values across both fields yields the correct net cash balance.
  const lastCloseout = await getLastCloseoutDate(venueId)
  const cashPayments = await prisma.payment.findMany({
    where: {
      venueId,
      status: 'COMPLETED',
      method: PaymentMethod.CASH,
      createdAt: { gt: lastCloseout }, // Only cash since last closeout
      ...dateFilter,
    },
    select: {
      amount: true,
      tipAmount: true,
    },
  })

  // Calculate totals
  const now = new Date()
  let totalSales = 0
  let totalFees = 0
  let availableNow = 0
  let pendingSettlement = 0
  // Card money we could NOT cost (no TransactionCost — e.g. a merchant account
  // without a VenuePricingStructure). Counted into the balance at fee 0, but
  // surfaced so the UI can explain the gap vs the per-card-type breakdown.
  let uncostedCount = 0
  let uncostedAmount = 0
  const upcomingSettlements: { date: Date; amount: number }[] = []

  // Process card payments
  for (const payment of cardPayments) {
    // Include the tip: customer charged amount + tip; commission is on amount+tip.
    const amount = Number(payment.amount) + Number(payment.tipAmount ?? 0)
    // Venue fee = percentage charge + per-transaction fixed fee. Dropping the
    // fixed fee overstated the net the venue receives (it is netted out by the
    // settlement engine, so the stored netSettlementAmount already includes it).
    const fees = payment.transactionCost
      ? Number(payment.transactionCost.venueChargeAmount) + Number(payment.transactionCost.venueFixedFee)
      : 0
    const netAmount = amount - fees

    if (!payment.transactionCost) {
      uncostedCount += 1
      uncostedAmount += amount
    }

    totalSales += amount
    totalFees += fees

    if (payment.transaction) {
      const { status, estimatedSettlementDate, netSettlementAmount } = payment.transaction
      const net = Number(netSettlementAmount || netAmount)

      if (hasSettlementLanded(status, estimatedSettlementDate, now)) {
        // Landed automatically (settlement date passed) or explicitly confirmed.
        availableNow += net
      } else {
        // Still pending — its settlement date is in the future.
        pendingSettlement += net
        if (estimatedSettlementDate) {
          upcomingSettlements.push({ date: estimatedSettlementDate, amount: net })
        }
      }
    } else {
      // No transaction record → no settlement date to project → treat as pending.
      pendingSettlement += netAmount
    }
  }

  // Add CASH payments (instant settlement, 0 fees, 100% available)
  const cashTotal = cashPayments.reduce((sum, p) => sum + Number(p.amount) + Number(p.tipAmount ?? 0), 0)
  totalSales += cashTotal
  // Cash has 0 fees, so no totalFees increment
  availableNow += cashTotal // Cash is immediately available

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
    cashTotal,
    uncostedCount,
    uncostedAmount,
  })

  return {
    totalSales,
    totalFees,
    availableNow,
    pendingSettlement,
    estimatedNextSettlement,
    uncostedCount,
    uncostedAmount,
  }
}

/**
 * Get balance breakdown by card type
 *
 * @param venueId - Venue ID
 * @param dateRange - Optional date range filter
 * @returns Array of card type breakdowns (includes CASH as synthetic type)
 */
export async function getBalanceByCardType(venueId: string, dateRange?: { from: Date; to: Date }): Promise<CardTypeBreakdown[]> {
  logger.info('Fetching balance by card type', { venueId, dateRange })

  // Build base where clause for date range
  const dateFilter: any = {}
  if (dateRange) {
    dateFilter.createdAt = {
      gte: dateRange.from,
      lte: dateRange.to,
    }
  }

  // Get card payments with transaction costs
  const cardPayments = await prisma.payment.findMany({
    where: {
      venueId,
      status: 'COMPLETED',
      transactionCost: {
        isNot: null, // Must have transaction cost
      },
      ...dateFilter,
    },
    include: {
      transaction: true,
      transactionCost: {
        select: {
          transactionType: true,
          venueChargeAmount: true,
          venueFixedFee: true,
          merchantAccountId: true,
        },
      },
    },
  })

  // Get CASH payments separately (no transaction cost)
  // Only show cash collected SINCE the last closeout (corte de caja)
  // Include tipAmount so tip-split refunds (2026-04-19) net out correctly.
  const lastCloseoutForCash = await getLastCloseoutDate(venueId)
  const cashPayments = await prisma.payment.findMany({
    where: {
      venueId,
      status: 'COMPLETED',
      method: PaymentMethod.CASH,
      createdAt: { gt: lastCloseoutForCash }, // Only cash since last closeout
      ...dateFilter,
    },
    select: {
      id: true,
      amount: true,
      tipAmount: true,
      createdAt: true,
    },
  })

  // Look up active SettlementConfiguration per (merchantAccountId, cardType)
  // so the UI can show the configured rule (e.g. "1 día háb.") instead of
  // averaging calendar-day deltas across historical payments — which was
  // misleading (mixed timezone shifts, weekend gaps, label said "días háb."
  // but the math was on calendar days).
  const merchantAccountIds = Array.from(new Set(cardPayments.map(p => p.transactionCost?.merchantAccountId).filter(Boolean) as string[]))
  const activeConfigs = merchantAccountIds.length
    ? await prisma.settlementConfiguration.findMany({
        where: {
          merchantAccountId: { in: merchantAccountIds },
          effectiveTo: null,
        },
        select: { merchantAccountId: true, cardType: true, settlementDays: true },
      })
    : []
  const configuredDays = new Map<string, number>() // key: `${merchantAccountId}::${cardType}`
  for (const cfg of activeConfigs) {
    configuredDays.set(`${cfg.merchantAccountId}::${cfg.cardType}`, cfg.settlementDays)
  }

  // Group card payments by card type
  const byCardType = new Map<
    ExtendedCardType,
    {
      baseSales: number // monto sin propina
      tips: number // propina
      totalSales: number // monto + propina
      fees: number
      pendingAmount: number
      settledAmount: number
      transactionCount: number
      settlementDays: number | null // configured business days from SettlementConfiguration
    }
  >()

  const now = new Date()
  for (const payment of cardPayments) {
    if (!payment.transactionCost) continue

    const cardType = payment.transactionCost.transactionType
    // The customer charged amount + tip on the card; the commission was charged
    // on amount+tip too. Dropping the tip understated the net the venue receives.
    const baseAmount = Number(payment.amount)
    const tip = Number(payment.tipAmount ?? 0)
    const amount = baseAmount + tip
    // Venue fee = percentage charge + per-transaction fixed fee (matches the
    // settlement engine's net and the Sales Summary breakdown).
    const fees = Number(payment.transactionCost.venueChargeAmount) + Number(payment.transactionCost.venueFixedFee)
    const netAmount = amount - fees

    // Get or initialize card type entry
    if (!byCardType.has(cardType)) {
      byCardType.set(cardType, {
        baseSales: 0,
        tips: 0,
        totalSales: 0,
        fees: 0,
        pendingAmount: 0,
        settledAmount: 0,
        transactionCount: 0,
        settlementDays: configuredDays.get(`${payment.transactionCost.merchantAccountId}::${cardType}`) ?? null,
      })
    }

    const entry = byCardType.get(cardType)!
    entry.baseSales += baseAmount
    entry.tips += tip
    entry.totalSales += amount
    entry.fees += fees
    entry.transactionCount += 1

    // Settlement status — automatic by date (see hasSettlementLanded); does not
    // depend on the manual "confirmar liquidación" step.
    if (payment.transaction) {
      const net = Number(payment.transaction.netSettlementAmount || netAmount)
      if (hasSettlementLanded(payment.transaction.status, payment.transaction.estimatedSettlementDate, now)) {
        entry.settledAmount += net
      } else {
        entry.pendingAmount += net
      }
      // settlementDays now comes from the active SettlementConfiguration
      // (set when the entry was created above), not from a calendar-day average
      // of historical estimatedSettlementDate values.
    } else {
      entry.pendingAmount += netAmount
    }
  }

  // Add CASH payments as synthetic card type (instant settlement, 0 fees)
  if (cashPayments.length > 0) {
    const cashBase = cashPayments.reduce((sum, p) => sum + Number(p.amount), 0)
    const cashTips = cashPayments.reduce((sum, p) => sum + Number(p.tipAmount ?? 0), 0)
    const cashTotalSales = cashBase + cashTips
    byCardType.set('CASH', {
      baseSales: cashBase,
      tips: cashTips,
      totalSales: cashTotalSales,
      fees: 0, // Cash has no processing fees
      pendingAmount: 0, // Cash is never pending
      settledAmount: cashTotalSales, // Cash is always immediately settled
      transactionCount: cashPayments.length,
      settlementDays: 0, // Instant settlement
    })
  }

  // Convert map to array
  const breakdown: CardTypeBreakdown[] = []
  for (const [cardType, data] of byCardType) {
    breakdown.push({
      cardType,
      baseSales: data.baseSales,
      tips: data.tips,
      totalSales: data.totalSales,
      fees: data.fees,
      netAmount: data.totalSales - data.fees,
      settlementDays: data.settlementDays,
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

  const venueRecord = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { timezone: true },
  })
  const venueTimezone = venueRecord?.timezone || DEFAULT_TIMEZONE

  // Get payments within date range. We pull `transactionCost.transactionType`
  // so we can split a transaction-day into per-card-type rows: payments on the
  // same day with different card types settle on different dates, and showing
  // a single Fecha de Liquidación per day misled users.
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
          venueFixedFee: true,
          transactionType: true,
        },
      },
    },
    orderBy: {
      createdAt: 'asc',
    },
  })

  // Settlement dates are RECOMPUTED on read via the corrected engine (same shared
  // helper as the week strip / settlement calendar), NOT taken from the stored
  // per-payment estimatedSettlementDate: payments created before the 2026-07-04
  // engine fix carry stale stored dates (e.g. weekend landings) and would
  // contradict the week strip rendered on the same page. The stored date remains
  // only as a fallback when a payment can't be projected (no cost / no rule).
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

  // Group by (transaction date, card type)
  const timelineMap = new Map<string, TimelineEntry>()
  const recomputedGroups = new Set<string>() // groups whose date came from the live engine (wins over stored)

  for (const payment of payments) {
    const dateKey = formatInTimeZone(payment.createdAt, venueTimezone, 'yyyy-MM-dd')
    const cardType: ExtendedCardType =
      payment.method === PaymentMethod.CASH ? 'CASH' : (payment.transactionCost?.transactionType ?? TransactionCardType.OTHER)
    const groupKey = `${dateKey}::${cardType}`
    // Include the tip: customer charged amount + tip; commission is on amount+tip.
    const amount = Number(payment.amount) + Number(payment.tipAmount ?? 0)
    // Venue fee = percentage charge + per-transaction fixed fee.
    const fees = payment.transactionCost
      ? Number(payment.transactionCost.venueChargeAmount) + Number(payment.transactionCost.venueFixedFee)
      : 0
    const netAmount = amount - fees

    if (!timelineMap.has(groupKey)) {
      timelineMap.set(groupKey, {
        date: new Date(`${dateKey}T00:00:00.000Z`),
        cardType,
        transactionCount: 0,
        grossAmount: 0,
        fees: 0,
        netAmount: 0,
        status: SettlementStatus.PENDING,
        estimatedSettlementDate: null,
      })
    }

    const entry = timelineMap.get(groupKey)!
    entry.transactionCount += 1
    entry.grossAmount += amount
    entry.fees += fees
    entry.netAmount += netAmount

    // Prefer the live-engine date; fall back to the first stored date otherwise.
    const projected =
      payment.method !== PaymentMethod.CASH && payment.merchantAccountId && payment.transactionCost
        ? projectPaymentSettlement(
            {
              amount: payment.amount,
              tipAmount: payment.tipAmount,
              createdAt: payment.createdAt,
              merchantAccountId: payment.merchantAccountId,
              transactionCost: payment.transactionCost,
            },
            configs,
            venueTimezone,
          )
        : null
    if (projected && !recomputedGroups.has(groupKey)) {
      // Noon venue-local: formats back to the same calendar day in any client tz handling.
      entry.estimatedSettlementDate = fromZonedTime(`${projected.settlementDateKey}T12:00:00.000`, venueTimezone)
      recomputedGroups.add(groupKey)
    } else if (!recomputedGroups.has(groupKey) && payment.transaction?.estimatedSettlementDate && !entry.estimatedSettlementDate) {
      entry.estimatedSettlementDate = payment.transaction.estimatedSettlementDate
    }

    // If any transaction in the group is settled, mark group as settled
    if (payment.transaction?.status === SettlementStatus.SETTLED) {
      entry.status = SettlementStatus.SETTLED
    }
  }

  const timeline = Array.from(timelineMap.values()).sort((a, b) => {
    const t = a.date.getTime() - b.date.getTime()
    return t !== 0 ? t : a.cardType.localeCompare(b.cardType)
  })

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
  grossAmount: number
  estimatedSettlementDate: Date | null
  netAmount: number
  fees: number
  settlementDays: number | null
  configuration: {
    settlementDays: number
    settlementDayType: string
    cutoffTime: string
  } | null
}> {
  logger.info('Simulating transaction', { venueId, params })

  // Get venue payment config to find merchant account (with org-level fallback)
  const effectiveResult = await getEffectivePaymentConfig(venueId)

  if (!effectiveResult) {
    throw new NotFoundError('Venue payment configuration not found')
  }

  const primaryAccountId = effectiveResult.config.primaryAccountId

  // Find settlement configuration
  const config = await findActiveSettlementConfig(primaryAccountId, params.cardType, params.transactionDate)

  if (!config) {
    logger.warn('No settlement configuration found for simulation', {
      venueId,
      cardType: params.cardType,
    })

    return {
      grossAmount: params.amount,
      estimatedSettlementDate: null,
      netAmount: params.amount,
      fees: 0,
      settlementDays: null,
      configuration: null,
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
    grossAmount: params.amount,
    estimatedSettlementDate,
    netAmount,
    fees,
    settlementDays,
    configuration: {
      settlementDays: config.settlementDays,
      settlementDayType: config.settlementDayType,
      cutoffTime: config.cutoffTime,
    },
  }
}

/**
 * Get settlement calendar - transactions grouped by settlement date
 *
 * This shows exactly how much money will be deposited each day.
 * Example: If Amex transaction on Nov 1 settles on Nov 3, and Visa transaction
 * on Nov 2 also settles on Nov 3, both amounts are grouped together for Nov 3.
 *
 * CASH payments are shown on their transaction date as instantly settled.
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
      cardType: ExtendedCardType
      netAmount: number
      transactionCount: number
    }>
  }>
> {
  logger.info('Fetching settlement calendar', { venueId, dateRange })

  // Resolve venue timezone so we group by the user's local date, not UTC.
  // Without this, settlements crossing midnight UTC end up in different UTC
  // groups but render under the same local date in the frontend.
  const venueRecord = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { timezone: true },
  })
  const venueTimezone = venueRecord?.timezone || DEFAULT_TIMEZONE

  // Get card payments with transactions that have settlement dates in range
  const cardPayments = await prisma.payment.findMany({
    where: {
      venueId,
      status: 'COMPLETED',
      method: {
        not: PaymentMethod.CASH,
      },
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

  // Get CASH payments in date range (instant settlement on transaction date)
  // Only show cash collected SINCE the last closeout (corte de caja)
  // Include tipAmount so tip-split refunds (2026-04-19) net out correctly.
  const lastCloseoutForCalendar = await getLastCloseoutDate(venueId)
  const cashPayments = await prisma.payment.findMany({
    where: {
      venueId,
      status: 'COMPLETED',
      method: PaymentMethod.CASH,
      createdAt: {
        gt: lastCloseoutForCalendar, // Only cash since last closeout
        gte: dateRange.from,
        lte: dateRange.to,
      },
    },
    select: {
      amount: true,
      tipAmount: true,
      createdAt: true,
    },
    orderBy: {
      createdAt: 'asc',
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
        ExtendedCardType,
        {
          netAmount: number
          transactionCount: number
        }
      >
    }
  >()

  // Process card payments
  for (const payment of cardPayments) {
    if (!payment.transaction?.estimatedSettlementDate) continue

    const settlementDate = payment.transaction.estimatedSettlementDate
    // Group by venue-local date so the UI label matches the bucket. Using
    // toISOString() splits at UTC midnight, which can put two different
    // UTC days under the same local date in the frontend.
    const dateKey = formatInTimeZone(settlementDate, venueTimezone, 'yyyy-MM-dd')
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

  // Process CASH payments (instant settlement - show on transaction date)
  for (const payment of cashPayments) {
    const settlementDate = payment.createdAt
    const dateKey = formatInTimeZone(settlementDate, venueTimezone, 'yyyy-MM-dd')
    const netAmount = Number(payment.amount) + Number(payment.tipAmount ?? 0) // Cash has no fees; include tip portion

    if (!calendarMap.has(dateKey)) {
      calendarMap.set(dateKey, {
        settlementDate,
        totalNetAmount: 0,
        transactionCount: 0,
        status: SettlementStatus.SETTLED, // Cash is always settled
        byCardType: new Map(),
      })
    }

    const entry = calendarMap.get(dateKey)!
    entry.totalNetAmount += netAmount
    entry.transactionCount += 1

    // Add to CASH card type
    if (!entry.byCardType.has('CASH')) {
      entry.byCardType.set('CASH', {
        netAmount: 0,
        transactionCount: 0,
      })
    }

    const cashEntry = entry.byCardType.get('CASH')!
    cashEntry.netAmount += netAmount
    cashEntry.transactionCount += 1
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
