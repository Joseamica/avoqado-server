/**
 * B4Bit Crypto Payment Service
 *
 * Integration with B4Bit crypto payment gateway for accepting cryptocurrency payments.
 * Supports 13 cryptocurrencies including BTC, ETH, USDT, USDC, etc.
 *
 * Environment Configuration:
 * - B4BIT_API_BASE_URL: API base URL (dev-pay.b4bit.com for test, pos.b4bit.com for prod)
 * - B4BIT_API_KEY: API key for authentication
 * - B4BIT_WEBHOOK_SECRET: Secret for webhook signature verification
 */

import { PaymentMethod } from '@prisma/client'
import crypto from 'crypto'
import { socketManager } from '../../communication/sockets/managers/socketManager'
import { SocketEventType } from '../../communication/sockets/types'
import logger from '../../config/logger'
import { BadRequestError, InternalServerError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { generateDigitalReceipt, generateReceiptUrl } from '../tpv/digitalReceipt.tpv.service'
import type {
  B4BitConfig,
  B4BitCreateOrderRequest,
  B4BitCreateOrderResponse,
  B4BitPaymentStatus,
  B4BitWebhookPayload,
  InitiateCryptoPaymentParams,
  InitiateCryptoPaymentResult,
  ProcessWebhookResult,
} from './types'

// Configuration from environment
const getB4BitConfig = (): B4BitConfig => {
  // API URLs:
  // - DEV: https://dev-payments.b4bit.com (API), https://dev-pay.b4bit.com (frontend/login)
  // - PROD: https://pos.b4bit.com (API), https://pay.b4bit.com (frontend/login)
  const baseUrl = process.env.B4BIT_API_BASE_URL || 'https://dev-payments.b4bit.com'
  const loginUrl = process.env.B4BIT_LOGIN_URL || 'https://dev-pay.b4bit.com'
  const username = process.env.B4BIT_USERNAME || ''
  const password = process.env.B4BIT_PASSWORD || ''
  const deviceId = process.env.B4BIT_DEVICE_ID || ''
  const webhookSecret = process.env.B4BIT_WEBHOOK_SECRET

  if (!username || !password) {
    logger.warn('⚠️ B4BIT_USERNAME/PASSWORD not configured - crypto payments will fail')
  }

  return { baseUrl, loginUrl, username, password, deviceId, webhookSecret }
}

// Cache for auth token (expires after 23 hours to be safe)
let cachedAuthToken: { token: string; expiresAt: number } | null = null

/**
 * Authenticate with B4Bit and get access token
 * Caches token for 23 hours to avoid repeated logins
 */
async function getAuthToken(): Promise<string> {
  const config = getB4BitConfig()

  // Return cached token if still valid
  if (cachedAuthToken && Date.now() < cachedAuthToken.expiresAt) {
    return cachedAuthToken.token
  }

  logger.info('🔐 B4Bit: Authenticating...')

  try {
    const response = await fetch(`${config.loginUrl}/api/user/signIn`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: config.username,
        password: config.password,
      }),
    })

    const data = await response.json()

    if (data.hasError || !data.result?.token) {
      logger.error('❌ B4Bit: Authentication failed', {
        error: data.error?.customerDescription || 'Unknown error',
      })
      throw new Error(data.error?.customerDescription || 'B4Bit authentication failed')
    }

    // Cache token for 23 hours
    cachedAuthToken = {
      token: data.result.token,
      expiresAt: Date.now() + 23 * 60 * 60 * 1000,
    }

    logger.info('✅ B4Bit: Authenticated successfully', {
      merchants: data.result.merchants?.length || 0,
    })

    return data.result.token
  } catch (error: any) {
    logger.error('❌ B4Bit: Authentication error', { error: error.message })
    throw error
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
 * - Auth: Authorization: Token xxx + X-Device-Id header
 * - Content-Type: multipart/form-data
 * - Main param: expected_output_amount (fiat amount)
 *
 * @param request Order creation parameters
 * @returns Order data including payment URL for QR generation
 */
async function createPaymentOrder(request: B4BitCreateOrderRequest): Promise<B4BitCreateOrderResponse> {
  const config = getB4BitConfig()
  const url = `${config.baseUrl}/api/v1/orders/`

  logger.info('🔗 B4Bit: Creating crypto payment order', {
    fiatAmount: request.fiat_amount,
    currency: request.fiat_currency,
    identifier: request.identifier,
  })

  try {
    // Get auth token (cached)
    const authToken = await getAuthToken()

    logger.debug('🔗 B4Bit: Calling API', { url, hasToken: !!authToken, hasDeviceId: !!config.deviceId })

    // Build form data (B4Bit API expects multipart/form-data)
    // B4Bit field names: expected_output_amount, fiat_currency (or output_currency)
    const formData = new FormData()
    formData.append('expected_output_amount', request.fiat_amount.toString())
    formData.append('fiat_currency', request.fiat_currency || 'MXN')
    formData.append('output_currency', request.fiat_currency || 'MXN') // Try both field names
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
        Authorization: `Token ${authToken}`,
        'X-Device-Id': config.deviceId,
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
    } catch (_parseError: any) {
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

  // Convert centavos to decimal (5500 centavos = $55.00 MXN)
  const totalAmount = amount + tip
  const fiatAmount = totalAmount / 100

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
export function verifyWebhookSignature(nonce: string, body: string, signature: string): boolean {
  const config = getB4BitConfig()

  if (!config.webhookSecret) {
    logger.warn('⚠️ B4BIT_WEBHOOK_SECRET not configured - skipping signature verification')
    return true // Allow in development, should require in production
  }

  // B4Bit documentation: X-SIGNATURE = hexadecimal(hmac_sha256(merchant_secret_key, nonce + body))
  // The merchant_secret_key must be converted from hex string to bytes
  const secretBytes = Buffer.from(config.webhookSecret, 'hex')
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
  const apiBaseUrl = process.env.API_BASE_URL || 'https://api.avoqado.io'
  try {
    receipt = await generateDigitalReceipt(payment.id)
    receiptUrl = generateReceiptUrl(receipt.accessKey, apiBaseUrl)
    logger.info('📄 Digital receipt generated', { receiptUrl })
  } catch (receiptError: any) {
    logger.error('⚠️ Failed to generate receipt', { error: receiptError.message })
  }

  // Update payment to COMPLETED
  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: 'COMPLETED',
      processorData: {
        ...(typeof payment.processorData === 'object' ? payment.processorData : {}),
        lastStatus: 'CO',
        cryptoAmount: crypto_amount,
        cryptoCurrency: currency,
        txHash: tx_hash,
        confirmations,
        confirmedAt: new Date().toISOString(),
      },
    },
  })

  // Update order status if linked
  if (payment.orderId) {
    await prisma.order.update({
      where: { id: payment.orderId },
      data: {
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        completedAt: new Date(),
        paidAmount: payment.amount,
        remainingBalance: 0,
      },
    })
    logger.info('📦 Order marked as PAID', { orderId: payment.orderId })
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
export async function getPaymentStatus(requestId: string): Promise<{
  status: B4BitPaymentStatus
  cryptoAmount?: string
  cryptoCurrency?: string
  txHash?: string
}> {
  const config = getB4BitConfig()
  const url = `${config.baseUrl}/api/v1/orders/info/${requestId}/`

  try {
    const authToken = await getAuthToken()

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Token ${authToken}`,
        'X-Device-Id': config.deviceId,
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
