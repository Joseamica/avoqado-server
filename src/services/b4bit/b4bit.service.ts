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
import { computeOrderBalance } from '../shared/orderBalance'
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
  const { venueId, amount, tip = 0, staffId, shiftId, orderId, orderNumber, deviceSerialNumber, rating } = params
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

  // Validate shift is open (if shiftId provided)
  if (shiftId) {
    const shift = await prisma.shift.findUnique({
      where: { id: shiftId },
      select: { id: true, status: true },
    })

    if (!shift || shift.status !== 'OPEN') {
      throw new BadRequestError('No hay turno abierto para procesar el pago')
    }
  }

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
  const { payment } = await prisma.$transaction(async tx => {
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

    if (!orderIdToUse) {
      // Generate order number
      const orderNumberGenerated = orderNumber || `CRYPTO-${Date.now()}`

      // Create fast order for crypto payment
      const newOrder = await tx.order.create({
        data: {
          venueId,
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
        shiftId,
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

    return { payment: newPayment, fastOrder: orderIdToUse !== orderId ? orderIdToUse : null }
  })

  logger.info('💾 Created pending crypto payment', { paymentId: payment.id })

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
  }
}

/**
 * Verify B4Bit webhook signature
 *
 * B4Bit signs webhooks with HMAC-SHA256:
 * signature = hex(hmac_sha256(secret, nonce + body))
 *
 * @param nonce X-NONCE header (unix timestamp)
 * @param body Raw request body as string
 * @param signature X-SIGNATURE header
 * @returns true if signature is valid
 */
export function verifyWebhookSignature(nonce: string, body: string, signature: string, webhookSecret?: string | null): boolean {
  const secret = webhookSecret || process.env.B4BIT_WEBHOOK_SECRET

  // TODO(#43 seguridad): sin secret esto devuelve `true`, o sea que acepta CUALQUIER
  // webhook sin verificar nada. Junto con el `if (signature && nonce)` del controlador
  // (`b4bit-webhook.tpv.controller.ts`), que se salta la verificación entera cuando
  // faltan los dos headers, un tercero podría marcar cobros como confirmados.
  // Es una tarea APARTE (#43) y NO se toca aquí: este cambio es sólo el saldo parcial.
  if (!secret) {
    logger.warn('⚠️ B4BIT_WEBHOOK_SECRET not configured - skipping signature verification')
    return true // Allow in development, should require in production
  }

  // B4Bit documentation: X-SIGNATURE = hexadecimal(hmac_sha256(merchant_secret_key, nonce + body))
  // The merchant_secret_key must be converted from hex string to bytes
  const secretBytes = Buffer.from(secret, 'hex')
  const message = nonce + body
  const expectedSignature = crypto.createHmac('sha256', secretBytes).update(message).digest('hex')

  if (signature === expectedSignature) {
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

  // Process based on status
  switch (status) {
    case 'CO': // Completed - Payment confirmed
      return await handlePaymentConfirmed(payment, payload)

    case 'AC': // Awaiting Completion - Payment detected, waiting for confirmations
      // Update processorData and emit progress event
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          processorData: {
            ...(typeof payment.processorData === 'object' ? payment.processorData : {}),
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

      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'FAILED',
          processorData: {
            ...(typeof payment.processorData === 'object' ? payment.processorData : {}),
            lastStatus: status,
            failReason,
            failedAt: new Date().toISOString(),
          },
        },
      })

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
}

/**
 * Completa el `Payment` de cripto y recalcula el saldo de su orden — todo en UNA
 * transacción.
 *
 * ── Lo que hace y por qué ───────────────────────────────────────────────────
 * 1. Marca el pago COMPLETED. Repetirlo es inocuo: es justamente lo que hace que
 *    un `CO` reentregado por B4Bit no cree un segundo cobro.
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
    externalId: string | null
    processorData: Prisma.JsonValue
  },
  processorPatch: Prisma.InputJsonObject,
): Promise<CryptoSettlementResult | null> {
  const MAX_SETTLEMENT_ATTEMPTS = 3

  for (let attempt = 1; attempt <= MAX_SETTLEMENT_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(async tx => {
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: 'COMPLETED',
            processorData: {
              ...(typeof payment.processorData === 'object' && payment.processorData !== null ? payment.processorData : {}),
              ...processorPatch,
            } as Prisma.InputJsonObject,
          },
        })

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

        // Los pagos COMPLETED DURABLES — la única fuente de verdad de lo cobrado.
        // `order.paidAmount` es un derivado y arrastra el valor equivocado si
        // alguna vez se escribió mal; recalcular desde aquí lo repara solo.
        const completedPayments = await tx.payment.findMany({
          where: { orderId: payment.orderId, status: 'COMPLETED' },
          select: { amount: true, tipAmount: true },
        })

        const balance = computeOrderBalance(fresh, completedPayments)
        const wasAlreadyPaid = fresh.paymentStatus === 'PAID'

        const transition = await tx.order.updateMany({
          where: { id: payment.orderId, venueId: payment.venueId, version: fresh.version },
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

        return {
          isFullyPaid: balance.isFullyPaid,
          becamePaid: balance.isFullyPaid && !wasAlreadyPaid,
          paidAmount: balance.paidAmount.toFixed(2),
          remainingBalance: balance.remainingBalance.toFixed(2),
        }
      })
    } catch (error: any) {
      // Sólo el conflicto de CAS se reintenta. Cualquier otro error sube tal cual.
      if (error?.code !== 'B4BIT_ORDER_CAS_LOST') throw error

      logger.warn('♻️ B4Bit: order changed while settling the crypto payment — retrying', {
        orderId: payment.orderId,
        attempt,
      })
    }
  }

  // ── Agotados los 3 intentos ────────────────────────────────────────────────
  // 🔴 El `payment.update` vive DENTRO de la transacción, así que cada intento
  // perdido lo revirtió: en este punto el `Payment` sigue PENDING aunque el dinero
  // YA esté en la blockchain. Y el controlador contesta 200 siempre ("prevent
  // retries"), o sea que B4Bit tampoco va a reintentar. Sin lo de abajo, el cobro
  // desaparecería de los libros sin que nadie se entere.
  //
  // Por eso se completa el pago FUERA de la transacción: son dos durabilidades
  // distintas. "Este cobro ocurrió" no se puede perder nunca; el derivado de la
  // orden (`paidAmount`/`remainingBalance`) es RECALCULABLE — y de hecho se repara
  // solo, porque `computeOrderBalance` lee los `Payment` COMPLETED durables: el
  // siguiente abono sobre esa cuenta ya cuenta éste.
  //
  // El estado resultante (pago COMPLETED, orden con saldo de más) yerra hacia el
  // lado seguro: el negocio ve que le deben de más y lo detecta al cobrar, en vez
  // de perder el dinero en silencio.
  try {
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: 'COMPLETED',
        processorData: {
          ...(typeof payment.processorData === 'object' && payment.processorData !== null ? payment.processorData : {}),
          ...processorPatch,
          orderSettlementFailed: true,
          orderSettlementFailedAt: new Date().toISOString(),
        } as Prisma.InputJsonObject,
      },
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

  // Generate digital receipt
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
  const settlement = await settleOrderForConfirmedCryptoPayment(payment, {
    lastStatus: 'CO',
    cryptoAmount: crypto_amount,
    cryptoCurrency: currency,
    txHash: tx_hash,
    confirmations,
    confirmedAt: new Date().toISOString(),
  })

  if (payment.orderId && settlement) {
    logger.info(settlement.isFullyPaid ? '📦 Order marked as PAID' : '📦 Order partially paid — balance still open', {
      orderId: payment.orderId,
      paidAmount: settlement.paidAmount,
      remainingBalance: settlement.remainingBalance,
    })

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
