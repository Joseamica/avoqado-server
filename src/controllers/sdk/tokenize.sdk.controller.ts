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
import { BadRequestError, ConflictError, NotFoundError, PaymentOutcomeUnknownError } from '@/errors/AppError'
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

/**
 * Error que la página del SDK NO debe reintentar (auditoría 2026-09-30): el pago ya se hizo, se está haciendo
 * o la sesión ya no vive. Mismas llaves que el resto de las respuestas de error.
 */
function respondNoRetry(res: Response, httpStatus: number, title: string, message: string, sessionId?: string) {
  return res.status(httpStatus).json({
    success: false,
    error: title,
    message,
    action: 'Verifica el estado del pago antes de volver a intentarlo.',
    canRetry: false,
    // Para soporte: con esto se ubica el cobro en conciliación.
    ...(sessionId ? { sessionId } : {}),
  })
}

/** Estados donde reintentar no sirve: ya se cobró, se está cobrando, o la sesión ya no vive. */
const DEAD_OR_IN_FLIGHT: CheckoutStatus[] = [
  CheckoutStatus.COMPLETED,
  CheckoutStatus.CHARGING,
  CheckoutStatus.CANCELLED,
  CheckoutStatus.EXPIRED,
]

function respondForDeadOrInFlight(res: Response, status: CheckoutStatus, sessionId?: string) {
  if (status === CheckoutStatus.COMPLETED) return respondNoRetry(res, 409, 'Pago completado', 'Este pago ya se completó.', sessionId)
  if (status === CheckoutStatus.CHARGING) {
    return respondNoRetry(res, 409, 'Pago en proceso', 'Tu pago se está confirmando. No lo intentes de nuevo.', sessionId)
  }
  return respondNoRetry(res, 409, 'Sesión no disponible', 'Esta sesión de pago ya no está disponible.', sessionId)
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

    // 🔴 Auditoría 2026-09-30: las sesiones de una liga de pago van por su propio flujo.
    if (session.paymentLinkId) {
      throw new BadRequestError('This checkout session belongs to a payment link')
    }

    // ✅ STRIPE PATTERN: se reintenta una FAILED. Ya cobrada, cobrándose, cancelada o vencida: no, y se dice.
    if (DEAD_OR_IN_FLIGHT.includes(session.status)) {
      return respondForDeadOrInFlight(res, session.status, sessionId)
    }

    // Check expiration FIRST (before allowing retries)
    if (session.expiresAt < new Date()) {
      await prisma.checkoutSession.updateMany({
        where: { id: session.id, status: session.status },
        data: { status: CheckoutStatus.EXPIRED },
      })
      return respondForDeadOrInFlight(res, CheckoutStatus.EXPIRED, sessionId)
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

    // Check token expiration (handle both field names for backward compat)
    const expiresAtStr = credentials.expiresAt || credentials.tokenExpiresAt
    const expiresAt = expiresAtStr ? new Date(expiresAtStr) : new Date(0) // Force expired if missing
    const isExpired = blumonAuthService.isTokenExpired(expiresAt, 5)

    let accessToken = credentials.accessToken

    if (isExpired) {
      logger.info('🔄 [TOKENIZE] OAuth token expired, attempting refresh/re-auth', {
        merchantId: session.ecommerceMerchant.id,
        expiresAt: expiresAtStr,
      })

      let authResult: { accessToken: string; refreshToken?: string; expiresIn: number; expiresAt: Date }

      try {
        // Try refresh token first
        if (credentials.refreshToken) {
          authResult = await blumonAuthService.refreshToken(credentials.refreshToken, session.ecommerceMerchant.sandboxMode)
        } else {
          throw new Error('No refresh token available')
        }
      } catch (refreshError: any) {
        // Refresh failed (token also expired) — re-authenticate with password
        logger.warn('🔄 [TOKENIZE] Refresh failed, re-authenticating with credentials', {
          merchantId: session.ecommerceMerchant.id,
          refreshError: refreshError.message,
        })

        if (!credentials.username || !credentials.password) {
          throw new BadRequestError('OAuth token expired and no credentials for re-authentication')
        }

        authResult = await blumonAuthService.authenticate(
          { username: credentials.username, password: credentials.password },
          session.ecommerceMerchant.sandboxMode,
        )
      }

      // Update merchant credentials
      await prisma.ecommerceMerchant.update({
        where: { id: session.ecommerceMerchant.id },
        data: {
          providerCredentials: {
            ...credentials,
            accessToken: authResult.accessToken,
            refreshToken: authResult.refreshToken,
            expiresIn: authResult.expiresIn,
            expiresAt: authResult.expiresAt.toISOString(),
            refreshedAt: new Date().toISOString(),
          },
        },
      })

      accessToken = authResult.accessToken
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

    // 🔴 Auditoría 2026-09-30: un solo paso con candado sobre lo que se leyó. Si mientras se tokenizaba el cobro
    // reclamó la sesión (CHARGING), regresarla a PROCESSING habilitaba un segundo cargo. Una FAILED pasa directo a
    // PROCESSING (antes había un reinicio aparte a PENDING) y se limpian los restos del fallo anterior.
    const stored = await prisma.checkoutSession.updateMany({
      where: { id: session.id, status: session.status, updatedAt: session.updatedAt },
      data: {
        metadata: {
          ...metadata,
          cardToken: tokenResult.token,
          maskedPan: tokenResult.maskedPan,
          cardBrand: tokenResult.cardBrand,
          tokenizedAt: new Date().toISOString(),
        },
        status: CheckoutStatus.PROCESSING,
        failedAt: null,
        errorMessage: null,
      },
    })
    if (stored.count === 0) {
      const now = await prisma.checkoutSession.findUnique({ where: { id: session.id }, select: { status: true } })
      if (now && DEAD_OR_IN_FLIGHT.includes(now.status)) return respondForDeadOrInFlight(res, now.status, sessionId)
      throw new BadRequestError('The checkout session changed while the card was being tokenized. Reload it and try again.')
    }

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
  const { sessionId, cvv, cardToken: requestedToken } = req.body

  logger.info('💰 [CHARGE] Processing charge with token', {
    sessionId,
    hasCvv: !!cvv,
  })

  // Sólo quien gana PROCESSING → CHARGING puede escribir FAILED, y sólo si el banco dijo que no.
  let claimed = false
  // El banco ya aprobó: pase lo que pase después, la sesión NO se marca FAILED (el cliente pagaría dos veces).
  let authorized = false

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

    // 🔴 Auditoría 2026-09-30: las sesiones de una liga de pago se cobran por su propio flujo (orden, pago, comisión).
    if (session.paymentLinkId) {
      throw new BadRequestError('This checkout session belongs to a payment link')
    }

    // 🔴 Ya cobrada, cobrándose, cancelada o vencida: no se cobra y se dice que no se reintente.
    if (DEAD_OR_IN_FLIGHT.includes(session.status)) {
      return respondForDeadOrInFlight(res, session.status, sessionId)
    }
    if (session.status !== CheckoutStatus.PROCESSING) {
      throw new BadRequestError('Card not tokenized. Call /tokenize first.')
    }

    if (session.expiresAt < new Date()) {
      await prisma.checkoutSession.updateMany({
        where: { id: session.id, status: CheckoutStatus.PROCESSING },
        data: { status: CheckoutStatus.EXPIRED },
      })
      return respondForDeadOrInFlight(res, CheckoutStatus.EXPIRED, sessionId)
    }

    const metadata = session.metadata as any
    // 🔴 El reclamo se ata a la tarjeta de ESTA solicitud: la que la página tokenizó y manda en `cardToken`. Sin ella no
    // se cobra (una página vieja sólo tiene que recargarse), y un valor que no es texto no llega al filtro.
    if (typeof requestedToken !== 'string' || requestedToken.length === 0) {
      // Directo, no `throw`: el catch lo pasaría por parseBlumonError y la página diría «Error desconocido».
      return res.status(400).json({ success: false, error: 'Recarga la página e intenta de nuevo.' })
    }
    const cardToken = requestedToken

    // 2. Get OAuth token
    const credentials = session.ecommerceMerchant.providerCredentials as any
    let accessToken = credentials.accessToken

    // Check/refresh token (handle both field names for backward compat)
    const expiresAtStr = credentials.expiresAt || credentials.tokenExpiresAt
    const expiresAt = expiresAtStr ? new Date(expiresAtStr) : new Date(0)
    const isExpired = blumonAuthService.isTokenExpired(expiresAt, 5)

    if (isExpired) {
      let authResult: { accessToken: string; refreshToken?: string; expiresIn: number; expiresAt: Date }

      try {
        if (credentials.refreshToken) {
          authResult = await blumonAuthService.refreshToken(credentials.refreshToken, session.ecommerceMerchant.sandboxMode)
        } else {
          throw new Error('No refresh token available')
        }
      } catch (refreshError: any) {
        logger.warn('🔄 [CHARGE] Refresh failed, re-authenticating', {
          merchantId: session.ecommerceMerchant.id,
          refreshError: refreshError.message,
        })

        if (!credentials.username || !credentials.password) {
          throw new BadRequestError('OAuth token expired and no credentials for re-authentication')
        }

        authResult = await blumonAuthService.authenticate(
          { username: credentials.username, password: credentials.password },
          session.ecommerceMerchant.sandboxMode,
        )
      }

      await prisma.ecommerceMerchant.update({
        where: { id: session.ecommerceMerchant.id },
        data: {
          providerCredentials: {
            ...credentials,
            accessToken: authResult.accessToken,
            refreshToken: authResult.refreshToken,
            expiresIn: authResult.expiresIn,
            expiresAt: authResult.expiresAt.toISOString(),
            refreshedAt: new Date().toISOString(),
          },
        },
      })

      accessToken = authResult.accessToken
    }

    // 🔴 Reclamo atómico ANTES de autorizar (auditoría 2026-09-30), como el cobro de ligas, y sobre ESTA tarjeta: si
    // otra tokenización la cambió, este intento no toca la fila y no cobra.
    const claim = await prisma.checkoutSession.updateMany({
      where: {
        id: session.id,
        status: CheckoutStatus.PROCESSING,
        // 🔴 El vencimiento va DENTRO del candado: un refresco de OAuth lento no deja cobrar una sesión ya vencida.
        expiresAt: { gt: new Date() },
        metadata: { path: ['cardToken'], equals: cardToken },
      },
      data: { status: CheckoutStatus.CHARGING },
    })
    if (claim.count === 0) {
      const now = await prisma.checkoutSession.findUnique({
        where: { id: session.id },
        select: { status: true, expiresAt: true },
      })
      const status = now?.status ?? CheckoutStatus.CHARGING
      if (DEAD_OR_IN_FLIGHT.includes(status)) return respondForDeadOrInFlight(res, status, sessionId)
      if (now && now.expiresAt <= new Date()) {
        await prisma.checkoutSession.updateMany({
          where: { id: session.id, status: CheckoutStatus.PROCESSING },
          data: { status: CheckoutStatus.EXPIRED },
        })
        return respondForDeadOrInFlight(res, CheckoutStatus.EXPIRED, sessionId)
      }
      // Sigue siendo reintentable (la tarjeta cambió, u otro intento terminó en FAILED): el cliente vuelve a intentar.
      throw new ConflictError('The checkout session changed. Please try again.')
    }
    claimed = true

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
    authorized = true

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

    // 🔴 Resultado desconocido (corte tras mandar el cargo) o cargo aprobado que no se pudo guardar: la
    // sesión se queda CHARGING para conciliación y la respuesta NO invita a reintentar.
    if (authorized || error instanceof PaymentOutcomeUnknownError) {
      logger.error('🚨 [CHARGE] Resultado del cobro DESCONOCIDO — sesión retenida en CHARGING para reconciliación', {
        sessionId,
        authorized,
      })
      return respondNoRetry(res, 502, 'No se pudo confirmar el pago', new PaymentOutcomeUnknownError().message, sessionId)
    }

    // Parse Blumon error into user-friendly message
    const friendlyError = parseBlumonError(error)

    // Sólo un rechazo del banco, con el reclamo en la mano, deja FAILED. Un error de validación (liga, token)
    // no toca la sesión. Si la liberación no queda escrita, la sesión sigue CHARGING: no se invita a reintentar.
    if (claimed) {
      const released = await prisma.checkoutSession
        .updateMany({
          where: { sessionId, status: CheckoutStatus.CHARGING },
          data: { status: CheckoutStatus.FAILED, errorMessage: friendlyError.message, failedAt: new Date() },
        })
        .catch(updateError => {
          logger.error('Failed to update session status', { error: updateError })
          return { count: 0 }
        })
      if (released.count !== 1) {
        logger.error('🚨 [CHARGE] El banco rechazó pero la sesión no se pudo liberar: queda CHARGING', { sessionId })
        return respondNoRetry(res, 502, 'No se pudo confirmar el pago', new PaymentOutcomeUnknownError().message, sessionId)
      }
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
