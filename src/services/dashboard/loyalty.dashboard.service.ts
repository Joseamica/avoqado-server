/**
 * Loyalty Program Service (HTTP-Agnostic Business Logic)
 *
 * WHY: Reward customers with points for purchases, increase retention, drive repeat business.
 *
 * DESIGN DECISION: Points-based loyalty system with configurable earn/redeem rates per venue.
 * - Customers earn points on every purchase (e.g., 1 point per $1 spent)
 * - Points can be redeemed for discounts (e.g., 100 points = $1 discount)
 * - Points can expire after configurable period (e.g., 1 year)
 * - Staff can manually adjust points (corrections, bonuses, penalties)
 *
 * PATTERN: Thin Controller + Fat Service Architecture
 * - This service contains ALL business logic
 * - Controllers only orchestrate HTTP (extract params, call service, return response)
 * - Services know NOTHING about Express (req, res, next)
 *
 * CRITICAL: All loyalty operations are scoped to venueId for multi-tenant isolation.
 */

import { BadRequestError, NotFoundError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { LoyaltyTransactionType } from '@prisma/client'

/**
 * Get or create loyalty configuration for a venue
 * Creates default config if none exists
 */
export async function getOrCreateLoyaltyConfig(venueId: string) {
  let config = await prisma.loyaltyConfig.findUnique({
    where: { venueId },
  })

  // Create default config if none exists
  if (!config) {
    config = await prisma.loyaltyConfig.create({
      data: {
        venueId,
        pointsPerDollar: 1, // 1 point per $1 spent
        pointsPerVisit: 0, // No bonus per visit
        redemptionRate: 0.01, // 100 points = $1 discount (1 point = $0.01)
        minPointsRedeem: 100, // Minimum 100 points to redeem
        pointsExpireDays: 365, // Points expire after 1 year
        active: true,
      },
    })
  }

  return {
    ...config,
    pointsPerDollar: config.pointsPerDollar.toNumber(),
    redemptionRate: config.redemptionRate.toNumber(),
  }
}

/**
 * Get loyalty configuration for a venue
 */
export async function getLoyaltyConfig(venueId: string) {
  return getOrCreateLoyaltyConfig(venueId)
}

/**
 * Update loyalty configuration for a venue
 */
export async function updateLoyaltyConfig(
  venueId: string,
  data: {
    pointsPerDollar?: number
    pointsPerVisit?: number
    redemptionRate?: number
    minPointsRedeem?: number
    pointsExpireDays?: number | null
    active?: boolean
  },
) {
  // Validate inputs
  if (data.pointsPerDollar !== undefined && data.pointsPerDollar < 0) {
    throw new BadRequestError('Points per dollar must be non-negative')
  }
  if (data.pointsPerVisit !== undefined && data.pointsPerVisit < 0) {
    throw new BadRequestError('Points per visit must be non-negative')
  }
  if (data.redemptionRate !== undefined && data.redemptionRate < 0) {
    throw new BadRequestError('Redemption rate must be non-negative')
  }
  if (data.minPointsRedeem !== undefined && data.minPointsRedeem < 0) {
    throw new BadRequestError('Minimum redemption points must be non-negative')
  }
  if (data.pointsExpireDays !== undefined && data.pointsExpireDays !== null && data.pointsExpireDays < 0) {
    throw new BadRequestError('Points expiration days must be non-negative or null')
  }

  // Ensure config exists
  await getOrCreateLoyaltyConfig(venueId)

  const config = await prisma.loyaltyConfig.update({
    where: { venueId },
    data,
  })

  return {
    ...config,
    pointsPerDollar: config.pointsPerDollar.toNumber(),
    redemptionRate: config.redemptionRate.toNumber(),
  }
}

/**
 * Calculate how many points a customer earns for a purchase amount
 */
export async function calculatePointsForAmount(venueId: string, amount: number): Promise<number> {
  const config = await getOrCreateLoyaltyConfig(venueId)

  if (!config.active) {
    return 0
  }

  // Calculate points: amount * pointsPerDollar
  const points = Math.floor(amount * config.pointsPerDollar)

  return points
}

/**
 * Calculate discount value from points
 */
export async function calculateDiscountFromPoints(venueId: string, points: number, orderTotal: number): Promise<number> {
  const config = await getOrCreateLoyaltyConfig(venueId)

  if (!config.active || points < config.minPointsRedeem) {
    return 0
  }

  // Calculate discount: points * redemptionRate
  const discount = points * config.redemptionRate

  // Cap discount at order total (can't be more than the order)
  const finalDiscount = Math.min(discount, orderTotal)

  // Round to 2 decimals
  return Math.round(finalDiscount * 100) / 100
}

/**
 * Get customer's current loyalty points balance
 */
export async function getCustomerPointsBalance(venueId: string, customerId: string): Promise<number> {
  const customer = await prisma.customer.findFirst({
    where: {
      id: customerId,
      venueId,
    },
    select: {
      loyaltyPoints: true,
    },
  })

  if (!customer) {
    throw new NotFoundError('Customer not found')
  }

  return customer.loyaltyPoints
}

/**
 * Check if customer can redeem points
 */
export async function canRedeemPoints(venueId: string, customerId: string, points: number): Promise<boolean> {
  const config = await getOrCreateLoyaltyConfig(venueId)
  const currentBalance = await getCustomerPointsBalance(venueId, customerId)

  return config.active && points >= config.minPointsRedeem && currentBalance >= points
}

/**
 * Award loyalty points to customer for a purchase
 * Called automatically when order payment is completed
 */
export async function earnPoints(
  venueId: string,
  customerId: string,
  amount: number,
  orderId: string,
  staffId?: string,
): Promise<{ pointsEarned: number; newBalance: number }> {
  const config = await getOrCreateLoyaltyConfig(venueId)

  if (!config.active) {
    return { pointsEarned: 0, newBalance: 0 }
  }

  const pointsEarned = await calculatePointsForAmount(venueId, amount)

  if (pointsEarned === 0) {
    return { pointsEarned: 0, newBalance: 0 }
  }

  // Create transaction and update customer balance in a transaction
  const [transaction, customer] = await prisma.$transaction([
    prisma.loyaltyTransaction.create({
      data: {
        customerId,
        type: LoyaltyTransactionType.EARN,
        points: pointsEarned,
        orderId,
        reason: `Earned ${pointsEarned} points for purchase of $${amount.toFixed(2)}`,
        createdById: staffId,
      },
    }),
    prisma.customer.update({
      where: { id: customerId },
      data: {
        loyaltyPoints: { increment: pointsEarned },
      },
      select: {
        loyaltyPoints: true,
      },
    }),
  ])

  return {
    pointsEarned,
    newBalance: customer.loyaltyPoints,
  }
}

/**
 * Redeem loyalty points for discount
 * Called during checkout when customer wants to use points
 */
export async function redeemPoints(
  venueId: string,
  customerId: string,
  points: number,
  orderId: string,
  staffId?: string,
): Promise<{ pointsRedeemed: number; discountAmount: number; newBalance: number }> {
  const config = await getOrCreateLoyaltyConfig(venueId)

  if (!config.active) {
    throw new BadRequestError('Loyalty program is not enabled for this venue')
  }

  // Validate customer has enough points
  const currentBalance = await getCustomerPointsBalance(venueId, customerId)

  if (currentBalance < points) {
    throw new BadRequestError(`Insufficient points. Customer has ${currentBalance} points, tried to redeem ${points}`)
  }

  if (points < config.minPointsRedeem) {
    throw new BadRequestError(`Minimum ${config.minPointsRedeem} points required for redemption`)
  }

  // Calculate discount value
  const discountAmount = points * config.redemptionRate

  // Create transaction and update customer balance
  const [transaction, customer] = await prisma.$transaction([
    prisma.loyaltyTransaction.create({
      data: {
        customerId,
        type: LoyaltyTransactionType.REDEEM,
        points: -points, // Negative for redemption
        orderId,
        reason: `Redeemed ${points} points for $${discountAmount.toFixed(2)} discount`,
        createdById: staffId,
      },
    }),
    prisma.customer.update({
      where: { id: customerId },
      data: {
        loyaltyPoints: { decrement: points },
      },
      select: {
        loyaltyPoints: true,
      },
    }),
  ])

  return {
    pointsRedeemed: points,
    discountAmount: Math.round(discountAmount * 100) / 100,
    newBalance: customer.loyaltyPoints,
  }
}

/**
 * Manual point adjustment by staff (corrections, bonuses, penalties)
 */
export async function adjustPoints(
  venueId: string,
  customerId: string,
  points: number,
  reason: string,
  staffId: string,
): Promise<{ newBalance: number }> {
  // Validate customer exists and belongs to venue
  const customer = await prisma.customer.findFirst({
    where: {
      id: customerId,
      venueId,
    },
  })

  if (!customer) {
    throw new NotFoundError('Customer not found')
  }

  // Check that adjustment won't result in negative balance
  const newBalance = customer.loyaltyPoints + points
  if (newBalance < 0) {
    throw new BadRequestError(`Cannot adjust points. Would result in negative balance (${newBalance})`)
  }

  // Create transaction and update balance
  const [transaction, updatedCustomer] = await prisma.$transaction([
    prisma.loyaltyTransaction.create({
      data: {
        customerId,
        type: LoyaltyTransactionType.ADJUST,
        points,
        reason,
        createdById: staffId,
      },
    }),
    prisma.customer.update({
      where: { id: customerId },
      data: {
        loyaltyPoints: { increment: points },
      },
      select: {
        loyaltyPoints: true,
      },
    }),
  ])

  return {
    newBalance: updatedCustomer.loyaltyPoints,
  }
}

/**
 * Get loyalty transaction history for a customer
 */
export async function getLoyaltyTransactions(
  venueId: string,
  customerId: string,
  options: {
    page?: number
    pageSize?: number
    type?: LoyaltyTransactionType
  } = {},
) {
  // Validate customer belongs to venue
  const customer = await prisma.customer.findFirst({
    where: {
      id: customerId,
      venueId,
    },
  })

  if (!customer) {
    throw new NotFoundError('Customer not found')
  }

  const page = options.page || 1
  const pageSize = options.pageSize || 20
  const skip = (page - 1) * pageSize

  const whereCondition: any = {
    customerId,
  }

  if (options.type) {
    whereCondition.type = options.type
  }

  const [transactions, totalCount] = await prisma.$transaction([
    prisma.loyaltyTransaction.findMany({
      where: whereCondition,
      skip,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            total: true,
            createdAt: true,
          },
        },
        createdBy: {
          select: {
            id: true,
            staff: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        },
      },
    }),
    prisma.loyaltyTransaction.count({ where: whereCondition }),
  ])

  const totalPages = Math.ceil(totalCount / pageSize)

  return {
    data: transactions.map((t: any) => ({
      id: t.id,
      customerId: t.customerId,
      type: t.type,
      points: t.points,
      reason: t.reason,
      orderId: t.orderId,
      createdById: t.createdById,
      createdAt: t.createdAt,
      order: t.order
        ? {
            id: t.order.id,
            orderNumber: t.order.orderNumber,
            total: t.order.total.toNumber(),
            createdAt: t.order.createdAt,
          }
        : null,
      createdBy: t.createdBy?.staff
        ? {
            id: t.createdBy.staff.id,
            name: `${t.createdBy.staff.firstName || ''} ${t.createdBy.staff.lastName || ''}`.trim(),
          }
        : null,
    })),
    meta: {
      totalCount,
      pageSize,
      currentPage: page,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
    currentBalance: customer.loyaltyPoints,
  }
}

