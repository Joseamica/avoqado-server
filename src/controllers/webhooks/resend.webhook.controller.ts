/**
 * Resend Webhook Controller
 *
 * Handles webhook events from Resend for email tracking:
 * - email.opened - Track when recipients open emails
 * - email.clicked - Track when recipients click links
 * - email.bounced - Mark delivery as bounced
 * - email.bounced (Permanent) y email.complained - suprimen la dirección para todos los carriles
 *
 * Webhook signature verification uses Svix (Resend's webhook provider)
 */

import { Request, Response, NextFunction } from 'express'
import { EmailSuppressionReason } from '@prisma/client'
import { Webhook } from 'svix'
import logger from '@/config/logger'
import * as marketingService from '../../services/superadmin/marketing.superadmin.service'
import { procesarAvisoDeResend } from '../../services/marketing/campaignWebhook.service'
import { procesarAvisoCrm } from '../../services/crm/email/campaignWebhook.service'
import { recordSuppression } from '../../services/marketing/emailSuppression.service'
import { FALLO_FINAL_DE_CORREO, marcarEntregaFallidaPorMensaje } from '../../services/giftCards/giftCardDelivery.service'

/**
 * Los avisos que CAMBIAN un estado en algún carril: si uno truena antes de llegar al carril que lo maneja, se contesta 500 para que
 * Resend lo reintente (con 200 se pierde para siempre). Rebote y queja: los cuatro carriles. Fallo y supresión de Resend: tarjetas de
 * regalo y CRM (Codex código r2 P2). Apertura y clic: marketing viejo y campañas a clientes. Los demás (`email.sent`, `email.delivered`,
 * `email.delivery_delayed`…) no cambian nada que importe —el CRM sólo apunta el `resendId`, y su tag lo encuentra igual— y siguen en 200.
 */
const AVISOS_QUE_CAMBIAN_UN_ESTADO = new Set([
  'email.bounced',
  'email.complained',
  'email.failed',
  'email.suppressed',
  'email.opened',
  'email.clicked',
])

/**
 * Por qué hay que dejar de escribirle a esa dirección, si es que hay que dejarlo.
 *
 * 🔴 Sólo un rebote `Permanent` suprime (un `Transient` —buzón lleno, servidor caído— es temporal y suprimirlo dejaría a un
 * cliente bueno sin correo para siempre); una queja suprime SIEMPRE. Misma regla que `campaignWebhook.service.ts`.
 */
function motivoDeSupresion(event: marketingService.ResendWebhookPayload): EmailSuppressionReason | null {
  if (event.type === 'email.complained') return EmailSuppressionReason.COMPLAINT
  if (event.type === 'email.bounced' && event.data?.bounce?.type === 'Permanent') return EmailSuppressionReason.HARD_BOUNCE
  return null
}

/**
 * Secreto de firma de Resend (Svix). Se lee en CADA llamada, nunca en una constante de módulo.
 *
 * 🔴 Con la constante, el valor quedaba congelado al importar — y en jest `process.env` es
 * compartido por todas las suites de un worker: `config/env.ts` carga el `.env` real con
 * `dotenv.config()`, así que la MISMA prueba pasaba sola y fallaba 4/4 en `pre-deploy` según qué
 * suite hubiera corrido antes (2026-09-04). Leerlo aquí vuelve el comportamiento función del
 * request, no del orden de importación.
 */
