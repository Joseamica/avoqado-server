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
import { procesarAvisoDeResend } from '../../services/marketing/campaignWebhook.service'

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
export async function handleResendWebhook(req: Request, res: Response, _next: NextFunction) {
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

    // Handle the event — DOS carriles distintos comparten este webhook:
    //   1. Marketing de superadmin (Avoqado → los venues), que es el que ya estaba.
    //   2. Campañas de un negocio a SUS clientes (fase 1B).
    // Se prueba primero el de superadmin para no cambiar en nada su comportamiento; sólo
    // cuando dice que la entrega no es suya se intenta el nuestro.
    const result = await marketingService.handleResendWebhook(event)

    if (!result?.handled) {
      try {
        const propio = await procesarAvisoDeResend(event as any)
        if (propio.manejado) {
          return res.status(200).json({ success: true, handled: true, reason: propio.motivo })
        }
      } catch (error) {
        // 🔴 Aquí SÍ se devuelve 500, al revés que el resto de esta función. El 200-siempre
        // de abajo existe para que Resend no reintente eventos que no nos interesan — pero
        // un fallo procesando un REBOTE es distinto: si lo tragamos, ese correo muerto se
        // queda sin suprimir y lo seguimos intentando, quemando la reputación del subdominio
        // que comparten todos los negocios. Un 500 hace que Resend reintente, que es
        // exactamente lo que queremos.
        logger.error('📧 [Resend Webhook] Falló el procesamiento de una campaña a clientes:', error)
        return res.status(500).json({ success: false, error: 'Error procesando el aviso de campaña' })
      }
    }

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
