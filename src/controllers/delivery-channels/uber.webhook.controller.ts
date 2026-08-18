/**
 * Webhook de Uber Eats — controller delgado (spec paso 3).
 *
 * Uber manda UNA sola URL por aplicación (no una por tienda), así que aquí no
 * hay `:channelLinkId` en la ruta: el link se resuelve por el `store_id` que
 * viene DENTRO del payload firmado.
 *
 * [doc] Uber espera **200 con body VACÍO**. Por eso `res.status(200).end()` y
 * nunca `sendStatus(200)`, que mandaría el texto "OK".
 *
 * Responde 200 incluso ante duplicado o tienda desconocida: reintentar no
 * aportaría nada y el evento ya quedó guardado para revisión. Solo un fallo de
 * persistencia devuelve 503, que es cuando SÍ queremos que Uber reintente.
 */
import { Request, Response } from 'express'
import logger from '../../config/logger'
import { env } from '../../config/env'
import { persistUberWebhookEvent } from '../../services/delivery-channels/providers/uber-eats/uber.webhookIngress'

export async function handleUberWebhook(req: Request, res: Response): Promise<void> {
  // El body DEBE llegar como Buffer: la firma se calcula sobre los bytes crudos.
  // Si no llega así, es misconfiguración del montaje raw — 503 para que reintente.
  if (!Buffer.isBuffer(req.body)) {
    logger.error('[🔴 UberWebhook] body no es Buffer — revisar montaje express.raw en app.ts')
    res.status(503).end()
    return
  }

  const signingKeys = [env.UBER_WEBHOOK_SIGNING_KEY, env.UBER_WEBHOOK_SIGNING_KEY_SECONDARY].filter(
    (k): k is string => typeof k === 'string' && k.length > 0,
  )
  if (signingKeys.length === 0) {
    logger.error('[🔴 UberWebhook] UBER_WEBHOOK_SIGNING_KEY no configurada — no se puede verificar firma')
    res.status(503).end()
    return
  }

  const signatureHeader = req.header('X-Uber-Signature') ?? undefined

  try {
    const result = await persistUberWebhookEvent({ rawBody: req.body, signatureHeader, signingKeys })

    if (result.outcome === 'INVALID_SIGNATURE') {
      logger.warn('[⚠️ UberWebhook] firma inválida — descartado')
      res.status(401).end()
      return
    }
    if (result.outcome === 'MALFORMED') {
      logger.warn('[⚠️ UberWebhook] payload sin event_id/event_type — descartado')
      res.status(400).end()
      return
    }

    logger.info(`[✅ UberWebhook] evento ${result.outcome}`, { eventRowId: result.eventRowId })
    res.status(200).end()
  } catch (error) {
    // No se pudo persistir ⇒ 503 para que Uber reintente (contrato persist-first)
    logger.error('[🔴 UberWebhook] fallo al persistir el evento', {
      error: error instanceof Error ? error.message : 'desconocido',
    })
    res.status(503).end()
  }
}

export function uberWebhookHealthCheck(_req: Request, res: Response): void {
  res.status(200).json({ ok: true, provider: 'UBER_EATS', configured: Boolean(env.UBER_WEBHOOK_SIGNING_KEY) })
}
