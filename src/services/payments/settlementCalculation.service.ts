import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { TransactionCardType, SettlementDayType, Payment } from '@prisma/client'
import { addDays } from 'date-fns'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'

/**
 * Settlement Calculation Service
 *
 * Handles calculation of settlement dates and amounts for payment transactions.
 * This service determines when funds will be available to venues based on:
 * - Card type (Debit, Credit, Amex, International)
 * - Settlement configuration (business days vs calendar days)
 * - Cutoff times
 * - Holidays (Mexico-specific)
 *
 * CRITICAL BUSINESS RULES:
 * 1. Settlement dates are calculated in venue timezone
 * 2. Transactions after cutoff time are counted as next business day
 * 3. Business days exclude weekends and Mexican national holidays
 * 4. Net settlement amount = gross - provider fees - Avoqado fees
 *
 * TIMEZONE HANDLING:
 * - Uses centralized datetime utilities from @/utils/datetime
 * - All dates stored in UTC, calculated in venue timezone
 * - Follows Stripe/AWS/Shopify best practices
 */

/**
 * Mexican national holidays (fixed and variable dates)
 * These dates are excluded from business day calculations
 *
 * Fixed holidays:
 * - Jan 1: New Year
 * - Feb 5: Constitution Day
 * - Mar 21: Benito Juárez's Birthday
 * - May 1: Labor Day
 * - Sep 16: Independence Day
 * - Nov 20: Revolution Day
 * - Dec 25: Christmas
 *
 * Variable holidays (by law, moved to Monday):
 * - First Monday of February (Feb 5)
 * - Third Monday of March (Mar 21)
 * - Third Monday of November (Nov 20)
 */
const MEXICAN_FIXED_HOLIDAYS = [
  { month: 1, day: 1 }, // New Year
  { month: 5, day: 1 }, // Labor Day
  { month: 9, day: 16 }, // Independence Day
  { month: 12, day: 25 }, // Christmas
]

/**
 * Check if a date is a Mexican national holiday
 *
 * @param date - Date to check
 * @returns True if the date is a holiday
 */
export function isMexicanHoliday(date: Date): boolean {
  const month = date.getMonth() + 1 // JS months are 0-indexed
  const day = date.getDate()
  const dayOfWeek = date.getDay() // 0 = Sunday, 1 = Monday, etc.

  // Check fixed holidays
  const isFixedHoliday = MEXICAN_FIXED_HOLIDAYS.some(holiday => holiday.month === month && holiday.day === day)
  if (isFixedHoliday) return true

  // Check variable holidays (moved to Monday)
  // First Monday of February (Constitution Day)
  if (month === 2 && dayOfWeek === 1 && day <= 7) return true

  // Third Monday of March (Benito Juárez)
  if (month === 3 && dayOfWeek === 1 && day >= 15 && day <= 21) return true

  // Third Monday of November (Revolution Day)
  if (month === 11 && dayOfWeek === 1 && day >= 15 && day <= 21) return true

  return false
}

/**
 * Check if a date is a weekend (Saturday or Sunday)
 *
 * @param date - Date to check
 * @returns True if weekend
 */
export function isWeekend(date: Date): boolean {
  const dayOfWeek = date.getDay()
  return dayOfWeek === 0 || dayOfWeek === 6 // Sunday or Saturday
}

/**
 * Check if a date is a business day (not weekend, not holiday)
 *
 * @param date - Date to check
 * @returns True if business day
 */
export function isBusinessDay(date: Date): boolean {
  return !isWeekend(date) && !isMexicanHoliday(date)
}

/**
 * Add business days to a date, skipping weekends and holidays
 *
 * @param startDate - Starting date
 * @param businessDays - Number of business days to add
 * @returns New date after adding business days
 */
export function addBusinessDays(startDate: Date, businessDays: number): Date {
  const currentDate = new Date(startDate)
  let daysAdded = 0

  while (daysAdded < businessDays) {
    currentDate.setDate(currentDate.getDate() + 1)

    if (isBusinessDay(currentDate)) {
      daysAdded++
    }
  }

  return currentDate
}

/**
 * Parse time string (HH:MM) and combine with date in venue timezone
 *
 * @param dateStr - Date string in YYYY-MM-DD format
 * @param timeStr - Time string in HH:MM format
 * @param timezone - IANA timezone (e.g., "America/Mexico_City")
 * @returns Date object in UTC
 */
