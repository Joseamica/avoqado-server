/**
 * B4Bit Webhook Controller
 *
 * Handles webhook notifications from B4Bit crypto payment gateway.
 * Verifies signature and processes payment status updates.
 */

import { Request, Response } from 'express'
import logger from '../../config/logger'
import { processWebhook, verifyWebhookSignature } from '../../services/b4bit/b4bit.service'
import type { B4BitWebhookPayload } from '../../services/b4bit/types'

/**
 * POST /api/v1/webhooks/b4bit
 *
 * Receive and process B4Bit webhook notifications.
 * Always returns 200 to prevent retries (even on error).
 */
export async function handleB4BitWebhook(req: Request, res: Response): Promise<void> {
  const startTime = Date.now()

  try {
    // Get signature headers
    const nonce = req.headers['x-nonce'] as string
    const signature = req.headers['x-signature'] as string

    // Parse body (may be Buffer if using raw body parser)
    let body: string
    let payload: B4BitWebhookPayload

    if (Buffer.isBuffer(req.body)) {
      body = req.body.toString('utf8')
      payload = JSON.parse(body)
    } else if (typeof req.body === 'string') {
      body = req.body
      payload = JSON.parse(body)
    } else {
      body = JSON.stringify(req.body)
      payload = req.body as B4BitWebhookPayload
    }

    logger.info('📥 B4Bit webhook received', {
      identifier: payload.identifier,
      status: payload.status,
      hasSignature: !!signature,
      hasNonce: !!nonce,
    })

    // Verify signature (if secret is configured)
    if (signature && nonce) {
      const isValid = verifyWebhookSignature(nonce, body, signature)
      if (!isValid) {
        logger.warn('⚠️ B4Bit webhook: Invalid signature', {
          identifier: payload.identifier,
        })
        // Still return 200 to prevent retries, but log the issue
        res.status(200).json({
          success: false,
          action: 'ERROR',
          message: 'Invalid signature',
        })
        return
      }
    }

    // Check for timestamp freshness (prevent replay attacks)
    if (nonce) {
      const nonceTime = parseInt(nonce, 10) * 1000 // Convert to milliseconds
      const now = Date.now()
      const maxAge = 20 * 1000 // 20 seconds tolerance

      if (Math.abs(now - nonceTime) > maxAge) {
        logger.warn('⚠️ B4Bit webhook: Stale timestamp', {
          identifier: payload.identifier,
          nonce,
          age: Math.abs(now - nonceTime),
        })
        // Still process but log warning (B4Bit may have delays)
      }
    }

    // Validate required fields
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

    // Process the webhook
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

    // Always return 200 to prevent retries
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