/**
 * Expire old loyalty points based on config
 * Should be run periodically (e.g., daily cron job)
 */
export async function expireOldPoints(venueId: string): Promise<{ customersAffected: number; pointsExpired: number }> {
  const config = await getOrCreateLoyaltyConfig(venueId)

  if (!config.active || !config.pointsExpireDays) {
    return { customersAffected: 0, pointsExpired: 0 }
  }

  const expirationDate = new Date()
  expirationDate.setDate(expirationDate.getDate() - config.pointsExpireDays)

  // Find all EARN transactions older than expiration date
  const oldTransactions = await prisma.loyaltyTransaction.findMany({
    where: {
      customer: {
        venueId,
      },
      type: LoyaltyTransactionType.EARN,
      createdAt: { lt: expirationDate },
    },
    include: {
      customer: {
        select: {
          id: true,
          loyaltyPoints: true,
        },
      },
    },
  })

  let totalPointsExpired = 0
  const affectedCustomerIds = new Set<string>()

  for (const transaction of oldTransactions) {
    const pointsToExpire = Math.min(transaction.points, transaction.customer.loyaltyPoints)

    if (pointsToExpire > 0) {
      // Create EXPIRE transaction and update customer balance
      await prisma.$transaction([
        prisma.loyaltyTransaction.create({
          data: {
            customerId: transaction.customerId,
            type: LoyaltyTransactionType.EXPIRE,
            points: -pointsToExpire,
            reason: `Expired ${pointsToExpire} points from transaction ${transaction.id} (older than ${config.pointsExpireDays} days)`,
          },
        }),
        prisma.customer.update({
          where: { id: transaction.customerId },
          data: {
            loyaltyPoints: { decrement: pointsToExpire },
          },
        }),
      ])

      totalPointsExpired += pointsToExpire
      affectedCustomerIds.add(transaction.customerId)
    }
  }

  return {
    customersAffected: affectedCustomerIds.size,
    pointsExpired: totalPointsExpired,
  }
}
