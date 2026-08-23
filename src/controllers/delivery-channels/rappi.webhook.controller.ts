/**
 * Webhook de Rappi — controller delgado.
 *
 * Una sola ruta con `:evento` sirve las ONCE URLs que se registran en Rappi (una por evento,
 * exigencia suya): el segmento de la ruta ES el tipo del evento, porque varios cuerpos de
 * Rappi no traen tipo y dos son idénticos entre sí (`rappi.webhookIngress.ts` lo explica).
 *
 * Tres tratos distintos, y la diferencia es deliberada:
 *
 *  · **PING** (cada 3 min por tienda): se verifica la firma y se contesta el cuerpo EXACTO
 *    que Rappi espera — dos pings mal contestados y marca la tienda como caída. NO se
 *    persiste: es un latido, y la regla del repo prohíbe llenar la base de heartbeats.
 *  · **ORDER_RT_TRACKING** (la ubicación del repartidor, continuo): 200 y adiós. Persistir
 *    cada posición del repartidor inflaría la tabla sin que nadie la lea.
 *  · **Todo lo demás**: persist-first — el 200 sólo sale con el evento ya guardado, y el
 *    procesamiento corre después de contestar. Rappi NO documenta reintentos, así que cada
 *    milisegundo antes del 200 es riesgo de perder el evento para siempre.
 */
import { Request, Response } from 'express'

import { env } from '../../config/env'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { rappiAdapter, respuestaPing, RAPPI_EVENTS } from '../../services/delivery-channels/providers/rappi/rappi.adapter'
import { processRappiEvent } from '../../services/delivery-channels/providers/rappi/rappi.eventProcessor'
import {
  eventoDeLaRuta,
  persistRappiWebhookEvent,
  secretosDelEvento,
} from '../../services/delivery-channels/providers/rappi/rappi.webhookIngress'
import { verifyRappiSignature } from '../../services/delivery-channels/providers/rappi/rappi.signature'

function headerFirma(req: Request): string | undefined {
  const crudo = req.headers['rappi-signature']
  return Array.isArray(crudo) ? crudo[0] : crudo
}

export async function handleRappiWebhook(req: Request, res: Response): Promise<void> {
  // El body DEBE llegar como Buffer: la firma se calcula sobre `timestamp.bytes` crudos.
  if (!Buffer.isBuffer(req.body)) {
    logger.error('[🔴 RappiWebhook] body no es Buffer — revisar montaje express.raw en app.ts')
    res.status(503).end()
    return
  }

  const evento = eventoDeLaRuta(req.params.evento)
  if (!evento) {
    // Una URL que no registramos no es "firma inválida": es un mensaje que ni va dirigido a
    // nosotros. 404 y sin ruido.
    res.status(404).end()
    return
  }

  const secrets = secretosDelEvento(env.RAPPI_WEBHOOK_SECRETS, evento)

  // ── Latidos: se contestan, no se guardan ──────────────────────────────────────────
  if (evento === RAPPI_EVENTS.PING || evento === RAPPI_EVENTS.ORDER_RT_TRACKING) {
    if (!secrets.some(s => verifyRappiSignature(req.body as Buffer, headerFirma(req), s))) {
      res.status(401).end()
      return
    }

    if (evento === RAPPI_EVENTS.ORDER_RT_TRACKING) {
      res.status(200).end()
      return
    }

    // El PING espera `{status:"OK", description}`. La descripción es el nombre del negocio
    // si la tienda está vinculada — y OK aunque no lo esté: la pregunta es "¿estás ahí para
    // recibir?", y sí estamos; el vínculo pendiente es un problema de alta, no de vida.
    let nombre: string | null = null
    try {
      const identidad = rappiAdapter.extractIdentity(JSON.parse((req.body as Buffer).toString('utf8')))
      if (identidad.storeId) {
        const link = await prisma.deliveryChannelLink.findUnique({
          where: { provider_externalLocationId: { provider: 'RAPPI', externalLocationId: identidad.storeId } },
          select: { venue: { select: { name: true } } },
        })
        nombre = link?.venue?.name ?? null
      }
    } catch {
      // Un PING ilegible igual se contesta OK: el proceso está vivo, que es lo que pregunta.
    }
    res.status(200).json(respuestaPing(nombre))
    return
  }

  // ── Todo lo demás: persist-first ──────────────────────────────────────────────────
  try {
    const r = await persistRappiWebhookEvent({
      rawBody: req.body as Buffer,
      signatureHeader: headerFirma(req),
      evento,
      secrets,
    })

    if (r.outcome === 'INVALID_SIGNATURE') {
      res.status(401).end()
      return
    }
    if (r.outcome === 'MALFORMED') {
      res.status(400).end()
      return
    }

    // DUPLICATE también es 200: reintentar no aportaría nada, ya lo tenemos.
    res.status(200).end()

    if (r.outcome === 'PERSISTED' && r.eventRowId) {
      // DESPUÉS del 200, nunca antes: Rappi no documenta reintentos, así que retener la
      // respuesta mientras se procesa es apostar el evento a que nada truene en medio.
      void processRappiEvent(r.eventRowId).catch(err => {
        logger.error('🚨 [RappiWebhook] el procesamiento tronó tras el ACK (el evento quedó guardado)', {
          eventRowId: r.eventRowId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
  } catch (err) {
    // Fallo de PERSISTENCIA: aquí sí 503 — es la única esperanza de que Rappi reintente.
    logger.error('🚨 [RappiWebhook] no se pudo persistir el evento', {
      evento,
      error: err instanceof Error ? err.message : String(err),
    })
    res.status(503).end()
  }
}

export function rappiWebhookHealthCheck(_req: Request, res: Response): void {
  res.status(200).json({ ok: true, provider: 'RAPPI' })
}
