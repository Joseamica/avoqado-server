/**
 * Checkout Session Service
 *
 * Manages checkout sessions for e-commerce merchants using Avoqado SDK.
 * Follows Stripe checkout session pattern for familiar developer experience.
 *
 * @module services/sdk/checkout-session
 */

import prisma from '@/utils/prismaClient'
import { CheckoutStatus, Prisma } from '@prisma/client'
import { BadRequestError, NotFoundError, UnauthorizedError } from '@/errors/AppError'
import crypto from 'crypto'
import logger from '@/config/logger'

/**
 * Generates a unique checkout session ID
 * Format: cs_avoqado_{random} (production) or cs_test_{random} (sandbox)
 */
function generateSessionId(sandboxMode: boolean): string {
  const prefix = sandboxMode ? 'cs_test' : 'cs_avoqado'
  const randomPart = crypto.randomBytes(16).toString('hex')
  return `${prefix}_${randomPart}`
}

/**
 * Creates a new checkout session for SDK payment
 *
 * @param ecommerceMerchantId - ID of the e-commerce merchant
 * @param data - Checkout session creation data
 * @returns Created checkout session with Blumon checkout URL
 */
export async function createCheckoutSession(
  ecommerceMerchantId: string,
  data: {
    amount: number
    currency?: string
    description?: string
    customerEmail?: string
    customerPhone?: string
    customerName?: string
    externalOrderId?: string
    metadata?: Record<string, any>
    ipAddress?: string
    userAgent?: string
    referrer?: string
    successUrl?: string // URL to redirect on success
    cancelUrl?: string // URL to redirect on cancel
  },
) {
  // 1. Validate e-commerce merchant exists and is active
  const merchant = await prisma.ecommerceMerchant.findUnique({
    where: { id: ecommerceMerchantId },
    include: {
      provider: true,
      pricingStructure: true,
    },
  })

  if (!merchant) {
    throw new NotFoundError('E-commerce merchant not found')
  }

  if (!merchant.active) {
    throw new UnauthorizedError('Merchant account is inactive')
  }

  if (!merchant.provider) {
    throw new BadRequestError('Provider configuration is missing')
  }

  // 2. Validate amount
  if (data.amount <= 0) {
    throw new BadRequestError('Amount must be greater than 0')
  }

  // 3. Generate unique session ID
  const sessionId = generateSessionId(merchant.sandboxMode)

  // 4. Calculate expiration (24 hours from now)
  const expiresAt = new Date()
  expiresAt.setHours(expiresAt.getHours() + 24)

  // 5. Create checkout session in database
  const session = await prisma.checkoutSession.create({
    data: {
      sessionId,
      ecommerceMerchantId,
      amount: data.amount,
      currency: data.currency || 'MXN',
      description: data.description,
      customerEmail: data.customerEmail,
      customerPhone: data.customerPhone,
      customerName: data.customerName,
      externalOrderId: data.externalOrderId,
      metadata: data.metadata as Prisma.InputJsonValue,
      ipAddress: data.ipAddress,
      userAgent: data.userAgent,
      referrer: data.referrer,
      status: CheckoutStatus.PENDING,
      expiresAt,
    },
    include: {
      ecommerceMerchant: {
        include: {
          provider: true,
        },
      },
    },
  })

  logger.info('Checkout session created', {
    sessionId: session.sessionId,
    ecommerceMerchantId,
    amount: data.amount,
    sandboxMode: merchant.sandboxMode,
  })

  // 6. Store success/cancel URLs in metadata for webhook processing
  // We'll need these when the customer returns from Blumon
  const extendedMetadata = {
    ...(data.metadata || {}),
    successUrl: data.successUrl,
    cancelUrl: data.cancelUrl,
  }

  await prisma.checkoutSession.update({
    where: { id: session.id },
    data: {
      metadata: extendedMetadata as Prisma.InputJsonValue,
    },
  })

  // 7. Session created successfully (no Blumon API call for direct charge flow)
  // Payment will be processed separately via direct charge endpoint (tokenize + authorize)
  logger.info('Checkout session created (direct charge flow)', {
    sessionId: session.sessionId,
    amount: data.amount,
    currency: data.currency || 'MXN',
  })

  return {
    id: session.id,
    sessionId: session.sessionId,
    status: session.status,
    amount: session.amount,
    currency: session.currency,
    expiresAt: session.expiresAt,
    checkoutUrl: null, // No redirect URL for direct charge flow
  }
}

/**
 * Retrieves a checkout session by session ID
 *
 * @param sessionId - Checkout session ID (cs_avoqado_xxx or cs_test_xxx)
 * @param ecommerceMerchantId - Optional merchant ID for authorization check
 * @returns Checkout session details
 */
export async function getCheckoutSession(sessionId: string, ecommerceMerchantId?: string) {
  const session = await prisma.checkoutSession.findUnique({
    where: { sessionId },
    include: {
      ecommerceMerchant: {
        select: {
          id: true,
          businessName: true,
          sandboxMode: true,
        },
      },
      payment: {
        select: {
          id: true,
          amount: true,
          status: true,
          method: true,
          createdAt: true,
        },
      },
    },
  })

  if (!session) {
    throw new NotFoundError('Checkout session not found')
  }

  // Authorization check: if ecommerceMerchantId provided, verify it matches
  if (ecommerceMerchantId && session.ecommerceMerchantId !== ecommerceMerchantId) {
    throw new UnauthorizedError('Unauthorized access to checkout session')
  }

  return session
}

/**
 * Updates checkout session status after Blumon redirect
 * Called by webhook handler when Blumon notifies us of payment result
 *
 * @param sessionId - Checkout session ID
 * @param status - New status
 * @param paymentId - Optional payment ID if payment was created
 * @param errorMessage - Optional error message if failed
 */
