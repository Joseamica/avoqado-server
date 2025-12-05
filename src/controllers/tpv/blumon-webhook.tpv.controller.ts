/**
 * Blumon TPV Webhook Controller
 *
 * Layer 4 of the 4-layer payment reconciliation strategy:
 * 1. Android SDK → Blumon (direct payment processing)
 * 2. Android → Backend (payment recording)
 * 3. Backend validation (merchantAccountId fallback)
 * 4. Blumon webhook (independent confirmation) ← THIS CONTROLLER
 *
 * This webhook receives payment confirmations directly from Blumon.
 * Provide this URL to Edgardo at Blumon: POST /api/v1/webhooks/blumon/tpv
 *
 * @see BlumonWebhookPayload for the expected request body format
 */

import { Request, Response, NextFunction } from 'express'
import logger from '../../config/logger'
import { processBlumonPaymentWebhook, validateBlumonWebhookPayload, BlumonWebhookPayload } from '../../services/tpv/blumon-webhook.service'

/**
 * Handle Blumon TPV payment confirmation webhook
 * POST /webhooks/blumon/tpv
 *
 * This endpoint receives payment confirmations from Blumon after
 * a transaction is processed on a PAX terminal.
 *
 * Use cases:
 * - Reconcile payments that Android failed to record
 * - Verify amounts match between Blumon and our records
 * - Detect discrepancies for investigation
 *
 * @example Request body from Blumon:
 * {
 *   "bin": "411111",
 *   "lastFour": "1111",
 *   "cardType": "DEBITO",
 *   "brand": "VISA",
 *   "bank": "BANORTE",
 *   "amount": "908.02",
 *   "reference": "20210120182438251",
 *   "cardHolder": "HOMER SIMPSON",
 *   "authorizationCode": "483347",
 *   "operationType": "VENTA",
 *   "operationNumber": 29556,
 *   "descriptionResponse": "APROBADA",
 *   "dateTransaction": "20/01/2021 18:24:38",
 *   "authentication": "unknown",
 *   "membership": "8226471",
 *   "provideResponse": "SB",
 *   "codeResponse": "00"
 * }
 */
export async function handleBlumonTPVWebhook(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const correlationId = `blumon-wh-${Date.now()}`

  // Get source IP for whitelist configuration
  const sourceIP =
    req.headers['x-forwarded-for'] ||
    req.headers['x-real-ip'] ||
    req.headers['cf-connecting-ip'] ||
    req.ip ||
    req.socket?.remoteAddress ||
    'unknown'

  logger.info('📥 Blumon TPV webhook received', {
    correlationId,
    method: req.method,
    path: req.path,
    contentType: req.headers['content-type'],
    bodyPresent: !!req.body,
  })

  // Log IP separately to ensure it's visible
  // logger.info(`🌐 BLUMON WEBHOOK SOURCE IP: ${sourceIP}`)

  // ⚠️ CRITICAL: Parse raw Buffer body
  // All webhooks use express.raw() for Stripe compatibility,
  // so Blumon's JSON arrives as a Buffer that needs parsing
  let body = req.body
  if (Buffer.isBuffer(req.body)) {
    try {
      const rawString = req.body.toString('utf8')
      body = JSON.parse(rawString)
      logger.info('📦 Blumon webhook: Parsed Buffer body successfully', {
        correlationId,
        parsedFields: Object.keys(body),
        fullPayload: body, // Log full payload to understand Blumon's format
      })
    } catch (parseError) {
      logger.error('❌ Blumon webhook: Failed to parse Buffer body', {
        correlationId,
        error: parseError instanceof Error ? parseError.message : 'Unknown parse error',
        rawBodyPreview: req.body.toString('utf8').substring(0, 200),
      })
      res.status(400).json({
        success: false,
        error: 'Invalid JSON in request body',
      })
      return
    }
  }

  // Validate the payload structure
  if (!validateBlumonWebhookPayload(body)) {
    logger.warn('⚠️ Blumon webhook: Invalid payload structure', {
      correlationId,
      body: JSON.stringify(body).substring(0, 500), // Truncate for logging
    })

    res.status(400).json({
      success: false,
      error: 'Invalid payload structure',
      message: 'Required fields: amount, reference, operationNumber, codeResponse, descriptionResponse, operationType',
    })
    return
  }

  const payload = body as BlumonWebhookPayload

  try {
    // Process the payment confirmation
    const result = await processBlumonPaymentWebhook(payload)

    logger.info('📤 Blumon webhook processed', {
      correlationId,
      action: result.action,
      success: result.success,
      paymentId: result.paymentId,
      reference: payload.reference,
    })

    // Always return 200 to Blumon to acknowledge receipt
    // Even if there's a discrepancy, we've logged it for investigation
    res.status(200).json({
      success: result.success,
      action: result.action,
      message: result.message,
      paymentId: result.paymentId,
      details: result.details,
    })
  } catch (error) {
    logger.error('❌ Blumon webhook: Unexpected error', {
      correlationId,
      reference: payload.reference,
      operationNumber: payload.operationNumber,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    })

    // Still return 200 to prevent Blumon from retrying
    // Log the error for manual investigation
    res.status(200).json({
      success: false,
      action: 'ERROR',
      message: 'Webhook received but processing encountered an error',
      reference: payload.reference,
    })
  }
}

/**
 * Health check endpoint for Blumon to verify webhook connectivity
 * GET /webhooks/blumon/tpv/health
 */
export function blumonWebhookHealthCheck(_req: Request, res: Response): void {
  res.status(200).json({
    success: true,
    message: 'Blumon TPV webhook endpoint is healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  })
}
