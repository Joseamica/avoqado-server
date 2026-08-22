/**
 * Webhook de DiDi Food — controller delgado.
 *
 * Dos cosas lo separan del de Uber y las dos son suyas, no elección nuestra:
 *
 * 1. **DiDi espera un JSON, no un 200 vacío.** Quiere `{"errno":0,"errmsg":"ok"}`. Con
 *    cualquier otra cosa —incluido un 200 sin cuerpo— reintenta varias veces.
 * 2. **Tiene 6 segundos de límite.** Por eso se contesta ANTES de procesar: traer, mapear y
 *    confirmar un pedido tarda más que eso, y si expira DiDi reintenta mientras corre el
 *    reloj de 5 minutos que tenemos para confirmar. Se perdería el pedido por lento.
 */
import { Request, Response } from 'express'

import { env } from '../../config/env'
import logger from '../../config/logger'
import { persistDidiWebhookEvent } from '../../services/delivery-channels/providers/didi-food/didi.webhookIngress'

/** El ACK que DiDi exige para dar el evento por entregado. */
const ACK_OK = { errno: 0, errmsg: 'ok' }

export async function handleDidiWebhook(req: Request, res: Response): Promise<void> {
  // El body DEBE llegar como Buffer: la firma se calcula sobre los bytes crudos. Si no
  // llega así es misconfiguración del montaje `express.raw` en app.ts.
  if (!Buffer.isBuffer(req.body)) {
    logger.error('[🔴 DidiWebhook] body no es Buffer — revisar montaje express.raw en app.ts')
    res.status(503).json({ errno: 1, errmsg: 'body must be raw' })
    return
  }

  // Los dos ambientes tienen secretos distintos y la misma URL de callback, así que se
  // prueban ambos. No es laxitud: es lo que permite que la app de prueba y la de producción
  // convivan sin dos endpoints.
  const secretos = [env.DIDI_APP_SECRET_PRODUCTION, env.DIDI_APP_SECRET_SANDBOX].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  )
  if (secretos.length === 0) {
    logger.error('[🔴 DidiWebhook] DIDI_APP_SECRET_* no configurado — no se puede verificar firma')
    res.status(503).json({ errno: 1, errmsg: 'not configured' })
    return
  }

  const firma = req.header('didi-header-sign') ?? undefined

  try {
    let resultado = await persistDidiWebhookEvent({ rawBody: req.body, signatureHeader: firma, appSecret: secretos[0] })
    for (let i = 1; i < secretos.length && resultado.outcome === 'INVALID_SIGNATURE'; i++) {
      resultado = await persistDidiWebhookEvent({ rawBody: req.body, signatureHeader: firma, appSecret: secretos[i] })
    }

    if (resultado.outcome === 'INVALID_SIGNATURE') {
      logger.warn('[⚠️ DidiWebhook] firma inválida — descartado')
      res.status(401).json({ errno: 1, errmsg: 'invalid signature' })
      return
    }
    if (resultado.outcome === 'MALFORMED') {
      logger.warn('[⚠️ DidiWebhook] sobre sin `type` — descartado')
      res.status(400).json({ errno: 1, errmsg: 'malformed payload' })
      return
    }

    // Duplicado también contesta OK: es un reintento de DiDi porque no alcanzó a leer
    // nuestra respuesta anterior. Contestar error haría que siga reintentando para siempre
    // algo que ya tenemos guardado.
    logger.info(`[✅ DidiWebhook] evento ${resultado.outcome}`, { tipo: resultado.type, eventRowId: resultado.eventRowId })
    res.status(200).json(ACK_OK)
  } catch (error) {
    // 🔴 Un fallo de PERSISTENCIA sí devuelve error: es justo cuando queremos que DiDi
    // reintente, porque el evento no quedó en ningún lado.
    logger.error('[🔴 DidiWebhook] no se pudo guardar el evento', {
      error: error instanceof Error ? error.message : String(error),
    })
    res.status(503).json({ errno: 1, errmsg: 'could not persist' })
  }
}

/** Sonda para confirmar que la URL del callback responde antes de darla de alta en DiDi. */
export function didiWebhookHealthCheck(_req: Request, res: Response): void {
  res.status(200).json({ errno: 0, errmsg: 'ok', configured: Boolean(env.DIDI_APP_SECRET_PRODUCTION || env.DIDI_APP_SECRET_SANDBOX) })
}