export async function updateCheckoutSessionStatus(sessionId: string, status: CheckoutStatus, paymentId?: string, errorMessage?: string) {
  const updateData: Prisma.CheckoutSessionUpdateInput = {
    status,
    errorMessage,
  }

  // Set timestamp based on status
  const now = new Date()
  if (status === CheckoutStatus.COMPLETED) {
    updateData.completedAt = now
  } else if (status === CheckoutStatus.CANCELLED) {
    updateData.cancelledAt = now
  } else if (status === CheckoutStatus.FAILED) {
    updateData.failedAt = now
  }

  // Link payment if provided
  if (paymentId) {
    updateData.payment = {
      connect: { id: paymentId },
    }
  }

  const session = await prisma.checkoutSession.update({
    where: { sessionId },
    data: updateData,
    include: {
      ecommerceMerchant: {
        select: {
          id: true,
          businessName: true,
          webhookUrl: true,
          webhookSecret: true,
        },
      },
    },
  })

  logger.info('Checkout session status updated', {
    sessionId,
    status,
    paymentId,
  })

  return session
}

/**
 * Cancels a checkout session
 * Can only cancel sessions in PENDING or PROCESSING status
 *
 * @param sessionId - Checkout session ID
 * @param ecommerceMerchantId - Merchant ID for authorization
 */
export async function cancelCheckoutSession(sessionId: string, ecommerceMerchantId: string) {
  const session = await prisma.checkoutSession.findUnique({
    where: { sessionId },
  })

  if (!session) {
    throw new NotFoundError('Checkout session not found')
  }

  // Authorization check
  if (session.ecommerceMerchantId !== ecommerceMerchantId) {
    throw new UnauthorizedError('Unauthorized access to checkout session')
  }

  // Can only cancel PENDING or PROCESSING sessions
  const cancellableStatuses: CheckoutStatus[] = [CheckoutStatus.PENDING, CheckoutStatus.PROCESSING]
  if (!cancellableStatuses.includes(session.status)) {
    throw new BadRequestError(`Cannot cancel session with status ${session.status}. Only PENDING or PROCESSING sessions can be cancelled.`)
  }

  const updatedSession = await prisma.checkoutSession.update({
    where: { sessionId },
    data: {
      status: CheckoutStatus.CANCELLED,
      cancelledAt: new Date(),
    },
  })

  logger.info('Checkout session cancelled', {
    sessionId,
    ecommerceMerchantId,
  })

  return updatedSession
}

/**
 * Lists checkout sessions for an e-commerce merchant
 * Supports pagination and filtering by status
 *
 * @param ecommerceMerchantId - Merchant ID
 * @param options - Filter and pagination options
 */
export async function listCheckoutSessions(
  ecommerceMerchantId: string,
  options: {
    status?: CheckoutStatus
    limit?: number
    offset?: number
    startDate?: Date
    endDate?: Date
  } = {},
) {
  const { status, limit = 20, offset = 0, startDate, endDate } = options

  const where: Prisma.CheckoutSessionWhereInput = {
    ecommerceMerchantId,
  }

  if (status) {
    where.status = status
  }

  if (startDate || endDate) {
    where.createdAt = {}
    if (startDate) where.createdAt.gte = startDate
    if (endDate) where.createdAt.lte = endDate
  }

  const [sessions, total] = await Promise.all([
    prisma.checkoutSession.findMany({
      where,
      include: {
        payment: {
          select: {
            id: true,
            amount: true,
            status: true,
            method: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.checkoutSession.count({ where }),
  ])

  return {
    sessions,
    total,
    limit,
    offset,
    hasMore: offset + limit < total,
  }
}

/**
 * Cleans up expired checkout sessions
 * Should be run by a cron job daily
 * Marks expired sessions as EXPIRED if they're still PENDING
 */
export async function cleanupExpiredSessions() {
  const now = new Date()

  const result = await prisma.checkoutSession.updateMany({
    where: {
      status: CheckoutStatus.PENDING,
      expiresAt: {
        lt: now,
      },
    },
    data: {
      status: CheckoutStatus.EXPIRED,
    },
  })

  logger.info('Expired checkout sessions cleaned up', {
    count: result.count,
  })

  return result.count
}

/**
 * Gets checkout session statistics for a merchant
 * Useful for dashboard analytics
 *
 * @param ecommerceMerchantId - Merchant ID
 * @param startDate - Optional start date filter
 * @param endDate - Optional end date filter
 */
export async function getCheckoutSessionStats(ecommerceMerchantId: string, startDate?: Date, endDate?: Date) {
  const where: Prisma.CheckoutSessionWhereInput = {
    ecommerceMerchantId,
  }

  if (startDate || endDate) {
    where.createdAt = {}
    if (startDate) where.createdAt.gte = startDate
    if (endDate) where.createdAt.lte = endDate
  }

  // Get counts by status
  const statusCounts = await prisma.checkoutSession.groupBy({
    by: ['status'],
    where,
    _count: {
      id: true,
    },
    _sum: {
      amount: true,
    },
  })

  // Calculate totals
  const stats = {
    total: 0,
    totalAmount: 0,
    byStatus: {} as Record<CheckoutStatus, { count: number; amount: number }>,
  }

  for (const item of statusCounts) {
    stats.total += item._count.id
    stats.totalAmount += Number(item._sum.amount || 0)
    stats.byStatus[item.status] = {
      count: item._count.id,
      amount: Number(item._sum.amount || 0),
    }
  }

  // Calculate conversion rate (completed / total)
  const completedCount = stats.byStatus[CheckoutStatus.COMPLETED]?.count || 0
  const conversionRate = stats.total > 0 ? (completedCount / stats.total) * 100 : 0

  return {
    ...stats,
    conversionRate,
  }
}
