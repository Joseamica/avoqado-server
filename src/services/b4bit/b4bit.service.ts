/**
 * B4Bit Crypto Payment Service
 *
 * Integration with B4Bit crypto payment gateway for accepting cryptocurrency payments.
 * Supports 13 cryptocurrencies including BTC, ETH, USDT, USDC, etc.
 *
 * Authentication (per https://docs.b4bit.com/pay/api/autenticacion/):
 * - Only header required: `X-Device-Id: <api-key-uuid4>`
 * - No login/signIn endpoint exists. No Authorization header is used
 * - `secretKey` is used ONLY for webhook HMAC signature validation — never sent
 *
 * Per-venue credentials (deviceId + secretKey) live in `VenueCryptoConfig`.
 * Minimum chargeable amount: $20.00 MXN (B4Bit business rule).
 */

import { PaymentMethod, Prisma } from '@prisma/client'
import crypto from 'crypto'
import { socketManager } from '../../communication/sockets/managers/socketManager'
import { SocketEventType } from '../../communication/sockets/types'
import logger from '../../config/logger'
import { BadRequestError, InternalServerError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { applySalePosting, createSalePostingInTx } from '../inventory/inventoryPosting.service'
import { computeOrderBalance } from '../shared/orderBalance'
import {
  claimShiftForCapturedPayment,
  lockExistingOrderForPayment,
  recordPendingPaymentShiftReconciliation,
  resolvePaymentShiftReconciliationEnabled,
} from '../shared/paymentShiftClaim'
import { turnoAbiertoDelNegocio } from '../shared/turnoDeCaja'
import { generateDigitalReceipt, generateReceiptUrl } from '../tpv/digitalReceipt.tpv.service'
import { assertVenueSalesEnabled } from '../venueSalesGuard'
import type {
  B4BitConfig,
  B4BitCreateOrderRequest,
  B4BitCreateOrderResponse,
  B4BitGlobalConfig,
  B4BitPaymentStatus,
  B4BitVenueConfig,
  B4BitWebhookPayload,
  InitiateCryptoPaymentParams,
  InitiateCryptoPaymentResult,
  ProcessWebhookResult,
} from './types'

// B4Bit API base URL by environment (no env vars needed — no login endpoint either)
const isProduction = process.env.NODE_ENV === 'production'
const B4BIT_BASE_URL = isProduction ? 'https://pos.b4bit.com' : 'https://dev-payments.b4bit.com'

// Minimum chargeable amount: $20 MXN (B4Bit business rule).
// Expressed in centavos to match the `amount` param used across the payment layer.
const B4BIT_MINIMUM_AMOUNT_CENTAVOS = 2000

// An order above this size is operationally abnormal. Read one extra row so the
// inventory posting fails visibly instead of silently omitting order items.
const MAX_B4BIT_INVENTORY_POSTING_ITEMS = 1_000

const getB4BitGlobalConfig = (): B4BitGlobalConfig => {
  return { baseUrl: B4BIT_BASE_URL }
}

/**
 * Get per-venue B4Bit device config from database.
 * Falls back to env vars for backwards compatibility during migration.
 */
async function getVenueCryptoConfig(venueId: string): Promise<B4BitVenueConfig> {
  const config = await prisma.venueCryptoConfig.findUnique({
    where: { venueId },
    select: { b4bitDeviceId: true, b4bitSecretKey: true, status: true },
  })

  if (config && config.status === 'ACTIVE') {
    return { deviceId: config.b4bitDeviceId, secretKey: config.b4bitSecretKey }
  }

  // Fallback to env vars (backwards compatibility)
  const envDeviceId = process.env.B4BIT_DEVICE_ID
  const envSecret = process.env.B4BIT_WEBHOOK_SECRET
  if (envDeviceId) {
    logger.debug('Using fallback env B4BIT_DEVICE_ID for venue', { venueId })
    return { deviceId: envDeviceId, secretKey: envSecret }
  }

  throw new BadRequestError('Crypto payments not configured for this venue')
}

/**
 * @deprecated Use getB4BitGlobalConfig + getVenueCryptoConfig instead
 */
const _getB4BitConfig = (): B4BitConfig => {
  const global = getB4BitGlobalConfig()
  return {
    ...global,
    deviceId: process.env.B4BIT_DEVICE_ID || '',
    webhookSecret: process.env.B4BIT_WEBHOOK_SECRET,
  }
}

/**
 * Check if B4Bit mock mode is enabled for development/testing
 * Set B4BIT_MOCK=true to enable mock responses
 */
const _isB4BitMockEnabled = (): boolean => {
  return process.env.B4BIT_MOCK === 'true'
}

/**
 * Create a crypto payment order with B4Bit
 *
 * B4Bit API uses:
 * - Endpoint: POST /api/v1/orders/
 * - Auth: X-Device-Id header only (no login, no Authorization header)
 * - Content-Type: multipart/form-data
 * - Main param: expected_output_amount (fiat amount)
 *
 * @param request Order creation parameters
 * @returns Order data including payment URL for QR generation
 */
async function createPaymentOrder(request: B4BitCreateOrderRequest & { venueId: string }): Promise<B4BitCreateOrderResponse> {
  const globalConfig = getB4BitGlobalConfig()
  const venueConfig = await getVenueCryptoConfig(request.venueId)
  const url = `${globalConfig.baseUrl}/api/v1/orders/`

  logger.info('🔗 B4Bit: Creating crypto payment order', {
    fiatAmount: request.fiat_amount,
    currency: request.fiat_currency,
    identifier: request.identifier,
    venueId: request.venueId,
  })

  try {
    logger.debug('🔗 B4Bit: Calling API', { url, hasDeviceId: !!venueConfig.deviceId })

    // Build form data (B4Bit API expects multipart/form-data)
    // Per https://docs.b4bit.com/pay/api/endpoints/orders-create/ the field is `fiat` (not fiat_currency/output_currency).
    const formData = new FormData()
    formData.append('expected_output_amount', request.fiat_amount.toString())
    formData.append('fiat', request.fiat_currency || 'MXN')
    if (request.identifier) {
      formData.append('reference', request.identifier)
    }
    if (request.notify_merchant_url) {
      // B4Bit uses merchant_urlok/urlko for redirects, webhook is configured in dashboard
      formData.append('notes', `Avoqado Payment - Ref: ${request.identifier}`)
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Device-Id': venueConfig.deviceId,
      },
      body: formData,
    })

    // Check if response is JSON before parsing
    const contentType = response.headers.get('content-type') || ''
    const responseText = await response.text()

    if (!contentType.includes('application/json')) {
      logger.error('❌ B4Bit: Non-JSON response received', {
        status: response.status,
        contentType,
        responsePreview: responseText.substring(0, 200),
        url,
      })
      return {
        success: false,
        error: {
          code: 'INVALID_RESPONSE',
          message: `B4Bit API returned non-JSON response (${response.status}). Check API URL and credentials.`,
        },
      }
    }

    let data: any
    try {
      data = JSON.parse(responseText)
    } catch {
      logger.error('❌ B4Bit: Failed to parse JSON response', {
        status: response.status,
        responsePreview: responseText.substring(0, 200),
      })
      return {
        success: false,
        error: {
          code: 'PARSE_ERROR',
          message: 'Failed to parse B4Bit API response',
        },
      }
    }

    if (!response.ok) {
      logger.error('❌ B4Bit: Order creation failed', {
        status: response.status,
        error: data,
      })
      return {
        success: false,
        error: {
          code: data.code || 'UNKNOWN_ERROR',
          message: data.message || 'Error creating crypto payment order',
        },
      }
    }

    // B4Bit response fields:
    // - identifier: UUID for the payment
    // - web_url: URL for redirect gateway (customer opens this to select crypto and pay)
    // - address: Crypto address (if input_currency was specified)
    // - expected_input_amount: Crypto amount (if input_currency was specified)
    // - input_currency: Crypto symbol (if specified)
    logger.info('✅ B4Bit: Order created successfully', {
      identifier: data.identifier,
      webUrl: data.web_url,
      address: data.address,
    })

    return {
      success: true,
      data: {
        request_id: data.identifier, // B4Bit uses 'identifier'
        payment_url: data.web_url, // B4Bit uses 'web_url' for the payment gateway
        crypto_address: data.address,
        crypto_amount: data.expected_input_amount,
        crypto_symbol: data.input_currency,
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // B4Bit doesn't return expiry, default 15 min
        expires_in_seconds: 900, // Default 15 minutes
      },
    }
  } catch (error: any) {
    logger.error('❌ B4Bit: Network error creating order', {
      error: error.message,
      stack: error.stack,
    })
    return {
      success: false,
      error: {
        code: 'NETWORK_ERROR',
        message: error.message || 'Failed to connect to B4Bit API',
      },
    }
  }
}

