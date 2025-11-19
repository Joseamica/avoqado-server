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

export default router
