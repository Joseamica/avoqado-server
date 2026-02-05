/**
 * Resend Webhook Controller
 *
 * Handles webhook events from Resend for email tracking:
 * - email.opened - Track when recipients open emails
 * - email.clicked - Track when recipients click links
 * - email.bounced - Mark delivery as bounced
 *
 * Webhook signature verification uses Svix (Resend's webhook provider)
 */

import { Request, Response, NextFunction } from 'express'
import { Webhook } from 'svix'
import logger from '@/config/logger'
import * as marketingService from '../../services/superadmin/marketing.superadmin.service'

// Resend webhook signing secret from environment
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET

/**
 * Handle Resend webhook events
 * POST /api/v1/webhooks/resend
 *
 * Resend uses Svix for webhook delivery, which provides:
 * - Signature verification via svix-id, svix-timestamp, svix-signature headers
 * - Automatic retries with exponential backoff
 * - Event deduplication
 */
export async function handleResendWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    // Get the raw body as string (webhook routes use express.raw())
    const payload = req.body.toString('utf-8')

    // Get Svix headers
    const svixId = req.headers['svix-id'] as string
    const svixTimestamp = req.headers['svix-timestamp'] as string
    const svixSignature = req.headers['svix-signature'] as string

    // Verify signature if secret is configured
    if (RESEND_WEBHOOK_SECRET) {
      if (!svixId || !svixTimestamp || !svixSignature) {
        logger.warn('📧 [Resend Webhook] Missing Svix headers')
        return res.status(400).json({
          success: false,
          error: 'Missing webhook signature headers',
        })
      }

      try {
        const wh = new Webhook(RESEND_WEBHOOK_SECRET)
        wh.verify(payload, {
          'svix-id': svixId,
          'svix-timestamp': svixTimestamp,
          'svix-signature': svixSignature,
        })
      } catch (err) {
        logger.error('📧 [Resend Webhook] Signature verification failed:', err)
        return res.status(400).json({
          success: false,
          error: 'Invalid webhook signature',
        })
      }
    } else {
      logger.warn('📧 [Resend Webhook] RESEND_WEBHOOK_SECRET not configured - skipping signature verification')
    }

    // Parse the payload
    let event: marketingService.ResendWebhookPayload
    try {
      event = JSON.parse(payload)
    } catch (err) {
      logger.error('📧 [Resend Webhook] Invalid JSON payload:', err)
      return res.status(400).json({
        success: false,
        error: 'Invalid JSON payload',
      })
    }

    logger.info(`📧 [Resend Webhook] Received event: ${event.type}, email_id: ${event.data?.email_id}`)

    // Handle the event
    const result = await marketingService.handleResendWebhook(event)

    // Always return 200 to acknowledge receipt (prevent retries)
    return res.status(200).json({
      success: true,
      ...result,
    })
  } catch (error) {
    logger.error('📧 [Resend Webhook] Error processing webhook:', error)
    // Still return 200 to prevent retries
    return res.status(200).json({
      success: false,
      error: 'Internal error processing webhook',
    })
  }
}

/**
 * Health check endpoint for Resend webhook
 * GET /api/v1/webhooks/resend/health
 */
export function resendWebhookHealthCheck(req: Request, res: Response) {
  return res.status(200).json({
    success: true,
    message: 'Resend webhook endpoint is healthy',
    timestamp: new Date().toISOString(),
    configured: !!RESEND_WEBHOOK_SECRET,
  })
}