function resendWebhookSecret(): string | undefined {
  return process.env.RESEND_WEBHOOK_SECRET
}

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

    const secret = resendWebhookSecret()
    if (!secret) {
      // 🔴 Sin secreto no hay cómo saber que el aviso viene de Resend: cualquiera podía marcar correos como
      // rebotados y suprimirlos (auditoría 2026-09-30). 503 = Resend reintenta cuando el secreto vuelva.
      logger.error('📧 [Resend Webhook] RESEND_WEBHOOK_SECRET no está configurado: aviso rechazado')
      return res.status(503).json({
        success: false,
        error: 'Webhook signature secret not configured',
      })
    }

    if (!svixId || !svixTimestamp || !svixSignature) {
      logger.warn('📧 [Resend Webhook] Missing Svix headers')
      return res.status(400).json({
        success: false,
        error: 'Missing webhook signature headers',
      })
    }

    try {
      const wh = new Webhook(secret)
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

    // Reputación (CRM fase 2, tarea 1): un rebote Permanent o una queja suprimen la dirección ANTES de cualquier carril, sea de
    // la campaña vieja del superadmin, de las campañas a clientes de un negocio, del CRM o un correo transaccional. Así la
    // supresión no depende de qué carril mandó el correo ni de que el carril anterior le conteste «no es mío». Es idempotente
    // (upsert). Si falla, 500 para que Resend reintente: tragarlo deja un correo muerto sin suprimir, y lo seguimos intentando
    // contra la reputación del subdominio que comparten todos. Los carriles de abajo siguen marcando su propia entrega.
    const motivo = motivoDeSupresion(event)
    const destinatario = event.data?.to?.[0]
    if (motivo && destinatario) {
      try {
        await recordSuppression(destinatario, motivo)
      } catch (error) {
        logger.error('📧 [Resend Webhook] Falló suprimir una dirección que rebotó o se quejó:', error)
        return res.status(500).json({ success: false, error: 'Error suprimiendo la dirección' })
      }
    }

    // Tarjetas de regalo (1b S3, Q105): un correo de tarjeta que rebotó, se suprimió o falló ⇒ «No se entregó». Va ANTES de
    // los carriles de marketing. Si falla, 500 para que Resend reintente (como el
    // carril de campañas, abajo); el CAS por `deliveryMessageId` lo vuelve idempotente y no encuentra los correos que no son de
    // tarjetas. Después sigue igual que siempre.
    const falloDeTarjeta = FALLO_FINAL_DE_CORREO[event.type]
    if (falloDeTarjeta && event.data?.email_id) {
      try {
        await marcarEntregaFallidaPorMensaje(event.data.email_id, falloDeTarjeta)
      } catch (error) {
        logger.error('📧 [Resend Webhook] Falló marcar la entrega de una tarjeta de regalo:', error)
        return res.status(500).json({ success: false, error: 'Error procesando el aviso de una tarjeta de regalo' })
      }
    }

    // Handle the event — TRES carriles distintos comparten este webhook:
    //   1. Marketing de superadmin (Avoqado → los venues), que es el que ya estaba.
    //   2. Campañas de un negocio a SUS clientes (fase 1B).
    //   3. Campañas de plataforma del CRM (fase 2 del CRM).
    // Se prueba primero el de superadmin para no cambiar en nada su comportamiento; sólo
    // cuando dice que la entrega no es suya se intenta el nuestro. «No es suya» incluye ahora los rebotes y quejas de una
    // entrega que no tiene `CampaignDelivery` (antes los daba por manejados y el carril de clientes no los veía nunca). La
    // supresión de la dirección ya se hizo arriba, para todos los carriles. El del CRM va al final: sólo ve lo que los otros dos
    // dijeron que no es suyo.
    let result: Awaited<ReturnType<typeof marketingService.handleResendWebhook>>
    try {
      result = await marketingService.handleResendWebhook(event)
    } catch (error) {
      // Un aviso que cambia un estado no se pierde con un 200: 500 para que Resend reintente. Los demás siguen como siempre (lo
      // atrapa el catch de afuera y contesta 200).
      if (!AVISOS_QUE_CAMBIAN_UN_ESTADO.has(event.type)) throw error
      logger.error('📧 [Resend Webhook] Falló el carril de marketing de superadmin con un aviso que cambia un estado:', error)
      return res.status(500).json({ success: false, error: 'Error procesando el aviso' })
    }

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

      // 3. Campañas de plataforma del CRM (Avoqado a sus prospectos, clientes y usuarios). Igual que el carril de clientes:
      // si falla, 500 para que Resend reintente; un rebote o una queja perdidos dejarían la delivery como si hubiera llegado.
      try {
        const crm = await procesarAvisoCrm(event as any)
        if (crm.manejado) {
          return res.status(200).json({ success: true, handled: true, reason: 'Campaña del CRM' })
        }
      } catch (error) {
        logger.error('📧 [Resend Webhook] Falló el procesamiento de una campaña del CRM:', error)
        return res.status(500).json({ success: false, error: 'Error procesando el aviso de una campaña del CRM' })
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
    configured: !!resendWebhookSecret(),
  })
}
