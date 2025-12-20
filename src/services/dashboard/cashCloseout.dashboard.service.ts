import prisma from '../../utils/prismaClient'
import { PaymentMethod, DepositMethod } from '@prisma/client'
import logger from '../../config/logger'

/**
 * Cash Closeout Service (Cortes de Caja)
 *
 * Handles cash register closeouts for venues. This service enables businesses
 * to track expected vs actual cash amounts when they deposit or store cash.
 *
 * Industry standard for: restaurants, retail, hotels
 */

/**
 * Get the date of the last closeout (or venue creation if none)
 */
export async function getLastCloseoutDate(venueId: string): Promise<Date> {
  const lastCloseout = await prisma.cashCloseout.findFirst({
    where: { venueId },
    orderBy: { createdAt: 'desc' },
    select: { periodEnd: true },
  })

  if (lastCloseout) {
    return lastCloseout.periodEnd
  }

  // No closeouts yet - use venue creation date
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { createdAt: true },
  })

  return venue?.createdAt || new Date()
}

/**
 * Calculate expected cash amount since last closeout
 */
export async function getExpectedCashAmount(venueId: string): Promise<{
  expectedAmount: number
  periodStart: Date
  transactionCount: number
  daysSinceLastCloseout: number
  hasCloseouts: boolean
}> {
  // Check if there are any closeouts first
  const lastCloseout = await prisma.cashCloseout.findFirst({
    where: { venueId },
    orderBy: { createdAt: 'desc' },
    select: { periodEnd: true },
  })

  const hasCloseouts = !!lastCloseout
  const periodStart =
    lastCloseout?.periodEnd ||
    (
      await prisma.venue.findUnique({
        where: { id: venueId },
        select: { createdAt: true },
      })
    )?.createdAt ||
    new Date()

  const cashPayments = await prisma.payment.findMany({
    where: {
      venueId,
      method: PaymentMethod.CASH,
      status: 'COMPLETED',
      createdAt: { gt: periodStart },
    },
    select: { amount: true },
  })

  const expectedAmount = cashPayments.reduce((sum, p) => sum + Number(p.amount), 0)
  const daysSinceLastCloseout = Math.floor((Date.now() - periodStart.getTime()) / (1000 * 60 * 60 * 24))

  return {
    expectedAmount,
    periodStart,
    transactionCount: cashPayments.length,
    daysSinceLastCloseout,
    hasCloseouts,
  }
}

/**
 * Create a cash closeout record
 */
export async function createCashCloseout(
  venueId: string,
  data: {
    actualAmount: number
    depositMethod: DepositMethod
    bankReference?: string
    notes?: string
  },
  closedById: string,
) {
  const { expectedAmount, periodStart } = await getExpectedCashAmount(venueId)

  const variance = data.actualAmount - expectedAmount
  // Calculate variance percent, but clamp to Decimal(5,2) range (-999.99 to 999.99)
  // If expectedAmount is 0 or very small, use null instead of calculating meaningless percentage
  let variancePercent: number | null = null
  if (expectedAmount > 0) {
    const rawPercent = (variance / expectedAmount) * 100
    // Clamp to valid range for Decimal(5, 2)
    variancePercent = Math.max(-999.99, Math.min(999.99, rawPercent))
  }

  logger.info(`Creating cash closeout for venue ${venueId}`, {
    expectedAmount,
    actualAmount: data.actualAmount,
    variance,
    variancePercent,
  })

  return prisma.cashCloseout.create({
    data: {
      venueId,
      periodStart,
      periodEnd: new Date(),
      expectedAmount,
      actualAmount: data.actualAmount,
      variance,
      variancePercent,
      depositMethod: data.depositMethod,
      bankReference: data.bankReference,
      notes: data.notes,
      closedById,
    },
    include: {
      closedBy: {
        select: { id: true, firstName: true, lastName: true },
      },
    },
  })
}

/**
 * Get closeout history with pagination
 */
export async function getCloseoutHistory(venueId: string, page: number = 1, pageSize: number = 10) {
  const [closeouts, total] = await prisma.$transaction([
    prisma.cashCloseout.findMany({
      where: { venueId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        closedBy: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    }),
    prisma.cashCloseout.count({ where: { venueId } }),
  ])

  return {
    data: closeouts,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  }
}

/**
 * Get a single closeout by ID
 */
export async function getCloseoutById(venueId: string, closeoutId: string) {
  return prisma.cashCloseout.findFirst({
    where: {
      id: closeoutId,
      venueId,
    },
    include: {
      closedBy: {
        select: { id: true, firstName: true, lastName: true },
      },
    },
  })
}
