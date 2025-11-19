/**
 * SDK Checkout Controller
 *
 * HTTP endpoints for e-commerce merchants to manage checkout sessions via Avoqado SDK.
 * Follows Stripe API design patterns for familiar developer experience.
 *
 * @module controllers/sdk/checkout
 */

import { Request, Response, NextFunction } from 'express'
import * as checkoutSessionService from '@/services/sdk/checkout-session.service'
import { CheckoutStatus } from '@prisma/client'
import { BadRequestError } from '@/errors/AppError'
import logger from '@/config/logger'
import { createCheckoutSessionSchema } from '@/schemas/sdk/checkout.sdk.schema'
import { ZodError } from 'zod'

/**
 * POST /api/v1/sdk/checkout/sessions
 * Create a new checkout session
 *
 * Request body:
 * {
 *   amount: number (required) - Amount in MXN
 *   currency?: string - Currency code (default: "MXN")
 *   description?: string - Payment description
 *   customerEmail?: string - Customer email
 *   customerPhone?: string - Customer phone
 *   customerName?: string - Customer name
 *   externalOrderId?: string - Your internal order ID
 *   metadata?: object - Custom metadata
 *   successUrl: string (required) - Where to redirect after success
 *   cancelUrl: string (required) - Where to redirect on cancel
 * }
 *
 * Response:
 * {
 *   id: string - Internal checkout session ID
 *   sessionId: string - Public session ID (cs_avoqado_xxx or cs_test_xxx)
 *   checkoutUrl: string - URL to redirect customer to Blumon
 *   status: string - "PENDING"
 *   amount: number
 *   currency: string
 *   expiresAt: string (ISO 8601)
 * }
 */
