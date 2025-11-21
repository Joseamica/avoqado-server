/**
 * Tokenization Controller - SDK Checkout
 *
 * ⚠️ CRITICAL SECURITY: This endpoint handles sensitive card data
 *
 * SECURITY MEASURES (following Edgardo's guidance):
 * 1. Data ONLY in RAM (never persisted)
 * 2. Logs NEVER contain PAN/CVV (filtered)
 * 3. Immediate tokenization with Blumon
 * 4. CSP headers enforced
 * 5. Rate limiting applied
 *
 * SAQ A COMPLIANCE:
 * - Card data passes through but is NOT stored
 * - Immediate tokenization (Blumon "ampara con su PCI la última milla")
 * - Only tokens are persisted
 */

import { Request, Response } from 'express'
import logger from '@/config/logger'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { getBlumonEcommerceService } from '@/services/sdk/blumon-ecommerce.service'
import { blumonAuthService } from '@/services/blumon/blumonAuth.service'
import { CheckoutStatus } from '@prisma/client'
import { parseBlumonError } from '@/utils/blumon-error-parser'

// ═══════════════════════════════════════════════════════════════════════════
// LOG FILTERING - NEVER LOG SENSITIVE DATA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Filters sensitive card data from logs
 * Masks PAN (shows only first 6 + last 4) and completely removes CVV
 */
function sanitizeCardData(cardData: any) {
  if (!cardData) return null

  const sanitized = { ...cardData }

  // Mask PAN (Primary Account Number)
  if (sanitized.pan) {
    const pan = sanitized.pan.replace(/\s/g, '')
    sanitized.pan = pan.substring(0, 6) + '******' + pan.substring(pan.length - 4)
  }

  // NEVER log CVV
  if (sanitized.cvv) {
    sanitized.cvv = '***'
  }

  return sanitized
}

// ═══════════════════════════════════════════════════════════════════════════
// TOKENIZATION ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════