/**
 * Initiate a crypto payment from TPV
 *
 * Creates a pending payment record in database and requests a crypto order from B4Bit.
 *
 * @param params Payment parameters from TPV
 * @returns Payment URL and tracking information
 */
export async function initiateCryptoPayment(params: InitiateCryptoPaymentParams): Promise<InitiateCryptoPaymentResult> {
  const { venueId, amount, tip = 0, staffId, orderId, orderNumber, deviceSerialNumber, rating } = params
  await assertVenueSalesEnabled(venueId)

  // Convert centavos to decimal (5500 centavos = $55.00 MXN)
  const totalAmount = amount + tip
  const fiatAmount = totalAmount / 100

  // B4Bit minimum charge: $20 MXN. Reject below threshold before hitting their API
  // (they return a confusing validation error otherwise).
  if (totalAmount < B4BIT_MINIMUM_AMOUNT_CENTAVOS) {
    throw new BadRequestError(`El monto mínimo para pagar con cripto es $${B4BIT_MINIMUM_AMOUNT_CENTAVOS / 100} MXN`)
  }

  logger.info('🚀 Initiating crypto payment', {
    venueId,
    amount,
    tip,
    totalAmount,
    fiatAmount,
    staffId,
    orderId,
  })

  // 🔴 AISLAMIENTO DE TENANT: el turno NO lo elige el cliente.
  //
  // Aquí se validaba el turno de la petición con `shift.findUnique({ where: { id } })` — SIN
  // `venueId` — y ese mismo id acababa en el `Payment`: el venue A podía mandar un turno abierto
  // del venue B y su cobro salía del corte de A para sumarse al de B. La regla dura del repo no
  // admite matices: toda consulta filtra por `venueId`.
  //
  // Ahora el turno se resuelve UNA sola vez por negocio, dentro de la transacción, y ese id va a
  // la `Order` Y al `Payment` todavía PENDING. Es atribución provisional de iniciación: cuando
  // B4Bit confirma el dinero real, `Payment.shiftId` se finaliza de nuevo dentro de su CAS;
  // `Order.shiftId` conserva a propósito la historia operativa de creación.
  //
  // El turno que llegue en la petición se IGNORA en silencio, no se rechaza: hoy no lo manda
  // nadie (`CryptoPaymentRequest` de avoqado-tpv ni siquiera declara el campo) y rechazar lo que
  // no cuadra rompería a las PAX ya instaladas, que no se actualizan a la vez que el servidor. El
  // esquema Zod lo sigue aceptando, así que una petición que lo traiga nunca se vuelve un 400.

  // Resolve terminal ID from device serial number
  let terminalId: string | null = null
  if (deviceSerialNumber) {
    const terminal = await prisma.terminal.findFirst({
      where: {
        venueId,
        serialNumber: deviceSerialNumber,
      },
      select: { id: true },
    })
    terminalId = terminal?.id || null
  }

  // Create payment and order in a transaction (atomic)
  const { payment, turnoProvisional } = await prisma.$transaction(async tx => {
    // For crypto payments without an existing order, create a "fast order" (placeholder)
    let orderIdToUse = orderId

    // 🔴 TENANT + ESTADO. El `orderId` llegaba del cliente y se usaba TAL CUAL:
    // el schema sólo exige que sea un CUID, así que se podía enganchar un cobro
    // cripto a la cuenta de OTRO negocio, o a una cuenta ya cerrada. El filtro por
    // `venueId` es lo que hace que una orden ajena simplemente no exista aquí.
    if (orderIdToUse) {
      const targetOrder = await tx.order.findUnique({
        where: { id: orderIdToUse, venueId },
        select: { id: true, status: true, paymentStatus: true },
      })

      if (!targetOrder) {
        throw new BadRequestError('La cuenta no existe o no pertenece a esta sucursal')
      }
      if (targetOrder.paymentStatus === 'PAID') {
        throw new BadRequestError('La cuenta ya está pagada')
      }
      if (targetOrder.status === 'CANCELLED' || targetOrder.status === 'DELETED') {
        throw new BadRequestError('La cuenta está cancelada y no admite cobros')
      }
    }

    // 🔴 EL TURNO PROVISIONAL, UNA SOLA VEZ, PARA LOS DOS REGISTROS DE AQUÍ.
    //
    // El turno de caja es del NEGOCIO, no de la persona ni del aparato (`../shared/turnoDeCaja.ts`,
    // decisión del founder del 2-sep-2026), y se resuelve con el cliente de la transacción. La orden
    // testigo y el pago pendiente arrancan con el MISMO id: si cada uno lo resolviera por su cuenta,
    // la iniciación misma podría partirse entre turnos. Al confirmar puede moverse sólo
    // `Payment.shiftId`, porque ahí el dinero se vuelve real; `Order.shiftId` no se reescribe.
    //
    // `null` es un desenlace legítimo: un negocio sin turno abierto sigue vendiendo, y el cobro se
    // registra sin turno — nunca en uno ajeno ni en uno cerrado.
    const turnoDelNegocio = await turnoAbiertoDelNegocio(tx, venueId)

    if (!orderIdToUse) {
      // Generate order number
      const orderNumberGenerated = orderNumber || `CRYPTO-${Date.now()}`

      // Create fast order for crypto payment
      const newOrder = await tx.order.create({
        data: {
          venueId,
          shiftId: turnoDelNegocio?.id ?? null,
          orderNumber: orderNumberGenerated,
          type: 'TAKEOUT',
          source: 'TPV',
          terminalId,
          status: 'PENDING', // Will be updated to COMPLETED when payment confirms
          subtotal: amount / 100, // Convert centavos to decimal
          taxAmount: 0,
          total: totalAmount / 100,
          tipAmount: tip / 100,
          paidAmount: 0, // Will be updated when payment confirms
          remainingBalance: totalAmount / 100,
          paymentStatus: 'PENDING',
          splitType: 'FULLPAYMENT',
          createdById: staffId,
          servedById: staffId,
        },
      })

      orderIdToUse = newOrder.id
      logger.info('📦 Created placeholder order for crypto payment', {
        orderId: newOrder.id,
        orderNumber: newOrder.orderNumber,
      })
    }

    // Create pending payment record
    const newPayment = await tx.payment.create({
      data: {
        venueId,
        orderId: orderIdToUse,
        amount: amount / 100, // Convert centavos to decimal
        tipAmount: tip / 100,
        method: PaymentMethod.CRYPTOCURRENCY,
        status: 'PENDING',
        source: 'TPV',
        type: 'FAST',
        processor: 'B4BIT',
        processedById: staffId,
        // El MISMO turno provisional que llevó la orden: nunca el que mandó el cliente.
        shiftId: turnoDelNegocio?.id ?? null,
        terminalId,
        feePercentage: 0.0095, // B4Bit 0.95% fee
        feeAmount: (totalAmount / 100) * 0.0095,
        netAmount: (totalAmount / 100) * (1 - 0.0095),
        posRawData: {
          cryptoProvider: 'B4BIT',
          initiatedAt: new Date().toISOString(),
          rating,
          deviceSerialNumber,
        },
      },
    })

    return { payment: newPayment, fastOrder: orderIdToUse !== orderId ? orderIdToUse : null, turnoProvisional: turnoDelNegocio?.id ?? null }
  })

  logger.info('💾 Created pending crypto payment', { paymentId: payment.id, turnoProvisional })

  // Create order with B4Bit
  const webhookUrl = `${process.env.API_BASE_URL || 'https://api.avoqado.io'}/api/v1/webhooks/b4bit`

  const b4bitResponse = await createPaymentOrder({
    venueId,
    fiat_amount: fiatAmount,
    fiat_currency: 'MXN',
    identifier: payment.id, // Use our payment ID as reference
    notify_merchant_url: webhookUrl,
  })

  if (!b4bitResponse.success || !b4bitResponse.data) {
    // Mark payment as failed
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: 'FAILED',
        processorData: {
          cryptoProvider: 'B4BIT',
          error: b4bitResponse.error?.message || 'Unknown error',
          failedAt: new Date().toISOString(),
        },
      },
    })

    throw new InternalServerError(b4bitResponse.error?.message || 'Error al crear orden de pago crypto')
  }

  // Update payment with B4Bit tracking info
  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      externalId: b4bitResponse.data.request_id, // B4Bit request ID for tracking
      processorId: b4bitResponse.data.request_id,
      processorData: {
        cryptoProvider: 'B4BIT',
        requestId: b4bitResponse.data.request_id,
        paymentUrl: b4bitResponse.data.payment_url,
        expiresAt: b4bitResponse.data.expires_at,
        cryptoSymbol: b4bitResponse.data.crypto_symbol,
        cryptoAddress: b4bitResponse.data.crypto_address,
        initiatedAt: new Date().toISOString(),
      },
    },
  })

  // Emit Socket.IO event for real-time tracking
  socketManager.broadcastToVenue(venueId, SocketEventType.PAYMENT_INITIATED, {
    correlationId: payment.id,
    timestamp: new Date(),
    venueId,
    paymentId: payment.id,
    amount: totalAmount,
    currency: 'MXN',
    status: 'initiated',
    metadata: {
      method: 'CRYPTOCURRENCY',
      provider: 'B4BIT',
      requestId: b4bitResponse.data.request_id,
    },
  })

  return {
    success: true,
    requestId: b4bitResponse.data.request_id,
    paymentId: payment.id,
    paymentUrl: b4bitResponse.data.payment_url,
    expiresAt: b4bitResponse.data.expires_at,
    expiresInSeconds: b4bitResponse.data.expires_in_seconds,
    cryptoSymbol: b4bitResponse.data.crypto_symbol,
    cryptoAddress: b4bitResponse.data.crypto_address,
    // Campo aditivo y opcional: el turno abierto cuando se INICIÓ el intento (`null` = ninguno).
    // Es provisional por compatibilidad; la atribución final del dinero se decide al confirmar
    // y su fuente de verdad es `Payment.shiftId` una vez que el pago queda COMPLETED.
    shiftId: turnoProvisional,
  }
}

