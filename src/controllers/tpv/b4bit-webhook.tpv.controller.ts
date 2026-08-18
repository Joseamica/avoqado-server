/**
 * B4Bit Webhook Controller
 *
 * Recibe las notificaciones del gateway de cripto B4Bit.
 *
 * 🔴 SEGURIDAD — este endpoint es la ÚNICA superficie externa del cobro cripto:
 * quien lo convenza de que un pago se confirmó, cobra gratis. Por eso la firma es
 * OBLIGATORIA y el handler espeja el patrón del webhook hermano de AngelPay
 * (`angelpay-webhook.tpv.controller.ts`): bytes crudos → headers → secreto del
 * venue → HMAC en tiempo constante → frescura del nonce → recién entonces se
 * procesa.
 *
 * Orden de rechazos (ninguno llega a `processWebhook`):
 *   · body que no es Buffer ............ 400  (sin los bytes originales no hay HMAC)
 *   · faltan `x-nonce`/`x-signature` ... 401
 *   · el venue no tiene secreto ........ 503  (+ alerta greppable)
 *   · firma inválida ................... 401
 *   · nonce fuera de ±20 s ............. 401  (lo exige la doc de B4Bit)
 *
 * ⚠️ B4Bit NO REINTENTA: un webhook rechazado es una confirmación perdida para
 * siempre. Por eso existe la válvula `B4BIT_STRICT_WEBHOOK_AUTH=false`, que
 * vuelve al comportamiento viejo (procesar igual) pero deja un `logger.error`
 * greppable en CADA caso que habría rechazado — sirve para diagnosticar en
 * minutos si B4Bit no manda los headers como documenta, sin quedarse sin cobros.
 */

import { Request, Response } from 'express'
import logger from '../../config/logger'
import { processWebhook, verifyWebhookSignature } from '../../services/b4bit/b4bit.service'
import type { B4BitWebhookPayload } from '../../services/b4bit/types'
import prisma from '../../utils/prismaClient'

/**
 * Tolerancia del `X-NONCE` contra el reloj del server. La doc de B4Bit pide
 * rechazar cualquier webhook que difiera más de 15-20 segundos.
 */
const NONCE_MAX_SKEW_SECONDS = 20
const NONCE_MAX_SKEW_MS = NONCE_MAX_SKEW_SECONDS * 1000

/**
 * Resuelve el secreto HMAC del venue dueño del pago referenciado.
 *
 * ⚠️ El `reference` lo manda el cliente y NO está verificado todavía: sirve sólo
 * para saber CON QUÉ llave verificar. Si el pago no existe, o el venue no tiene
 * secreto cargado, devuelve `null` y el handler rechaza.
 *
 * El fallback a `B4BIT_WEBHOOK_SECRET` es legado (un único secreto de entorno,
 * previo al secreto por venue) y se conserva por continuidad: es el MISMO que
 * resuelve `verifyWebhookSignature`, así que ambos tienen que coincidir o un
 * venue sin secreto propio quedaría rechazado aquí y aceptado allá.
 */
async function resolveVenueWebhookSecret(paymentRef: string | undefined): Promise<string | null> {
  let venueId: string | null = null

  if (paymentRef) {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentRef },
      select: { venueId: true },
    })
    if (payment) {
      venueId = payment.venueId
      const cryptoConfig = await prisma.venueCryptoConfig.findUnique({
        where: { venueId: payment.venueId },
        select: { b4bitSecretKey: true },
      })
      if (cryptoConfig?.b4bitSecretKey) return cryptoConfig.b4bitSecretKey
    }
  }

  const legacySecret = process.env.B4BIT_WEBHOOK_SECRET || null

  // 🔴 Visible a propósito: el legado TAPA la alerta `🚨 SIN SECRET`. Un venue sin
  // `b4bitSecretKey` no cae en el 503 — verifica contra la llave global, la firma
  // no cuadra y responde 401, que es pérdida SILENCIOSA (B4Bit no reintenta).
  // No se cambia el comportamiento; sólo se deja rastro de quién está así.
  if (legacySecret) {
    logger.warn('⚠️ [B4Bit webhook] usando secreto legado de entorno (B4BIT_WEBHOOK_SECRET) — este venue no tiene b4bitSecretKey propio', {
      venueId,
      reference: paymentRef,
    })
  }

  return legacySecret
}