export async function tokenizeCard(req: Request, res: Response) {
  const { sessionId, cardData } = req.body

  // Log request WITHOUT sensitive data
  logger.info('💳 [TOKENIZE] Card tokenization request', {
    sessionId,
    cardData: sanitizeCardData(cardData), // ← Sanitized!
    ip: req.ip,
    userAgent: req.get('user-agent'),
  })

  try {
    // 1. Validate request
    if (!sessionId || !cardData) {
      throw new BadRequestError('Missing sessionId or cardData')
    }

    const { pan, cvv, expMonth, expYear, cardholderName } = cardData

    if (!pan || !cvv || !expMonth || !expYear) {
      throw new BadRequestError('Incomplete card data')
    }

    // 2. Fetch checkout session
    const session = await prisma.checkoutSession.findUnique({
      where: { sessionId },
      include: {
        ecommerceMerchant: {
          include: {
            provider: true,
          },
        },
      },
    })

    if (!session) {
      throw new NotFoundError('Checkout session not found')
    }

    // ✅ STRIPE PATTERN: Block only COMPLETED or EXPIRED sessions
    // Allow retries on FAILED sessions (user can try different card or retry)
    if (session.status === CheckoutStatus.COMPLETED) {
      throw new BadRequestError('This checkout session has already been completed')
    }

    // Check expiration FIRST (before allowing retries)
    if (session.expiresAt < new Date()) {
      await prisma.checkoutSession.update({
        where: { id: session.id },
        data: { status: CheckoutStatus.EXPIRED },
      })
      throw new BadRequestError('Checkout session expired')
    }

    // If session is FAILED, reset to PENDING to allow retry (Stripe pattern)
    if (session.status === CheckoutStatus.FAILED) {
      logger.info('🔄 [TOKENIZE] Resetting FAILED session to PENDING for retry', {
        sessionId,
        previousStatus: session.status,
      })

      await prisma.checkoutSession.update({
        where: { id: session.id },
        data: { status: CheckoutStatus.PENDING },
      })
    }

    // 3. Validate provider is Blumon
    if (session.ecommerceMerchant.provider.code !== 'BLUMON') {
      throw new BadRequestError('Tokenization only supported for Blumon provider')
    }

    // 4. Get OAuth credentials and refresh if needed
    const credentials = session.ecommerceMerchant.providerCredentials as any

    if (!credentials?.accessToken) {
      throw new BadRequestError('Merchant OAuth credentials missing')
    }

    // Check token expiration
    const expiresAt = new Date(credentials.expiresAt)
    const isExpired = blumonAuthService.isTokenExpired(expiresAt, 5)

    let accessToken = credentials.accessToken

    if (isExpired && credentials.refreshToken) {
      logger.info('🔄 [TOKENIZE] Refreshing expired OAuth token', {
        merchantId: session.ecommerceMerchant.id,
      })

      const refreshResult = await blumonAuthService.refreshToken(credentials.refreshToken, session.ecommerceMerchant.sandboxMode)

      // Update merchant credentials
      await prisma.ecommerceMerchant.update({
        where: { id: session.ecommerceMerchant.id },
        data: {
          providerCredentials: {
            ...credentials,
            accessToken: refreshResult.accessToken,
            refreshToken: refreshResult.refreshToken,
            expiresIn: refreshResult.expiresIn,
            expiresAt: refreshResult.expiresAt.toISOString(),
            refreshedAt: new Date().toISOString(),
          },
        },
      })

      accessToken = refreshResult.accessToken
    }

    // 5. Tokenize with Blumon (Edgardo: "amparo con mi PCI la última milla")
    logger.info('🔐 [TOKENIZE] Calling Blumon tokenization API', {
      sessionId,
      cardLast4: pan.slice(-4),
    })

    const blumonService = getBlumonEcommerceService(session.ecommerceMerchant.sandboxMode)

    // ⚠️ CRITICAL: Card data is in RAM here, but NEVER logged or persisted
    const tokenResult = await blumonService.tokenizeCard({
      accessToken,
      pan: pan.replace(/\s/g, ''), // Remove spaces
      cvv,
      expMonth, // MM
      expYear, // YYYY (4 digits required by Blumon)
      holderName: cardholderName,
      customerEmail: session.customerEmail || undefined,
      customerPhone: session.customerPhone || undefined,
    })

    // 6. Store token in session (NOT card data!)
    const metadata = (session.metadata as any) || {}

    await prisma.checkoutSession.update({
      where: { id: session.id },
      data: {
        metadata: {
          ...metadata,
          cardToken: tokenResult.token,
          maskedPan: tokenResult.maskedPan,
          cardBrand: tokenResult.cardBrand,
          tokenizedAt: new Date().toISOString(),
        },
        status: CheckoutStatus.PROCESSING,
      },
    })

    logger.info('✅ [TOKENIZE] Card tokenized successfully', {
      sessionId,
      maskedPan: tokenResult.maskedPan,
      cardBrand: tokenResult.cardBrand,
    })

    // 7. Return token to frontend (card data NEVER returned)
    res.status(200).json({
      success: true,
      token: tokenResult.token,
      maskedPan: tokenResult.maskedPan,
      cardBrand: tokenResult.cardBrand,
    })
  } catch (error: any) {
    logger.error('❌ [TOKENIZE] Tokenization failed', {
      sessionId,
      error: error.message,
      // NO card data in error logs!
    })

    // Parse Blumon error into user-friendly message
    const friendlyError = parseBlumonError(error)

    // Return user-friendly error
    res.status(error.statusCode || 400).json({
      success: false,
      error: friendlyError.title,
      message: friendlyError.message,
      action: friendlyError.action,
      canRetry: friendlyError.canRetry,
      // Include original error for debugging (remove in production)
      debug: process.env.NODE_ENV === 'development' ? error.message : undefined,
    })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CHARGE WITH TOKEN (After tokenization)
// ═══════════════════════════════════════════════════════════════════════════

export async function chargeWithToken(req: Request, res: Response) {
  const { sessionId, cvv } = req.body

  logger.info('💰 [CHARGE] Processing charge with token', {
    sessionId,
    hasCvv: !!cvv,
  })

  try {
    // 1. Fetch session with token
    const session = await prisma.checkoutSession.findUnique({
      where: { sessionId },
      include: {
        ecommerceMerchant: {
          include: {
            provider: true,
          },
        },
      },
    })

    if (!session) {
      throw new NotFoundError('Checkout session not found')
    }

    const metadata = session.metadata as any
    const cardToken = metadata?.cardToken

    if (!cardToken) {
      throw new BadRequestError('Card not tokenized. Call /tokenize first.')
    }

    // 2. Get OAuth token
    const credentials = session.ecommerceMerchant.providerCredentials as any
    let accessToken = credentials.accessToken

    // Check/refresh token
    const expiresAt = new Date(credentials.expiresAt)
    const isExpired = blumonAuthService.isTokenExpired(expiresAt, 5)

    if (isExpired && credentials.refreshToken) {
      const refreshResult = await blumonAuthService.refreshToken(credentials.refreshToken, session.ecommerceMerchant.sandboxMode)

      await prisma.ecommerceMerchant.update({
        where: { id: session.ecommerceMerchant.id },
        data: {
          providerCredentials: {
            ...credentials,
            accessToken: refreshResult.accessToken,
            refreshToken: refreshResult.refreshToken,
            expiresIn: refreshResult.expiresIn,
            expiresAt: refreshResult.expiresAt.toISOString(),
          },
        },
      })

      accessToken = refreshResult.accessToken
    }

    // 3. Authorize payment with Blumon
    logger.info('💳 [CHARGE] Authorizing payment', {
      sessionId,
      amount: session.amount,
      cardToken,
    })

    const blumonService = getBlumonEcommerceService(session.ecommerceMerchant.sandboxMode)

    // Extract merchantId from provider credentials (if available)
    const blumonMerchantId = credentials.blumonMerchantId

    const authResult = await blumonService.authorizePayment({
      accessToken,
      amount: Number(session.amount), // Convert Decimal to number
      currency: '484', // MXN
      cardToken,
      cvv, // Still required by Blumon
      orderId: sessionId,
      merchantId: blumonMerchantId, // Routes payment to merchant's account
      reference: `session_${sessionId}`, // Shows in Blumon dashboard & webhook
    })

    // 4. Update session
    await prisma.checkoutSession.update({
      where: { id: session.id },
      data: {
        status: CheckoutStatus.COMPLETED,
        completedAt: new Date(),
        metadata: {
          ...metadata,
          authorizationId: authResult.authorizationId,
          transactionId: authResult.transactionId,
        },
      },
    })

    logger.info('✅ [CHARGE] Payment authorized successfully', {
      sessionId,
      authorizationId: authResult.authorizationId,
    })

    res.status(200).json({
      success: true,
      authorizationId: authResult.authorizationId,
      transactionId: authResult.transactionId,
    })
  } catch (error: any) {
    logger.error('❌ [CHARGE] Payment authorization failed', {
      sessionId,
      error: error.message,
    })

    // Parse Blumon error into user-friendly message
    const friendlyError = parseBlumonError(error)

    // Update session as failed with friendly error message
    try {
      await prisma.checkoutSession.update({
        where: { sessionId },
        data: {
          status: CheckoutStatus.FAILED,
          errorMessage: friendlyError.message,
          failedAt: new Date(),
        },
      })
    } catch (updateError) {
      logger.error('Failed to update session status', { error: updateError })
    }

    // Return user-friendly error
    res.status(error.statusCode || 400).json({
      success: false,
      error: friendlyError.title,
      message: friendlyError.message,
      action: friendlyError.action,
      canRetry: friendlyError.canRetry,
      // Include original error for debugging (remove in production)
      debug: process.env.NODE_ENV === 'development' ? error.message : undefined,
    })
  }
}