/**
 * Verify B4Bit webhook signature
 *
 * B4Bit signs webhooks with HMAC-SHA256:
 * signature = hex(hmac_sha256(secret_bytes, nonce + body))
 *
 * 🔴 Esta función SÓLO contesta "¿la firma cuadra?". Qué hacer cuando no hay
 * secreto es una decisión del controlador (rechazar con 503), no de aquí: antes
 * devolvía `true` sin secreto y eso convertía a cualquier venue sin
 * `b4bitSecretKey` en una puerta abierta.
 *
 * @param nonce X-NONCE header (unix timestamp en segundos)
 * @param body Cuerpo CRUDO tal como llegó — B4Bit lo genera con `requests` de
 *   Python (espacio tras `,` y `:`), así que re-serializarlo cambia el HMAC.
 * @param signature X-SIGNATURE header
 * @returns true sólo si la firma es válida
 */
export function verifyWebhookSignature(nonce: string, body: string, signature: string, webhookSecret?: string | null): boolean {
  const secret = webhookSecret || process.env.B4BIT_WEBHOOK_SECRET

  if (!secret) {
    logger.warn('⚠️ B4Bit: sin secreto para verificar la firma del webhook — se rechaza')
    return false
  }
  if (!signature || !nonce) return false

  // B4Bit documentation: X-SIGNATURE = hexadecimal(hmac_sha256(merchant_secret_key, nonce + body))
  // The merchant_secret_key must be converted from hex string to bytes
  const secretBytes = Buffer.from(secret, 'hex')
  const message = nonce + body
  const expectedSignature = crypto.createHmac('sha256', secretBytes).update(message).digest('hex')

  // 🔴 Comparación en TIEMPO CONSTANTE (mismo patrón que el webhook de AngelPay).
  // La guarda de longitud no es cosmética: `timingSafeEqual` LANZA si los buffers
  // miden distinto, y una firma corta tumbaría el handler con un 500.
  const matches =
    expectedSignature.length === signature.length && crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature))

  if (matches) {
    logger.info('✅ B4Bit webhook signature verified')
    return true
  }

  // Signature mismatch
  logger.warn('⚠️ B4Bit webhook signature verification failed', {
    receivedLength: signature.length,
    expectedLength: expectedSignature.length,
  })

  return false
}

/**
 * `edited_at` en milisegundos, o `null` si no es una fecha usable.
 *
 * 🔑 La validación es lo que impide que una basura se guarde como marca de agua:
 * a partir de ahí toda comparación da `NaN` (siempre `false`) y la protección
 * contra webhooks fuera de orden queda apagada para ese pago, en silencio.
 */
function parseEditedAtMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** El `edited_at` del payload sólo si es una fecha válida (si no, `undefined`). */
function validEditedAt(payload: B4BitWebhookPayload): string | undefined {
  return parseEditedAtMs(payload.edited_at) !== null ? payload.edited_at : undefined
}

/**
 * Serializes every terminal B4Bit transition on the Payment row itself.
 *
 * The tenant predicate is part of the lock, not merely the later ORM read: a
 * stale webhook may never obtain authority over a row from another venue.
 */
async function lockB4BitPaymentRow(tx: Prisma.TransactionClient, paymentId: string, venueId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Payment" WHERE id = ${paymentId} AND "venueId" = ${venueId} FOR UPDATE`
  if (rows.length === 0) throw new Error(`B4Bit payment ${paymentId} no longer exists for venue ${venueId}`)
}

/**
 * Merges provider metadata only when the incoming durable watermark is not
 * older than the one read while holding the Payment row lock.
 */
function mergeB4BitProcessorData(
  current: Prisma.JsonValue,
  patch: Prisma.InputJsonObject,
): { processorData: Prisma.InputJsonObject; ignoredAsOutOfOrder: boolean } {
  const currentObject = typeof current === 'object' && current !== null && !Array.isArray(current) ? (current as Prisma.JsonObject) : {}
  const incomingEditedAtMs = parseEditedAtMs(patch.lastEditedAt)
  const durableEditedAtMs = parseEditedAtMs(currentObject.lastEditedAt)

  if (incomingEditedAtMs !== null && durableEditedAtMs !== null && incomingEditedAtMs < durableEditedAtMs) {
    return { processorData: currentObject as Prisma.InputJsonObject, ignoredAsOutOfOrder: true }
  }

  return {
    processorData: { ...currentObject, ...patch } as Prisma.InputJsonObject,
    ignoredAsOutOfOrder: false,
  }
}

type B4BitFailureTransition = 'FAILED' | 'COMPLETED' | 'IGNORED'

/**
 * Applies OC/EX while holding the same row lock used by CO.
 *
 * A stale outer Payment snapshot is deliberately not consulted. If CO committed
 * first, the failure is recorded as late metadata without touching status. If
 * this webhook is older than the durable watermark, it is discarded entirely.
 */
async function failB4BitPaymentInTx(
  tx: Prisma.TransactionClient,
  payment: { id: string; venueId: string },
  status: 'OC' | 'EX',
  failReason: string,
  editedAt?: string,
): Promise<B4BitFailureTransition> {
  await lockB4BitPaymentRow(tx, payment.id, payment.venueId)
  const freshPayment = await tx.payment.findUnique({
    where: { id: payment.id, venueId: payment.venueId },
    select: { status: true, processorData: true },
  })
  if (!freshPayment) throw new Error(`B4Bit payment ${payment.id} no longer exists for venue ${payment.venueId}`)

  const now = new Date().toISOString()
  const terminalPatch: Prisma.InputJsonObject = {
    ...(editedAt ? { lastEditedAt: editedAt } : {}),
    lastStatus: status,
    ...(freshPayment.status === 'COMPLETED'
      ? { lateFailureIgnored: true, lateFailureReason: failReason, lateFailureAt: now }
      : { failReason, failedAt: now }),
  }
  const merged = mergeB4BitProcessorData(freshPayment.processorData, terminalPatch)
  if (merged.ignoredAsOutOfOrder) return 'IGNORED'

  if (freshPayment.status === 'COMPLETED') {
    await tx.payment.update({
      where: { id: payment.id, venueId: payment.venueId },
      data: { processorData: merged.processorData },
    })
    return 'COMPLETED'
  }

  const transition = await tx.payment.updateMany({
    where: { id: payment.id, venueId: payment.venueId, status: { not: 'COMPLETED' } },
    data: { status: 'FAILED', processorData: merged.processorData },
  })
  if (transition.count !== 1) {
    const conflict: Error & { code?: string } = new Error('B4BIT_FAILURE_TRANSITION_LOST')
    conflict.code = 'B4BIT_FAILURE_TRANSITION_LOST'
    throw conflict
  }

  return 'FAILED'
}

/**
 * Process B4Bit webhook notification
 *
 * Called when B4Bit sends a payment status update.
 *
 * @param payload Webhook payload from B4Bit
 * @returns Processing result
 */