/**
 * POST /api/v1/webhooks/b4bit
 *
 * Recibe y procesa las notificaciones de B4Bit. Un webhook AUTENTICADO siempre
 * responde 200 (aunque el procesamiento falle) porque B4Bit no reintenta; los
 * rechazos de autenticación sí responden 4xx/5xx.
 */
export async function handleB4BitWebhook(req: Request, res: Response): Promise<void> {
  const startTime = Date.now()

  // 🔴 `@/config/env` NO se importa aquí: valida y hace `process.exit(1)` al
  // importarse, lo que mata los workers de Jest (`.claude/rules/contexto-de-ejecucion.md`).
  const isProduction = process.env.NODE_ENV === 'production'
  const strictAuth = process.env.B4BIT_STRICT_WEBHOOK_AUTH !== 'false'

  /**
   * Rechaza el webhook, o —con la válvula abierta— lo deja pasar dejando rastro.
   * @returns `true` si el handler debe cortar aquí.
   */
  const reject = (status: number, message: string, reason: string, meta: Record<string, unknown>): boolean => {
    if (strictAuth) {
      res.status(status).json({ success: false, action: 'ERROR', message })
      return true
    }
    logger.error('🚨 [B4Bit webhook] HABRÍA RECHAZADO — B4BIT_STRICT_WEBHOOK_AUTH=false', {
      reason,
      wouldHaveStatus: status,
      ...meta,
    })
    return false
  }

  try {
    const nonce = req.headers['x-nonce'] as string | undefined
    const signature = req.headers['x-signature'] as string | undefined

    // ── 1 · BYTES CRUDOS ──────────────────────────────────────────────────────
    // B4Bit serializa con `requests` de Python: su cuerpo lleva un espacio tras
    // cada `,` y cada `:`. Re-serializar con `JSON.stringify` produce OTRO HMAC,
    // así que un cuerpo ya parseado NO se puede verificar — no es una vía
    // alterna de validación, es una trampa.
    if (!Buffer.isBuffer(req.body)) {
      logger.warn('🚫 [B4Bit webhook] el body no llegó como Buffer — sin los bytes originales no se puede verificar la firma', {
        bodyType: typeof req.body,
        contentType: req.headers['content-type'],
      })
      if (reject(400, 'Invalid body: raw bytes required', 'non-buffer body', { contentType: req.headers['content-type'] })) return
    }

    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    const payload: B4BitWebhookPayload = Buffer.isBuffer(req.body) || typeof req.body === 'string' ? JSON.parse(body) : req.body

    logger.info('📥 B4Bit webhook received', {
      identifier: payload.identifier,
      status: payload.status,
      hasSignature: !!signature,
      hasNonce: !!nonce,
    })

    // ── 2 · HEADERS DE FIRMA ──────────────────────────────────────────────────
    if (!signature || !nonce) {
      logger.warn('🚫 [B4Bit webhook] faltan los headers de firma', {
        identifier: payload.identifier,
        hasSignature: !!signature,
        hasNonce: !!nonce,
      })
      if (reject(401, 'Missing signature headers', 'missing signature headers', { identifier: payload.identifier })) return
    }

    // ── 3 · SECRETO DEL VENUE ─────────────────────────────────────────────────
    const secret = await resolveVenueWebhookSecret(payload.reference)

    if (!secret) {
      // Fuera de producción se puede trabajar sin secreto, pero SÓLO con un flag
      // explícito: nunca por ausencia de configuración (así es como el agujero
      // terminó activo en prod).
      const allowUnsigned = !isProduction && process.env.B4BIT_ALLOW_UNSIGNED_WEBHOOKS === 'true'

      if (allowUnsigned) {
        logger.warn('⚠️ [B4Bit webhook] SIN SECRET — aceptado por B4BIT_ALLOW_UNSIGNED_WEBHOOKS (nunca en producción)', {
          identifier: payload.identifier,
          reference: payload.reference,
        })
      } else {
        // 🚨 greppable a propósito: las alertas de este repo son por UMBRAL, así
        // que un evento único tiene que poder buscarse a mano.
        logger.error('🚨 [B4Bit webhook] SIN SECRET — webhook RECHAZADO', {
          identifier: payload.identifier,
          reference: payload.reference,
          nodeEnv: process.env.NODE_ENV,
          action: 'cargar b4bitSecretKey del venue en VenueCryptoConfig (B4Bit NO reintenta este webhook)',
        })
        if (reject(503, 'Webhook secret not provisioned', 'missing venue secret', { identifier: payload.identifier })) return
      }
    } else if (signature && nonce) {
      // ── 4 · FIRMA ───────────────────────────────────────────────────────────
      if (!verifyWebhookSignature(nonce, body, signature, secret)) {
        logger.warn('🚫 [B4Bit webhook] firma inválida', { identifier: payload.identifier })
        if (reject(401, 'Invalid signature', 'invalid signature', { identifier: payload.identifier })) return
      }
    }

    // ── 5 · FRESCURA DEL NONCE (anti-replay) ──────────────────────────────────
    if (nonce) {
      const nonceMs = parseInt(nonce, 10) * 1000
      const ageMs = Math.abs(Date.now() - nonceMs)

      if (!Number.isFinite(nonceMs) || ageMs > NONCE_MAX_SKEW_MS) {
        logger.warn('🚫 [B4Bit webhook] nonce fuera de la ventana permitida', {
          identifier: payload.identifier,
          nonce,
          ageMs: Number.isFinite(ageMs) ? ageMs : null,
          toleranceMs: NONCE_MAX_SKEW_MS,
        })
        if (reject(401, 'Stale or invalid nonce', 'stale nonce', { identifier: payload.identifier, nonce })) return
      }
    }

    // ── 6 · CAMPOS OBLIGATORIOS ───────────────────────────────────────────────
    if (!payload.identifier) {
      logger.warn('⚠️ B4Bit webhook: Missing identifier', { payload })
      res.status(200).json({
        success: false,
        action: 'ERROR',
        message: 'Missing identifier field',
      })
      return
    }

    if (!payload.status) {
      logger.warn('⚠️ B4Bit webhook: Missing status', { payload })
      res.status(200).json({
        success: false,
        action: 'ERROR',
        message: 'Missing status field',
      })
      return
    }

    // ── 7 · PROCESAR ──────────────────────────────────────────────────────────
    const result = await processWebhook(payload)

    const duration = Date.now() - startTime
    logger.info(`✅ B4Bit webhook processed in ${duration}ms`, {
      identifier: payload.identifier,
      action: result.action,
      paymentId: result.paymentId,
    })

    res.status(200).json(result)
  } catch (error: any) {
    const duration = Date.now() - startTime
    logger.error('❌ B4Bit webhook error', {
      error: error.message,
      stack: error.stack,
      duration,
    })

    // Un webhook YA autenticado que revienta al procesarse responde 200: B4Bit no
    // reintenta, así que un 5xx sólo perdería el evento sin arreglar nada.
    res.status(200).json({
      success: false,
      action: 'ERROR',
      message: error.message || 'Internal error processing webhook',
    })
  }
}

/**
 * GET /api/v1/webhooks/b4bit/health
 *
 * Health check endpoint for B4Bit to verify webhook connectivity.
 */
export async function b4bitWebhookHealthCheck(req: Request, res: Response): Promise<void> {
  res.status(200).json({
    success: true,
    message: 'B4Bit webhook endpoint is healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  })
}