export async function createCheckoutSession(req: Request, res: Response, next: NextFunction) {
  try {
    // Extract SDK context (set by authenticateSDK middleware)
    const sdkContext = req.sdkContext
    if (!sdkContext) {
      throw new BadRequestError('SDK authentication required')
    }

    // ✅ Validate request body with Zod schema (prevents XSS via URL validation)
    let validated
    try {
      validated = createCheckoutSessionSchema.parse(req.body)
    } catch (error) {
      if (error instanceof ZodError) {
        const firstError = error.errors[0]
        throw new BadRequestError(firstError.message)
      }
      throw error
    }

    // Extract customer IP and user agent for fraud detection
    const ipAddress = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || undefined
    const userAgent = req.headers['user-agent'] || undefined
    const referrerHeader = req.headers['referer'] || req.headers['referrer']
    const referrer = Array.isArray(referrerHeader) ? referrerHeader[0] : referrerHeader

    // Create checkout session (service handles OAuth, token refresh, and Blumon API call)
    const session = await checkoutSessionService.createCheckoutSession(sdkContext.merchantId, {
      amount: validated.amount,
      currency: validated.currency,
      description: validated.description,
      customerEmail: validated.customerEmail,
      customerPhone: validated.customerPhone,
      customerName: validated.customerName,
      externalOrderId: validated.externalOrderId,
      metadata: validated.metadata,
      ipAddress,
      userAgent,
      referrer,
      successUrl: validated.successUrl,
      cancelUrl: validated.cancelUrl,
    })

    logger.info('Checkout session created', {
      sessionId: session.sessionId,
      merchantId: sdkContext.merchantId,
      amount: session.amount,
      hasCheckoutUrl: !!session.checkoutUrl,
    })

    // Return response
    res.status(201).json({
      id: session.id,
      sessionId: session.sessionId,
      checkoutUrl: session.checkoutUrl,
      status: session.status,
      amount: session.amount,
      currency: session.currency,
      expiresAt: session.expiresAt.toISOString(),
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/sdk/checkout/sessions/:sessionId
 * Retrieve a checkout session by ID
 */
export async function getCheckoutSession(req: Request, res: Response, next: NextFunction) {
  try {
    const sdkContext = req.sdkContext
    if (!sdkContext) {
      throw new BadRequestError('SDK authentication required')
    }

    const { sessionId } = req.params

    const session = await checkoutSessionService.getCheckoutSession(sessionId, sdkContext.merchantId)

    res.json({
      id: session.id,
      sessionId: session.sessionId,
      status: session.status,
      amount: session.amount,
      currency: session.currency,
      description: session.description,
      customerEmail: session.customerEmail,
      externalOrderId: session.externalOrderId,
      blumonCheckoutUrl: session.blumonCheckoutUrl,
      payment: session.payment
        ? {
            id: session.payment.id,
            amount: session.payment.amount,
            status: session.payment.status,
            method: session.payment.method,
            createdAt: session.payment.createdAt,
          }
        : null,
      expiresAt: session.expiresAt.toISOString(),
      completedAt: session.completedAt?.toISOString() || null,
      cancelledAt: session.cancelledAt?.toISOString() || null,
      failedAt: session.failedAt?.toISOString() || null,
      errorMessage: session.errorMessage,
      createdAt: session.createdAt.toISOString(),
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/sdk/checkout/sessions/:sessionId/cancel
 * Cancel a checkout session
 */
export async function cancelCheckoutSession(req: Request, res: Response, next: NextFunction) {
  try {
    const sdkContext = req.sdkContext
    if (!sdkContext) {
      throw new BadRequestError('SDK authentication required')
    }

    const { sessionId } = req.params

    const session = await checkoutSessionService.cancelCheckoutSession(sessionId, sdkContext.merchantId)

    // Direct charge flow - no Blumon cancellation needed
    // Session is just marked as cancelled in database

    res.json({
      id: session.id,
      sessionId: session.sessionId,
      status: session.status,
      cancelledAt: session.cancelledAt?.toISOString(),
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/sdk/checkout/sessions
 * List checkout sessions for the authenticated merchant
 *
 * Query parameters:
 * - status?: CheckoutStatus
 * - limit?: number (default: 20, max: 100)
 * - offset?: number (default: 0)
 * - startDate?: ISO 8601 date
 * - endDate?: ISO 8601 date
 */
export async function listCheckoutSessions(req: Request, res: Response, next: NextFunction) {
  try {
    const sdkContext = req.sdkContext
    if (!sdkContext) {
      throw new BadRequestError('SDK authentication required')
    }

    // Parse query parameters
    const status = req.query.status as CheckoutStatus | undefined
    const limit = Math.min(Number(req.query.limit) || 20, 100) // Cap at 100
    const offset = Number(req.query.offset) || 0
    const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined
    const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined

    const result = await checkoutSessionService.listCheckoutSessions(sdkContext.merchantId, {
      status,
      limit,
      offset,
      startDate,
      endDate,
    })

    res.json({
      sessions: result.sessions.map(session => ({
        id: session.id,
        sessionId: session.sessionId,
        status: session.status,
        amount: session.amount,
        currency: session.currency,
        description: session.description,
        customerEmail: session.customerEmail,
        externalOrderId: session.externalOrderId,
        payment: session.payment
          ? {
              id: session.payment.id,
              amount: session.payment.amount,
              status: session.payment.status,
              method: session.payment.method,
              createdAt: session.payment.createdAt,
            }
          : null,
        expiresAt: session.expiresAt,
        completedAt: session.completedAt,
        createdAt: session.createdAt,
      })),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      hasMore: result.hasMore,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/sdk/checkout/stats
 * Get checkout session statistics
 *
 * Query parameters:
 * - startDate?: ISO 8601 date
 * - endDate?: ISO 8601 date
 */
export async function getCheckoutStats(req: Request, res: Response, next: NextFunction) {
  try {
    const sdkContext = req.sdkContext
    if (!sdkContext) {
      throw new BadRequestError('SDK authentication required')
    }

    const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined
    const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined

    const stats = await checkoutSessionService.getCheckoutSessionStats(sdkContext.merchantId, startDate, endDate)

    res.json(stats)
  } catch (error) {
    next(error)
  }
}