export async function processWebhook(payload: B4BitWebhookPayload): Promise<ProcessWebhookResult> {
  // B4Bit returns:
  // - identifier: B4Bit's internal UUID
  // - reference: Our payment ID (what we passed when creating the order)
  const { identifier: b4bitId, reference: paymentId, status, crypto_amount, currency, tx_hash, confirmations } = payload

  logger.info('📥 B4Bit webhook received', {
    b4bitId,
    paymentId,
    status,
    cryptoAmount: crypto_amount,
    currency,
    txHash: tx_hash,
    confirmations,
  })

  // Find the payment by our internal ID (reference field from B4Bit)
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      order: {
        select: {
          id: true,
          orderNumber: true,
          tableId: true,
        },
      },
      venue: {
        select: {
          id: true,
          name: true,
          organizationId: true,
        },
      },
    },
  })

  if (!payment) {
    logger.warn('⚠️ B4Bit webhook: Payment not found', { paymentId })
    return {
      success: false,
      action: 'NOT_FOUND',
      message: `Payment ${paymentId} not found`,
    }
  }

  const venueId = payment.venueId
  const processorData = typeof payment.processorData === 'object' && payment.processorData !== null ? (payment.processorData as any) : {}

  // ── ORDEN DE ENTREGA ────────────────────────────────────────────────────────
  // B4Bit no garantiza el orden y pide descartar el webhook viejo comparando
  // `edited_at`. Sin esto, un `AC` rezagado puede pisar el estado que dejó el
  // `CO` que llegó antes.
  //
  // 🔑 Un `edited_at` que no sea una fecha de verdad se trata como AUSENTE, y
  // sobre todo NO se guarda: una vez que la marca de agua es basura, toda
  // comparación futura da `NaN` (siempre `false`) y la protección de orden queda
  // apagada para ese pago, **en silencio**.
  const incomingEditedAtMs = parseEditedAtMs(payload.edited_at)
  const lastEditedAtMs = parseEditedAtMs(processorData.lastEditedAt)

  if (payload.edited_at !== undefined && incomingEditedAtMs === null) {
    logger.warn('⚠️ [B4Bit] `edited_at` inválido en el payload — se ignora y NO se guarda como marca de agua', {
      paymentId: payment.id,
      venueId,
      status,
      editedAt: payload.edited_at,
    })
  }

  if (incomingEditedAtMs !== null && lastEditedAtMs !== null && incomingEditedAtMs < lastEditedAtMs) {
    logger.warn('⚠️ [B4Bit] webhook FUERA DE ORDEN ignorado — su `edited_at` es anterior al último aplicado', {
      paymentId: payment.id,
      venueId,
      status,
      editedAt: payload.edited_at,
      lastEditedAt: processorData.lastEditedAt,
    })
    return {
      success: true,
      action: 'IGNORED',
      message: 'Webhook fuera de orden: edited_at anterior al último aplicado',
      paymentId: payment.id,
      details: { status },
    }
  }

  /** Se guarda junto con cada estado aplicado para poder descartar los viejos. */
  const applicableEditedAt = validEditedAt(payload)
  const editedAtPatch = applicableEditedAt ? { lastEditedAt: applicableEditedAt } : {}

  // Process based on status
  switch (status) {
    case 'CO': // Completed - Payment confirmed
      return await handlePaymentConfirmed(payment, payload, await resolvePaymentShiftReconciliationEnabled(prisma, venueId))

    case 'AC': // Awaiting Completion - Payment detected, waiting for confirmations
      // Update processorData and emit progress event
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          processorData: {
            ...processorData,
            ...editedAtPatch,
            lastStatus: 'AC',
            cryptoAmount: crypto_amount,
            cryptoCurrency: currency,
            unconfirmedAt: new Date().toISOString(),
          },
        },
      })

      socketManager.broadcastToVenue(venueId, SocketEventType.PAYMENT_PROCESSING, {
        correlationId: payment.id,
        timestamp: new Date(),
        venueId,
        paymentId: payment.id,
        amount: payment.amount,
        currency: 'MXN',
        status: 'processing',
        metadata: {
          method: PaymentMethod.CRYPTOCURRENCY,
          cryptoStatus: 'AWAITING_CONFIRMATIONS',
          cryptoAmount: crypto_amount,
          cryptoCurrency: currency,
        },
      })

      return {
        success: true,
        action: 'AWAITING_CONFIRMATION',
        message: 'Payment detected, awaiting blockchain confirmations',
        paymentId: payment.id,
        details: {
          status,
          cryptoAmount: crypto_amount,
          cryptoCurrency: currency,
        },
      }

    case 'OC': // Out of Condition - Insufficient amount
    case 'EX': // Expired
      const failReason = status === 'OC' ? 'Monto insuficiente' : 'Orden expirada'

      // 🔴 MONEY — CO, OC y EX se ordenan bajo el MISMO lock de Payment. La
      // lectura exterior puede ser PENDING aunque CO ya haya commiteado; sólo la
      // relectura tenant-scoped bajo FOR UPDATE decide qué estado puede escribirse.
      const failureTransition = await prisma.$transaction(tx => failB4BitPaymentInTx(tx, payment, status, failReason, applicableEditedAt))

      if (failureTransition === 'IGNORED') {
        logger.warn('⚠️ [B4Bit] webhook FUERA DE ORDEN ignorado dentro de la transición terminal', {
          paymentId: payment.id,
          venueId,
          status,
          editedAt: payload.edited_at,
        })
        return {
          success: true,
          action: 'IGNORED',
          message: 'Webhook fuera de orden: edited_at anterior al último aplicado',
          paymentId: payment.id,
          details: { status },
        }
      }

      if (failureTransition === 'COMPLETED') {
        logger.warn('⚠️ [B4Bit] estado tardío ignorado — el cobro ya estaba COMPLETED y no se degrada', {
          paymentId: payment.id,
          venueId,
          orderId: payment.orderId,
          status,
          failReason,
        })

        // Sin `crypto:payment_failed`: decirle a la terminal que falló un cobro
        // que el cliente YA pagó la llevaría a cobrarlo otra vez.
        return {
          success: true,
          action: 'CONFIRMED',
          message: `Estado tardío ${status} ignorado: el cobro ya estaba confirmado`,
          paymentId: payment.id,
          details: {
            status,
            cryptoAmount: crypto_amount,
            cryptoCurrency: currency,
          },
        }
      }

      // Emit CRYPTO_PAYMENT_FAILED event
      socketManager.broadcastToVenue(venueId, 'crypto:payment_failed' as SocketEventType, {
        correlationId: payment.id,
        timestamp: new Date(),
        venueId,
        requestId: payment.externalId,
        paymentId: payment.id,
        reason: failReason,
        status,
      })

      return {
        success: true,
        action: status === 'OC' ? 'FAILED' : 'EXPIRED',
        message: failReason,
        paymentId: payment.id,
        details: {
          status,
          cryptoAmount: crypto_amount,
          cryptoCurrency: currency,
        },
      }

    case 'PE': // Pending - Still waiting for payment
      logger.info('ℹ️ B4Bit: Payment still pending', { paymentId: payment.id })
      return {
        success: true,
        action: 'AWAITING_CONFIRMATION',
        message: 'Payment still pending',
        paymentId: payment.id,
        details: { status },
      }

    default:
      logger.warn('⚠️ B4Bit: Unknown status', { status, paymentId: payment.id })
      return {
        success: false,
        action: 'ERROR',
        message: `Unknown status: ${status}`,
        details: { status },
      }
  }
}

/** Resultado de liquidar la orden tras confirmarse un cobro cripto. */
interface CryptoSettlementResult {
  isFullyPaid: boolean
  /** `true` SÓLO si esta ejecución fue la que llevó la cuenta de abierta a pagada. */
  becamePaid: boolean
  paidAmount: string
  remainingBalance: string
  /**
   * Motivo por el que el saldo de la orden NO se recalculó. El `Payment` SÍ queda
   * COMPLETED: el dinero llegó de verdad y no se puede perder.
   *
   * Ya sólo queda un motivo. `ORDER_HAS_REFUND` desapareció el 2026-08-18: una
   * cuenta con reembolsos SÍ se recalcula, porque la aritmética canónica excluye
   * los `Payment` `type: REFUND` y el recálculo devuelve el mismo saldo.
   */
  balanceSkipped?: 'ORDER_NOT_CHARGEABLE'
  /**
   * El vale de inventario que nació con la transición a pagado, para aplicarlo
   * YA COMMITEADO el cobro. `null` cuando no había nada que descontar o cuando
   * esta ejecución no fue la que saldó la cuenta.
   */
  postingId?: string | null
}

interface IgnoredCryptoSettlementResult {
  webhookIgnored: true
  reason: 'OUT_OF_ORDER' | 'PAYMENT_NOT_PENDING'
  preservedStatus?: string
}