export function parseDateTime(dateStr: string, timeStr: string, timezone: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number)
  const [hours, minutes] = timeStr.split(':').map(Number)

  // Create date in venue timezone, then convert to UTC
  const venueDate = new Date(year, month - 1, day, hours, minutes)
  return fromZonedTime(venueDate, timezone)
}

/**
 * Check if transaction occurred after cutoff time
 *
 * @param transactionDate - When the transaction occurred (UTC)
 * @param cutoffTime - Cutoff time in HH:MM format
 * @param timezone - Venue timezone
 * @returns True if transaction is after cutoff
 */
export function isAfterCutoff(transactionDate: Date, cutoffTime: string, timezone: string): boolean {
  const [cutoffHours, cutoffMinutes] = cutoffTime.split(':').map(Number)

  // Convert transaction date to venue timezone
  const transactionInVenue = toZonedTime(transactionDate, timezone)
  const transactionHours = transactionInVenue.getHours()
  const transactionMinutes = transactionInVenue.getMinutes()

  const transactionTimeInMinutes = transactionHours * 60 + transactionMinutes
  const cutoffTimeInMinutes = cutoffHours * 60 + cutoffMinutes

  return transactionTimeInMinutes > cutoffTimeInMinutes
}

/**
 * Find active settlement configuration for a merchant account and card type
 *
 * @param merchantAccountId - Merchant account ID
 * @param cardType - Transaction card type
 * @param effectiveDate - Date to check (defaults to now)
 * @returns Active SettlementConfiguration or null
 */
export async function findActiveSettlementConfig(
  merchantAccountId: string,
  cardType: TransactionCardType,
  effectiveDate: Date = new Date(),
) {
  const config = await prisma.settlementConfiguration.findFirst({
    where: {
      merchantAccountId,
      cardType,
      effectiveFrom: { lte: effectiveDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveDate } }],
    },
    orderBy: {
      effectiveFrom: 'desc', // Get most recent if multiple match
    },
  })

  if (!config) {
    logger.warn('No active settlement configuration found', {
      merchantAccountId,
      cardType,
      effectiveDate,
    })
  }

  return config
}

/**
 * Calculate settlement date for a payment
 *
 * @param transactionDate - When the payment occurred
 * @param config - Settlement configuration
 * @returns Estimated settlement date
 */
export function calculateSettlementDate(
  transactionDate: Date,
  config: {
    settlementDays: number
    settlementDayType: SettlementDayType
    cutoffTime: string
    cutoffTimezone: string
  },
): Date {
  let startDate = new Date(transactionDate)

  // Check if transaction is after cutoff time
  if (isAfterCutoff(transactionDate, config.cutoffTime, config.cutoffTimezone)) {
    // Count as next day
    startDate = addDays(startDate, 1)
    logger.debug('Transaction after cutoff, starting settlement from next day', {
      transactionDate,
      cutoffTime: config.cutoffTime,
      newStartDate: startDate,
    })
  }

  // Calculate settlement date based on day type
  let settlementDate: Date

  if (config.settlementDayType === SettlementDayType.BUSINESS_DAYS) {
    settlementDate = addBusinessDays(startDate, config.settlementDays)
  } else {
    // CALENDAR_DAYS
    settlementDate = addDays(startDate, config.settlementDays)
  }

  logger.info('Settlement date calculated', {
    transactionDate,
    settlementDays: config.settlementDays,
    settlementDayType: config.settlementDayType,
    settlementDate,
  })

  return settlementDate
}

/**
 * Calculate net settlement amount after all fees
 *
 * @param payment - Payment record
 * @param transactionCost - Transaction cost record (optional, will be fetched if not provided)
 * @returns Net settlement amount
 */
