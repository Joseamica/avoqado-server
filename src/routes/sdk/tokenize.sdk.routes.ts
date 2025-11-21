/**
 * SDK Tokenization Routes
 *
 * Endpoints for card tokenization and payment processing
 *
 * Security:
 * - Rate limiting: 10 requests/minute per IP
 * - CSP headers enforced
 * - Logs filtered for PAN/CVV
 */

import { Router } from 'express'
import { tokenizeCard, chargeWithToken } from '@/controllers/sdk/tokenize.sdk.controller'
import { rateLimit } from 'express-rate-limit'

const router = Router()

// Rate limiting middleware
const tokenizeLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute
  message: 'Too many tokenization requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
})

/**
 * POST /sdk/tokenize
 *
 * Tokenizes card data with Blumon
 *
 * Body:
 * {
 *   sessionId: string,
 *   cardData: {
 *     pan: string,
 *     cvv: string,
 *     expMonth: string,
 *     expYear: string,
 *     cardholderName: string
 *   }
 * }
 *
 * Response:
 * {
 *   success: true,
 *   token: string,
 *   maskedPan: string,
 *   cardBrand: string
 * }
 */
router.post('/tokenize', tokenizeLimiter, tokenizeCard)

/**
 * POST /sdk/charge
 *
 * Processes payment with tokenized card
 *
 * Body:
 * {
 *   sessionId: string,
 *   cvv: string
 * }
 *
 * Response:
 * {
 *   success: true,
 *   authorizationId: string,
 *   transactionId: string
 * }
 */
router.post('/charge', tokenizeLimiter, chargeWithToken)

/**
 * POST /sdk/test-session
 *
 * Creates a test checkout session (NO AUTH REQUIRED - TESTING ONLY)
 *
 * Body:
 * {
 *   amount: number,
 *   currency?: string (default: "MXN"),
 *   description?: string
 * }
 *
 * Response:
 * {
 *   success: true,
 *   sessionId: string
 * }
 */
router.post('/test-session', async (req, res, next) => {
  try {
    const { default: prisma } = await import('@/utils/prismaClient')
    const { default: crypto } = await import('crypto')
    const { CheckoutStatus } = await import('@prisma/client')

    const { amount = 10.0, currency = 'MXN', description = 'Test payment' } = req.body

    // Find merchant with real Blumon credentials
    // Try "Tienda Web (Blumon)" first (doesn't have merchantId in credentials)
    let merchant = await prisma.ecommerceMerchant.findFirst({
      where: {
        channelName: 'Tienda Web (Blumon)',
        sandboxMode: true,
        active: true,
      },
    })

    // Fallback to "Web Test" if not found
    if (!merchant) {
      merchant = await prisma.ecommerceMerchant.findFirst({
        where: {
          channelName: 'Web Test',
          sandboxMode: true,
          active: true,
        },
      })
    }

    if (!merchant) {
      throw new Error('No test merchant found. Run: npx ts-node -r tsconfig-paths/register scripts/blumon-authenticate-master.ts')
    }

    // Create checkout session
    const sessionId = `cs_test_${crypto.randomBytes(16).toString('hex')}`
    const expiresAt = new Date()
    expiresAt.setHours(expiresAt.getHours() + 24)

    const session = await prisma.checkoutSession.create({
      data: {
        sessionId,
        ecommerceMerchantId: merchant.id,
        amount,
        currency,
        description,
        status: CheckoutStatus.PENDING,
        expiresAt,
        metadata: {
          test: true,
          createdBy: 'test-endpoint',
        },
      },
    })

    res.status(201).json({
      success: true,
      sessionId: session.sessionId,
    })
  } catch (error: any) {
    next(error)
  }
})

export default router