/**
 * Crea el vale de inventario etiquetando su fallo como REINTENTABLE.
 *
 * 🔴 Por qué existe este envoltorio, y por qué NO se copia tal cual al TPV: allá
 * el `Payment` ya está commiteado en su propia transacción, así que el comentario
 * de `payment.tpv.service` puede aceptar tranquilo que "si el insert del vale
 * falla, la transición a PAID se revierte" — el dinero está a salvo. **Aquí no**:
 * el `tx.payment.update({ status: COMPLETED })` vive DENTRO de esta misma
 * transacción, así que dejar escapar el error revertiría también el cobro y
 * dejaría el `Payment` PENDING con el dinero YA en la blockchain. Y nadie lo
 * volvería a intentar: el controlador del webhook contesta 200 siempre ("prevent
 * retries"), o sea que B4Bit tampoco reintenta.
 *
 * Marcándolo con el código que el bucle de arriba reconoce, un fallo transitorio
 * de base se reintenta; y si se agotan los intentos cae en el camino de rescate
 * que YA existía, que completa el `Payment` FUERA de la transacción. El orden de
 * lo que se protege es explícito: el dinero primero, después la deducción —
 * `payments.md` #2, "payment succeeds even if deduction fails".
 *
 * Lo que se pierde en ese caso NO es silencio: la orden se queda sin transición y
 * la vigila la 6ª invariante del vigilante (más el barrido `paid-order-reconciler`);
 * si el barrido la cierra sin vale, la ve la 7ª. Un vale que nunca nació no lo
 * rescata `inventory-posting-sweeper` —sólo reclama los que ya existen—, así que
 * la única defensa real es que se VEA, y se ve.
 */
async function crearValeDeInventario(
  tx: Prisma.TransactionClient,
  params: { venueId: string; orderId: string; items: unknown[]; staffId?: string | null },
): Promise<{ id: string } | null> {
  try {
    if (params.items.length > MAX_B4BIT_INVENTORY_POSTING_ITEMS) {
      throw new Error(`La orden ${params.orderId} tiene más de ${MAX_B4BIT_INVENTORY_POSTING_ITEMS} renglones; no se creó un vale parcial.`)
    }

    // `as any` igual que los otros cuatro sitios que crean el vale: el tipo que
    // devuelve Prisma con sus modificadores incluidos no encaja estructuralmente
    // con `SalePostingItem`, y ninguno de ellos lo re-declara.
    return await createSalePostingInTx(tx, { ...params, items: params.items as any })
  } catch (error) {
    const retryable: Error & { code?: string; cause?: unknown } = new Error('B4BIT_POSTING_FAILED')
    retryable.code = 'B4BIT_POSTING_FAILED'
    retryable.cause = error
    throw retryable
  }
}

/**
 * Performs the only transition that is allowed to finalize a B4Bit payment's
 * shift attribution.
 *
 * A tenant-scoped `SELECT ... FOR UPDATE` orders CO against every other terminal
 * webhook before the payment CAS and shift claim. Only the completion winner can
 * continue to the conditional OPEN-shift increment. All writes live in the same
 * transaction: if later order settlement rolls back, neither the payment
 * transition nor the shift totals survive.
 */
async function completeAndAttributeB4BitPaymentInTx(
  tx: Prisma.TransactionClient,
  payment: {
    id: string
    venueId: string
    orderId: string | null
    amount: Prisma.Decimal | number
    tipAmount: Prisma.Decimal | number
    processedById: string | null
  },
  processorPatch: Prisma.InputJsonObject,
  reconciliationEnabled: boolean,
): Promise<{ transitioned: boolean; ignoredAsOutOfOrder: boolean; preservedStatus?: string }> {
  // Task 5t: the release guard reasons over immutable primitives, never over a
  // mutable Prisma result that crossed the helper boundary.
  const paymentId = payment.id
  const paymentVenueId = payment.venueId
  const paymentOrderId = payment.orderId
  const paymentAmount = payment.amount
  const paymentTipAmount = payment.tipAmount
  const paymentProcessedById = payment.processedById

  if (paymentOrderId) {
    await lockExistingOrderForPayment(tx, { venueId: paymentVenueId, orderId: paymentOrderId })
  }
  await lockB4BitPaymentRow(tx, paymentId, paymentVenueId)
  const freshPayment = await tx.payment.findUnique({
    where: { id: paymentId, venueId: paymentVenueId },
    select: { status: true, processorData: true },
  })

  if (!freshPayment) {
    throw new Error(`B4Bit payment ${paymentId} no longer exists for venue ${paymentVenueId}`)
  }

  const merged = mergeB4BitProcessorData(freshPayment.processorData, processorPatch)
  if (merged.ignoredAsOutOfOrder) return { transitioned: false, ignoredAsOutOfOrder: true }

  if (freshPayment.status === 'COMPLETED') {
    // A redelivery may refresh provider metadata, but it must not mention
    // `shiftId`: the winner's final attribution is immutable.
    await tx.payment.update({
      where: { id: paymentId, venueId: paymentVenueId },
      data: { status: 'COMPLETED', processorData: merged.processorData },
    })
    return { transitioned: false, ignoredAsOutOfOrder: false }
  }

  if (freshPayment.status !== 'PENDING') {
    return { transitioned: false, ignoredAsOutOfOrder: false, preservedStatus: freshPayment.status }
  }

  const priorCompletedPaymentCount = paymentOrderId
    ? typeof tx.payment.count === 'function'
      ? ((await tx.payment.count({
          where: { orderId: paymentOrderId, venueId: paymentVenueId, status: 'COMPLETED', type: { not: 'REFUND' } },
        })) ?? 0)
      : 0
    : 0

  const transition = await tx.payment.updateMany({
    where: { id: paymentId, venueId: paymentVenueId, status: 'PENDING' },
    data: {
      status: 'COMPLETED',
      // The initiation-time value is provisional. Clearing it in the CAS makes
      // `null` the safe final result when no OPEN shift can be claimed.
      shiftId: null,
      processorData: merged.processorData,
    },
  })

  if (transition.count === 0) {
    // Another confirmation won after our read. Re-read only to preserve its
    // metadata and final shift; never claim or increment a shift in this branch.
    const winner = await tx.payment.findUnique({
      where: { id: paymentId, venueId: paymentVenueId },
      select: { status: true, processorData: true },
    })
    if (!winner) throw new Error(`B4Bit payment ${paymentId} no longer exists for venue ${paymentVenueId}`)
    if (winner.status !== 'COMPLETED') {
      return { transitioned: false, ignoredAsOutOfOrder: false, preservedStatus: winner.status }
    }

    const winnerMerge = mergeB4BitProcessorData(winner.processorData, processorPatch)
    if (winnerMerge.ignoredAsOutOfOrder) return { transitioned: false, ignoredAsOutOfOrder: true }

    await tx.payment.update({
      where: { id: paymentId, venueId: paymentVenueId },
      data: {
        status: 'COMPLETED',
        processorData: winnerMerge.processorData,
      },
    })
    return { transitioned: false, ignoredAsOutOfOrder: false }
  }

  // Resolve only after winning the payment transition: a redelivery/concurrent
  // loser never reaches the common claim or its atomic anomaly row.
  const amountPesos = new Prisma.Decimal(paymentAmount)
  const tipPesos = new Prisma.Decimal(paymentTipAmount)
  const shiftClaim = await claimShiftForCapturedPayment(tx, {
    venueId: paymentVenueId,
    amountPesos,
    tipPesos,
    incrementTotalOrders: Boolean(paymentOrderId) && priorCompletedPaymentCount === 0,
  })

  if (shiftClaim.shiftId) {
    await tx.payment.update({
      where: { id: paymentId, venueId: paymentVenueId },
      data: { shiftId: shiftClaim.shiftId },
    })
  } else {
    await recordPendingPaymentShiftReconciliation(tx, {
      claim: shiftClaim,
      venueId: paymentVenueId,
      paymentId,
      orderId: paymentOrderId,
      staffId: paymentProcessedById,
      channel: 'b4bitWebhook',
      amountPesos,
      tipPesos,
      reconciliationEnabled,
    })
  }

  return { transitioned: true, ignoredAsOutOfOrder: false }
}