export async function calculateNetSettlementAmount(
  payment: Payment,
  transactionCost?: { providerCostAmount: number; venueChargeAmount: number; venueFixedFee: number },
): Promise<number> {
  // If transaction cost not provided, fetch it
  if (!transactionCost) {
    const cost = await prisma.transactionCost.findUnique({
      where: { paymentId: payment.id },
      select: {
        providerCostAmount: true,
        venueChargeAmount: true,
        venueFixedFee: true,
      },
    })

    if (cost) {
      transactionCost = {
        providerCostAmount: Number(cost.providerCostAmount),
        venueChargeAmount: Number(cost.venueChargeAmount),
        venueFixedFee: Number(cost.venueFixedFee),
      }
    }
  }

  const grossAmount = Number(payment.amount)

  if (!transactionCost) {
    // No transaction cost found, return gross amount
    logger.warn('No transaction cost found, using gross amount', { paymentId: payment.id })
    return grossAmount
  }

  // Net = Gross - Total Venue Charge (percentage + fixed fee)
  // Note: Provider cost is Avoqado's expense, venue charge is what venue pays
  const totalVenueCharge = transactionCost.venueChargeAmount + transactionCost.venueFixedFee
  const netAmount = grossAmount - totalVenueCharge

  logger.debug('Net settlement amount calculated', {
    paymentId: payment.id,
    grossAmount,
    venueChargeAmount: transactionCost.venueChargeAmount,
    venueFixedFee: transactionCost.venueFixedFee,
    totalVenueCharge,
    netAmount,
  })

  return netAmount
}

/**
 * Calculate estimated settlement for a payment
 *
 * This is the main function that orchestrates all settlement calculations.
 *
 * @param payment - Payment record
 * @param merchantAccountId - Merchant account ID used for transaction
 * @param cardType - Transaction card type
 * @returns Settlement information or null if no config found
 */
export async function calculatePaymentSettlement(
  payment: Payment,
  merchantAccountId: string,
  cardType: TransactionCardType,
): Promise<{
  estimatedSettlementDate: Date
  netSettlementAmount: number
  settlementConfigId: string
} | null> {
  // Find active settlement configuration
  const config = await findActiveSettlementConfig(merchantAccountId, cardType, payment.createdAt)

  if (!config) {
    logger.warn('Cannot calculate settlement: no configuration found', {
      paymentId: payment.id,
      merchantAccountId,
      cardType,
    })
    return null
  }

  // Calculate settlement date
  const estimatedSettlementDate = calculateSettlementDate(payment.createdAt, config)

  // Calculate net amount
  const netSettlementAmount = await calculateNetSettlementAmount(payment)

  return {
    estimatedSettlementDate,
    netSettlementAmount,
    settlementConfigId: config.id,
  }
}

/**
 * Batch update settlement information for multiple payments
 *
 * @param venueId - Venue ID to process payments for
 * @param limit - Maximum number of payments to process (default: 100)
 * @returns Number of payments updated
 */
export async function batchUpdateSettlementInfo(venueId: string, limit: number = 100): Promise<number> {
  logger.info('Starting batch settlement update', { venueId, limit })

  // Find payments without settlement information
  const payments = await prisma.payment.findMany({
    where: {
      venueId,
      status: 'COMPLETED',
      transaction: {
        estimatedSettlementDate: null, // No settlement date calculated yet
      },
    },
    include: {
      transaction: true,
      transactionCost: {
        select: {
          merchantAccountId: true,
          transactionType: true,
          providerCostAmount: true,
          venueChargeAmount: true,
        },
      },
    },
    take: limit,
  })

  let updateCount = 0

  for (const payment of payments) {
    if (!payment.transactionCost) {
      logger.debug('Skipping payment without transaction cost', { paymentId: payment.id })
      continue
    }

    try {
      const settlementInfo = await calculatePaymentSettlement(
        payment,
        payment.transactionCost.merchantAccountId,
        payment.transactionCost.transactionType,
      )

      if (settlementInfo && payment.transaction) {
        // Update VenueTransaction with settlement info
        await prisma.venueTransaction.update({
          where: { id: payment.transaction.id },
          data: {
            estimatedSettlementDate: settlementInfo.estimatedSettlementDate,
            netSettlementAmount: settlementInfo.netSettlementAmount,
            settlementConfigId: settlementInfo.settlementConfigId,
          },
        })

        updateCount++
        logger.debug('Updated settlement info', { paymentId: payment.id, transactionId: payment.transaction.id })
      }
    } catch (error) {
      logger.error('Error calculating settlement for payment', { paymentId: payment.id, error })
    }
  }

  logger.info('Batch settlement update completed', { venueId, updateCount, totalProcessed: payments.length })

  return updateCount
}