/**
 * Completa el `Payment` de cripto y recalcula el saldo de su orden — todo en UNA
 * transacción.
 *
 * ── Lo que hace y por qué ───────────────────────────────────────────────────
 * 1. Hace CAS del pago a COMPLETED, elige el turno abierto EN ESE MOMENTO y lo
 *    reclama condicionalmente. Repetirlo preserva la atribución que ganó.
 * 2. RELEE la orden dentro de la transacción (la lectura de arriba pudo quedar
 *    vieja mientras se generaba el recibo) y sus `Payment` COMPLETED durables.
 * 3. Recalcula con `computeOrderBalance` — la aritmética canónica compartida.
 * 4. Escribe la transición con **CAS sobre `version`**: si otro dispositivo cobró
 *    entre la relectura y el write, `updateMany` no encuentra la fila y devuelve
 *    count 0. Se reintenta releyendo el estado ya commiteado por el ganador, en
 *    vez de pisarlo. Mismo patrón que `payCashOrder` y `addItemsToOrder`.
 *
 * ⚠️ DIFERENCIA deliberada con `payCashOrder`: su CAS filtra además por
 * `paymentStatus IN (PENDING, PARTIAL)`; la de aquí sólo por `version`. Es
 * necesario: un `CO` reentregado sobre una cuenta que YA quedó PAID daría count 0
 * con ese filtro, y giraría los tres reintentos hasta lanzar por un webhook que en
 * realidad no tenía nada que hacer. Sin el filtro, la reentrega recalcula el mismo
 * resultado y sale limpia.
 *
 * 🔴 Los efectos de "venta terminada" (`status: COMPLETED`, `completedAt`) sólo
 * se escriben en la transición real a pagado. Mientras falte dinero la cuenta
 * queda `PARTIAL` con su `remainingBalance` real y sigue cobrable.
 *
 * 🔴 NO se degrada `status` en un abono parcial: una orden que ya iba
 * `CONFIRMED`/`PREPARING` no debe retroceder a `PENDING` porque entró un abono.
 * Cobrar no es un evento de preparación. (`payment.tpv.service` y
 * `manualPayment.service` hacen lo mismo; `payCashOrder` es el outlier.)
 *
 * 🔴 NO se escribe `Order.total` ni `Order.tipAmount`. La fórmula canónica sirve
 * para DECIDIR si la cuenta quedó saldada, no para sobrescribir el total — y omite
 * `deliveryFeeAmount` y `taxAmount`. Un pedido de agregador (Deliverect/Uber)
 * guarda `subtotal 200`, `deliveryFeeAmount 40`, `total 240` porque el total viene
 * del proveedor (`deliveryOrderIngestion.service.ts`, `deliverect.mapper.ts`);
 * recalcularlo lo dejaría en 200 habiendo cobrado 240 — los $40 de envío
 * desaparecerían de todo reporte que lea `Order.total`, y quedaría
 * `paidAmount > total`. Cripto es justo el canal que puede engancharse a una orden
 * que NO creó. Sumar `deliveryFeeAmount` a la fórmula tocaría `payCashOrder`, que
 * no es parte de este cambio.
 *
 * @returns `null` si el pago no está ligado a ninguna orden (cobro suelto).
 */
async function settleOrderForConfirmedCryptoPayment(
  payment: {
    id: string
    venueId: string
    orderId: string | null
    amount: Prisma.Decimal | number
    tipAmount: Prisma.Decimal | number
    externalId: string | null
    processorData: Prisma.JsonValue
    /** Quién cobró: queda como autor del vale de inventario y de su aplicación. */
    processedById: string | null
  },
  processorPatch: Prisma.InputJsonObject,
  reconciliationEnabled: boolean,
): Promise<CryptoSettlementResult | IgnoredCryptoSettlementResult | null> {
  const MAX_SETTLEMENT_ATTEMPTS = 3

  for (let attempt = 1; attempt <= MAX_SETTLEMENT_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(async tx => {
        const completion = await completeAndAttributeB4BitPaymentInTx(tx, payment, processorPatch, reconciliationEnabled)
        if (completion.ignoredAsOutOfOrder) return { webhookIgnored: true as const, reason: 'OUT_OF_ORDER' as const }
        if (completion.preservedStatus) {
          return {
            webhookIgnored: true as const,
            reason: 'PAYMENT_NOT_PENDING' as const,
            preservedStatus: completion.preservedStatus,
          }
        }
        const isRedelivery = !completion.transitioned

        if (!payment.orderId) return null

        const fresh = await tx.order.findUnique({
          where: { id: payment.orderId, venueId: payment.venueId },
          select: {
            id: true,
            status: true,
            paymentStatus: true,
            subtotal: true,
            discountAmount: true,
            serviceChargeAmount: true,
            paidAmount: true,
            remainingBalance: true,
            completedAt: true,
            version: true,
          },
        })
        if (!fresh) {
          logger.warn('⚠️ B4Bit: order linked to the payment no longer exists for this venue', {
            orderId: payment.orderId,
            venueId: payment.venueId,
          })
          return null
        }

        /** El estado de la orden tal como quedó, para reportar sin recalcular nada. */
        const untouched = (reason: CryptoSettlementResult['balanceSkipped']): CryptoSettlementResult => ({
          isFullyPaid: fresh.paymentStatus === 'PAID',
          becamePaid: false,
          paidAmount: Number(fresh.paidAmount ?? 0).toFixed(2),
          remainingBalance: Number(fresh.remainingBalance ?? 0).toFixed(2),
          balanceSkipped: reason,
        })

        // 🔴 UNA ORDEN CANCELADA NO SE RESUCITA.
        //
        // La INICIACIÓN valida esto, pero entre iniciar y confirmar pasan minutos
        // en los que alguien puede cancelar la cuenta. Sin el guard, el `CO` la
        // dejaba `status: COMPLETED` + `paymentStatus: PAID`: una venta cancelada
        // reaparecía cobrada. El `Payment` sí queda COMPLETED —el dinero llegó— y
        // se grita en el log para que alguien lo concilie a mano.
        if (fresh.status === 'CANCELLED' || fresh.status === 'DELETED') {
          logger.error('🚨 [B4Bit] cobro confirmado sobre orden cancelada', {
            paymentId: payment.id,
            venueId: payment.venueId,
            orderId: payment.orderId,
            amount: payment.amount.toString(),
            orderStatus: fresh.status,
            b4bitReference: payment.externalId,
            action: 'el Payment quedó COMPLETED; decidir a mano si se reembolsa o se reabre la cuenta',
          })
          return untouched('ORDER_NOT_CHARGEABLE')
        }

        // Los pagos COMPLETED DURABLES — la única fuente de verdad de lo cobrado.
        // `order.paidAmount` es un derivado y arrastra el valor equivocado si
        // alguna vez se escribió mal; recalcular desde aquí lo repara solo.
        const completedPayments = await tx.payment.findMany({
          where: { orderId: payment.orderId, status: 'COMPLETED' },
          select: { amount: true, tipAmount: true, type: true },
        })

        // 🔴 UNA CUENTA REEMBOLSADA NO REABRE SALDO — y ya no hace falta un guard
        // aquí para conseguirlo.
        //
        // Hasta el 2026-08-18 este bloque se SALTABA el recálculo cuando el `CO`
        // era una reentrega sobre una orden con reembolsos, porque la aritmética
        // sumaba TODOS los COMPLETED —el `Payment` NEGATIVO `type: REFUND`
        // incluido— y hacía $200 + (−$200) = $0 pagados: la venta devuelta
        // reaparecía debiendo $200, en el estado contradictorio `status COMPLETED`
        // + `paymentStatus PARTIAL`.
        //
        // 🔑 El guard era un parche ACOTADO A CRIPTO sobre un defecto que era de
        // los CUATRO canales. Ahora la causa está cerrada en la aritmética
        // canónica: `computeOrderBalance` EXCLUYE los REFUND de `paidAmount` y los
        // lleva en su propio carril (`refundedAmount`/`refundState`), igual que
        // `refunded_money` de Square o `refundStatus` de Toast. Recalcular una
        // cuenta reembolsada llega al MISMO resultado que ya tenía, así que evadir
        // el recálculo dejó de comprar nada — y el guard sí costaba: obligaba a
        // distinguir reentrega de cobro nuevo (`isRedelivery`), y equivocarse ahí
        // dejaba una cuenta pidiendo dinero que el cliente YA pagó.
        const balance = computeOrderBalance(fresh, completedPayments)

        // No se BLOQUEA nada: el dinero es real y registrarlo siempre gana. Pero un
        // cobro que aterriza sobre una cuenta con devoluciones merece una mirada
        // humana, así que queda un rastro greppable — MISMO token en los cuatro
        // canales de cobro.
        if (balance.refundState !== 'NONE') {
          logger.warn('⚠️ [Reembolso] cobro sobre una cuenta con reembolsos — el saldo NO los cuenta, revisar', {
            paymentId: payment.id,
            venueId: payment.venueId,
            orderId: payment.orderId,
            channel: 'b4bit',
            isRedelivery,
            refundState: balance.refundState,
            refundedAmount: balance.refundedAmount.toFixed(2),
          })
        }

        const wasAlreadyPaid = fresh.paymentStatus === 'PAID'

        const transition = await tx.order.updateMany({
          // El filtro de `status` cierra la carrera: si cancelan la orden entre la
          // relectura y este write, la CAS no encuentra fila (count 0) y el
          // reintento la relee ya CANCELLED, donde el guard de arriba la ataja.
          where: {
            id: payment.orderId,
            venueId: payment.venueId,
            version: fresh.version,
            status: { notIn: ['CANCELLED', 'DELETED'] },
          },
          data: {
            // Sólo el derivado del cobro. `total`/`tipAmount` NO se tocan — ver el
            // bloque de `Order.total` en el docstring (cuota de envío de agregador).
            paymentStatus: balance.isFullyPaid ? 'PAID' : 'PARTIAL',
            paidAmount: balance.paidAmount,
            remainingBalance: balance.remainingBalance,
            version: { increment: 1 },
            // `completedAt` se conserva si ya existía: la venta se cerró una vez,
            // no una por cada reentrega del webhook.
            ...(balance.isFullyPaid ? { status: 'COMPLETED' as const, completedAt: fresh.completedAt ?? new Date() } : {}),
          },
        })

        if (transition.count === 0) {
          const conflict: Error & { code?: string } = new Error('B4BIT_ORDER_CAS_LOST')
          conflict.code = 'B4BIT_ORDER_CAS_LOST'
          throw conflict
        }

        // 🔴 EL VALE DE INVENTARIO — lo que este camino NO hacía y costaba stock.
        //
        // Hasta el 3-sep-2026 cripto cerraba la venta sin crear el vale ni deducir
        // nada: un venue con recetas vendía y su inventario no bajaba, EN SILENCIO.
        // Es el mismo defecto del capuchino de Testarudo (ORD-1788276418170) en otro
        // camino de cobro, y por eso la 7ª invariante del vigilante de dinero avisa
        // de que `via=TPV` cripto aparecería en serie.
        //
        // Nace AQUÍ DENTRO, en el mismo commit que la transición (fase 2 de la
        // auditoría 2026-08-12): si el proceso muere después del commit y antes de
        // deducir, queda un posting PENDING que el sweeper reaplica — en vez de una
        // deducción perdida que nadie puede ver. Crearlo fuera dejaría la ventana
        // exacta que la fase 2 existe para cerrar.
        //
        // 🔑 Sólo en la TRANSICIÓN REAL a pagado, igual que el hook de referidos: un
        // abono parcial no descuenta (regla de `payments.md`), y un `CO` reentregado
        // sobre una cuenta que ya estaba PAID descontaría la venta DOS veces.
        const becamePaid = balance.isFullyPaid && !wasAlreadyPaid
        let postingId: string | null = null
        if (becamePaid) {
          // Los renglones se leen con la MISMA tx, no con `prisma`: fuera de ella
          // no verían lo que esta transacción aún no ha commiteado.
          const txItems = await tx.orderItem.findMany({
            where: { orderId: payment.orderId },
            include: { modifiers: { include: { modifier: true } } },
            take: MAX_B4BIT_INVENTORY_POSTING_ITEMS + 1,
          })
          const posting = await crearValeDeInventario(tx, {
            venueId: payment.venueId,
            orderId: payment.orderId,
            items: txItems,
            staffId: payment.processedById,
          })
          postingId = posting?.id ?? null
        }

        return {
          isFullyPaid: balance.isFullyPaid,
          becamePaid,
          paidAmount: balance.paidAmount.toFixed(2),
          remainingBalance: balance.remainingBalance.toFixed(2),
          postingId,
        }
      })
    } catch (error: any) {
      // Se reintentan DOS cosas, y sólo dos: perder la CAS contra otro cobro, y
      // que el vale de inventario no se pudiera escribir (ver
      // `crearValeDeInventario`). Cualquier otro error sube tal cual.
      if (error?.code !== 'B4BIT_ORDER_CAS_LOST' && error?.code !== 'B4BIT_POSTING_FAILED') throw error

      if (error.code === 'B4BIT_POSTING_FAILED') {
        logger.warn('♻️ B4Bit: no se pudo escribir el vale de inventario — reintentando la liquidación', {
          orderId: payment.orderId,
          paymentId: payment.id,
          attempt,
          error: error.cause instanceof Error ? error.cause.message : String(error.cause),
        })
      } else {
        logger.warn('♻️ B4Bit: order changed while settling the crypto payment — retrying', {
          orderId: payment.orderId,
          attempt,
        })
      }
    }
  }

  // ── Agotados los 3 intentos ────────────────────────────────────────────────
  // 🔴 La transición del Payment vive DENTRO de la transacción, así que cada intento
  // perdido lo revirtió: en este punto el `Payment` sigue PENDING aunque el dinero
  // YA esté en la blockchain. Y el controlador contesta 200 siempre ("prevent
  // retries"), o sea que B4Bit tampoco va a reintentar. Sin lo de abajo, el cobro
  // desaparecería de los libros sin que nadie se entere.
  //
  // Por eso se completa el pago en una NUEVA transacción, sin volver a tocar la
  // orden: son dos durabilidades distintas. "Este cobro ocurrió" no se puede
  // perder nunca; el derivado de la orden (`paidAmount`/`remainingBalance`) es
  // RECALCULABLE — y de hecho se repara solo, porque `computeOrderBalance` lee los
  // `Payment` COMPLETED durables: el siguiente abono sobre esa cuenta ya cuenta
  // éste. La nueva transacción reutiliza la MISMA CAS + claim del camino normal,
  // para no conservar el turno provisional ni duplicar totales si otro `CO` ganó.
  //
  // El estado resultante (pago COMPLETED, orden con saldo de más) yerra hacia el
  // lado seguro: el negocio ve que le deben de más y lo detecta al cobrar, en vez
  // de perder el dinero en silencio.
  try {
    await prisma.$transaction(async tx => {
      await completeAndAttributeB4BitPaymentInTx(
        tx,
        payment,
        {
          ...processorPatch,
          orderSettlementFailed: true,
          orderSettlementFailedAt: new Date().toISOString(),
        },
        reconciliationEnabled,
      )
    })
  } catch (persistError: any) {
    logger.error('🚨 [B4Bit settlement] NO SE PUDO REGISTRAR EL COBRO CRIPTO — dinero cobrado sin Payment COMPLETED', {
      paymentId: payment.id,
      venueId: payment.venueId,
      orderId: payment.orderId,
      amount: payment.amount.toString(),
      b4bitReference: payment.externalId,
      error: persistError?.message,
    })
    throw persistError
  }

  // 🚨 greppable a propósito. Las alertas de este repo son por UMBRAL, así que un
  // evento único de dinero no dispara nada por sí solo: el mensaje tiene que ser
  // buscable a mano y traer todo lo necesario para reconstruir el caso sin la DB.
  logger.error('🚨 [B4Bit settlement] EXHAUSTED — pago COMPLETADO pero el saldo de la cuenta NO se pudo actualizar', {
    paymentId: payment.id,
    venueId: payment.venueId,
    orderId: payment.orderId,
    amount: payment.amount.toString(),
    b4bitReference: payment.externalId,
    attempts: MAX_SETTLEMENT_ATTEMPTS,
    action: 'revisar paidAmount/remainingBalance de la orden a mano; el Payment ya cuenta como cobrado',
  })

  throw new InternalServerError('No se pudo actualizar el saldo de la cuenta tras confirmar el pago cripto')
}

/**
 * Handle confirmed crypto payment
 *
 * Updates payment status, generates receipt, and emits success event.
 */
async function handlePaymentConfirmed(
  payment: Awaited<ReturnType<typeof prisma.payment.findUnique>> & {
    order: { id: string; orderNumber: string | null; tableId: string | null } | null
    venue: { id: string; name: string; organizationId: string } | null
  },
  payload: B4BitWebhookPayload,
  reconciliationEnabled: boolean,
): Promise<ProcessWebhookResult> {
  if (!payment || !payment.venue) {
    return {
      success: false,
      action: 'NOT_FOUND',
      message: 'Payment or venue not found',
    }
  }

  const { crypto_amount, currency, tx_hash, confirmations } = payload
  const venueId = payment.venueId

  logger.info('✅ B4Bit: Payment confirmed!', {
    paymentId: payment.id,
    cryptoAmount: crypto_amount,
    currency,
    txHash: tx_hash,
  })

  // 🔴 MONEY — un abono PARCIAL no puede cerrar la cuenta.
  //
  // Esto escribía, sin mirar nada más: `status: COMPLETED`, `paymentStatus: PAID`,
  // `paidAmount: payment.amount` (PISA lo pagado antes, no acumula) y
  // `remainingBalance: 0` incondicional. Una cuenta de $200 abonada con $50 en
  // cripto se cerraba PAGADA y los $150 por cobrar DESAPARECÍAN: ni el mesero, ni
  // el corte, ni el reporte se enteraban de que faltaba dinero.
  //
  // Ahora, en UNA sola transacción: se completa el pago actual, se RELEEN los
  // `Payment` COMPLETED **durables** de la orden y se recalcula con la aritmética
  // canónica (`computeOrderBalance`, la misma de `payCashOrder`).
  //
  // 🔑 Se recalcula desde los pagos durables, NUNCA con `paidAmount += amount`:
  // un `CO` reentregado por B4Bit relee el mismo conjunto y llega al mismo
  // resultado, en vez de duplicar el abono.
  const settlement = await settleOrderForConfirmedCryptoPayment(
    payment,
    {
      lastStatus: 'CO',
      cryptoAmount: crypto_amount,
      cryptoCurrency: currency,
      txHash: tx_hash,
      confirmations,
      confirmedAt: new Date().toISOString(),
      // Sólo si es una fecha válida — ver `parseEditedAtMs`.
      ...(validEditedAt(payload) ? { lastEditedAt: validEditedAt(payload) } : {}),
    },
    reconciliationEnabled,
  )

  if (settlement && 'webhookIgnored' in settlement) {
    if (settlement.reason === 'PAYMENT_NOT_PENDING') {
      logger.warn('⚠️ [B4Bit] CO ignorado: el Payment durable ya no está PENDING', {
        paymentId: payment.id,
        venueId,
        preservedStatus: settlement.preservedStatus,
      })
      return {
        success: true,
        action: 'IGNORED',
        message: `CO ignorado: el Payment conserva estado ${settlement.preservedStatus}`,
        paymentId: payment.id,
        details: { status: 'CO' },
      }
    }
    logger.warn('⚠️ [B4Bit] CO FUERA DE ORDEN ignorado dentro de la transición terminal', {
      paymentId: payment.id,
      venueId,
      editedAt: payload.edited_at,
    })
    return {
      success: true,
      action: 'IGNORED',
      message: 'Webhook fuera de orden: edited_at anterior al último aplicado',
      paymentId: payment.id,
      details: { status: 'CO' },
    }
  }

  // El recibo sólo nace después de que la transición durable aceptó el CO. Un
  // Payment FAILED/PROCESSING preservado no recibe efectos de confirmación.
  let receipt = null
  let receiptUrl: string | null = null
  const frontendUrl = process.env.FRONTEND_URL || 'https://dashboardv2.avoqado.io'
  try {
    receipt = await generateDigitalReceipt(payment.id)
    receiptUrl = generateReceiptUrl(receipt.accessKey, frontendUrl)
    logger.info('📄 Digital receipt generated', { receiptUrl })
  } catch (receiptError: any) {
    logger.error('⚠️ Failed to generate receipt', { error: receiptError.message })
  }

  if (payment.orderId && settlement) {
    if (!settlement.balanceSkipped) {
      logger.info(settlement.isFullyPaid ? '📦 Order marked as PAID' : '📦 Order partially paid — balance still open', {
        orderId: payment.orderId,
        paidAmount: settlement.paidAmount,
        remainingBalance: settlement.remainingBalance,
      })
    }

    // 🔴 SE APLICA EL VALE, YA COMMITEADO EL COBRO — y nunca puede tumbarlo.
    //
    // El vale ya existe y es durable: si deducir truena, queda PENDING y el
    // `inventory-posting-sweeper` lo retoma. El dinero es un hecho; la deducción
    // es reintentable — mismo enganche y mismo try/catch que `manualPayment` y el
    // efectivo móvil.
    if (settlement.postingId) {
      try {
        await applySalePosting(settlement.postingId, payment.processedById)
      } catch (deductionError: any) {
        logger.error('⚠️ [B4Bit] no se pudo aplicar el vale de inventario (el cobro SÍ quedó registrado)', {
          orderId: payment.orderId,
          venueId,
          paymentId: payment.id,
          postingId: settlement.postingId,
          error: deductionError?.message ?? String(deductionError),
        })
      }
    }

    // REFERRAL HOOK: trigger referral qualification if this crypto-paid order has a pending referral.
    // 🔑 Sólo en la TRANSICIÓN REAL a pagado: un abono parcial no es una venta
    // terminada, y un webhook repetido sobre una cuenta ya pagada tampoco.
    if (settlement.becamePaid) {
      try {
        const { onOrderPaid } = await import('@/services/referrals/referralQualification.service')
        await onOrderPaid({ orderId: payment.orderId, venueId })
      } catch (err) {
        console.error('[referral hook] onOrderPaid failed for order', payment.orderId, err)
      }
    }
  }

  // Emit CRYPTO_PAYMENT_CONFIRMED event
  // Note: TPV expects amount in centavos, but payment.amount is stored in pesos (decimal)
  // So we multiply by 100 to convert back to centavos
  socketManager.broadcastToVenue(venueId, 'crypto:payment_confirmed' as SocketEventType, {
    correlationId: payment.id,
    timestamp: new Date(),
    venueId,
    requestId: payment.externalId,
    paymentId: payment.id,
    amount: Math.round(Number(payment.amount) * 100), // Convert pesos to centavos for TPV
    currency: 'MXN',
    txHash: tx_hash,
    cryptoAmount: crypto_amount,
    cryptoCurrency: currency,
    confirmations,
    orderId: payment.orderId,
    orderNumber: payment.order?.orderNumber,
    receiptUrl,
    receiptAccessKey: receipt?.accessKey,
  })

  // Also emit standard PAYMENT_COMPLETED for dashboard
  socketManager.broadcastToVenue(venueId, SocketEventType.PAYMENT_COMPLETED, {
    correlationId: payment.id,
    timestamp: new Date(),
    venueId,
    paymentId: payment.id,
    amount: payment.amount,
    currency: 'MXN',
    tableId: payment.order?.tableId,
    orderId: payment.orderId,
    status: 'completed',
    metadata: {
      method: 'CRYPTOCURRENCY',
      provider: 'B4BIT',
      txHash: tx_hash,
      cryptoAmount: crypto_amount,
      cryptoCurrency: currency,
    },
  })

  return {
    success: true,
    action: 'CONFIRMED',
    message: 'Crypto payment confirmed successfully',
    paymentId: payment.id,
    details: {
      status: 'CO',
      cryptoAmount: crypto_amount,
      cryptoCurrency: currency,
      txHash: tx_hash,
      confirmations,
    },
  }
}

/**
 * Get payment status from B4Bit (polling fallback)
 *
 * Use this if webhook fails and we need to manually check status.
 *
 * @param requestId B4Bit request ID (identifier)
 * @returns Current payment status
 */
export async function getPaymentStatus(
  requestId: string,
  venueId: string,
): Promise<{
  status: B4BitPaymentStatus
  cryptoAmount?: string
  cryptoCurrency?: string
  txHash?: string
}> {
  const globalConfig = getB4BitGlobalConfig()
  const venueConfig = await getVenueCryptoConfig(venueId)
  const url = `${globalConfig.baseUrl}/api/v1/orders/info/${requestId}/`

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Device-Id': venueConfig.deviceId,
      },
    })

    const data = await response.json()

    return {
      status: data.status,
      cryptoAmount: data.crypto_amount,
      cryptoCurrency: data.currency,
      txHash: data.tx_hash,
    }
  } catch (error: any) {
    logger.error('❌ B4Bit: Failed to get payment status', {
      requestId,
      error: error.message,
    })
    throw new InternalServerError('Error al consultar estado del pago crypto')
  }
}

/**
 * Cancel a pending crypto payment order
 *
 * @param paymentId Our internal payment ID
 */
export async function cancelCryptoPayment(paymentId: string): Promise<void> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { id: true, status: true, externalId: true, venueId: true, processorData: true },
  })

  if (!payment) {
    throw new BadRequestError('Pago no encontrado')
  }

  if (payment.status !== 'PENDING') {
    throw new BadRequestError('Solo se pueden cancelar pagos pendientes')
  }

  // Update status to FAILED (CANCELLED not available in TransactionStatus enum)
  await prisma.payment.update({
    where: { id: paymentId },
    data: {
      status: 'FAILED',
      processorData: {
        ...(typeof payment.processorData === 'object' ? payment.processorData : {}),
        cancelledAt: new Date().toISOString(),
        cancelledBy: 'TPV_USER',
        cancelReason: 'USER_CANCELLED',
      },
    },
  })

  // Emit cancellation event
  socketManager.broadcastToVenue(payment.venueId, SocketEventType.PAYMENT_FAILED, {
    correlationId: payment.id,
    timestamp: new Date(),
    venueId: payment.venueId,
    paymentId: payment.id,
    amount: 0,
    currency: 'MXN',
    status: 'failed',
    metadata: {
      method: 'CRYPTOCURRENCY',
      reason: 'CANCELLED_BY_USER',
    },
  })

  logger.info('🚫 Crypto payment cancelled', { paymentId })
}
