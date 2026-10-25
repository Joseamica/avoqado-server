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
 *    que Rappi espera — dos pings mal contestados y marca la tienda como caída. 🔴 La respuesta
 *    dice la verdad POR TIENDA (`veredictoDelPing`): OK sólo con vínculo vivo, tienda permitida y
 *    llaves. NO se persiste: es un latido, y la regla del repo prohíbe llenar la base de heartbeats.
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
import { credencialesPresentes, tiendasEscribiblesRappi } from '../../services/delivery-channels/providers/rappi/rappi.client'
import { processRappiEvent } from '../../services/delivery-channels/providers/rappi/rappi.eventProcessor'
import {
  ESTADOS_VIVOS_RAPPI,
  eventoDeLaRuta,
  persistRappiWebhookEvent,
  secretosDelEvento,
} from '../../services/delivery-channels/providers/rappi/rappi.webhookIngress'
import { verifyRappiSignature } from '../../services/delivery-channels/providers/rappi/rappi.signature'

function headerFirma(req: Request): string | undefined {
  const crudo = req.headers['rappi-signature']
  return Array.isArray(crudo) ? crudo[0] : crudo
}

/**
 * Los estados de un vínculo que siguen "ahí para recibir": `ESTADOS_VIVOS_RAPPI` (`rappi.webhookIngress.ts`, con su porqué).
 * Es la MISMA lista que usa el sondeo por tienda: el PING y el sondeo nunca dicen cosas distintas de la misma tienda.
 */
const ESTADOS_VIVOS: ReadonlySet<string> = ESTADOS_VIVOS_RAPPI

type VeredictoPing = { storeId: string | null } & (
  | { ok: true; nombre: string | null }
  // `critico`: no se pudo ni preguntar (la base o la configuración tronaron). Necesita a una persona; el resto es estado.
  | { ok: false; motivo: string; critico?: boolean }
)

/**
 * ¿Esta tienda está de verdad lista para recibir pedidos? OK sólo si se cumplen LAS TRES a la vez:
 *   1. hay un vínculo RAPPI de ese `store_id` en ACTIVE, PAUSED o PENDING;
 *   2. la tienda está en `tiendasEscribiblesRappi()` (donde podemos contestarle a Rappi);
 *   3. `credencialesPresentes()`.
 * Cualquier otra cosa —incluida una consulta que falla o un cuerpo ilegible— es no-OK: un OK mentiroso deja que Rappi siga
 * mandando pedidos que no vamos a poder aceptar. Nunca lanza. El `motivo` es para el log; a Rappi no se le dice cuál faltó.
 */
async function veredictoDelPing(rawBody: Buffer): Promise<VeredictoPing> {
  let storeId: string | null = null
  try {
    try {
      storeId = rappiAdapter.extractIdentity(JSON.parse(rawBody.toString('utf8'))).storeId
    } catch {
      return { ok: false, storeId, motivo: 'el PING no trae un cuerpo legible' }
    }
    if (!storeId) return { ok: false, storeId, motivo: 'el PING no trae store_id' }

    // `provider_externalLocationId` es único: una sola fila, y sólo las dos columnas que usa la respuesta.
    const vinculo = await prisma.deliveryChannelLink.findUnique({
      where: { provider_externalLocationId: { provider: 'RAPPI', externalLocationId: storeId } },
      select: { status: true, venue: { select: { name: true } } },
    })
    if (!vinculo) return { ok: false, storeId, motivo: 'la tienda no tiene vínculo RAPPI' }
    if (!ESTADOS_VIVOS.has(vinculo.status)) return { ok: false, storeId, motivo: `el vínculo está ${vinculo.status}` }
    if (!tiendasEscribiblesRappi().includes(storeId)) {
      return { ok: false, storeId, motivo: 'la tienda no está en la lista de escritura del ambiente' }
    }
    if (!credencialesPresentes()) return { ok: false, storeId, motivo: 'faltan las credenciales de la integración' }

    return { ok: true, storeId, nombre: vinculo.venue?.name ?? null }
  } catch (error) {
    return {
      ok: false,
      storeId,
      critico: true,
      motivo: `no se pudo verificar la tienda: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
    }
  }
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

    // El PING espera `{status, description}`: OK si la tienda de verdad puede recibir pedidos y ERROR si no. Va con HTTP 200
    // en los dos casos: Rappi lee el CUERPO (cualquier `status` distinto de OK = tienda caída), y un 5xx nuestro sería
    // indistinguible de un servidor caído. Lo que falló se queda en el log, nunca en la respuesta.
    const veredicto = await veredictoDelPing(req.body as Buffer)
    if (!veredicto.ok) {
      const dato = { storeId: veredicto.storeId, motivo: veredicto.motivo }
      if (veredicto.critico) logger.error('🚨 [RappiWebhook] el PING no se pudo verificar: se contesta ERROR', dato)
      else logger.warn('[RappiWebhook] el PING contesta ERROR', dato)
    }
    res.status(200).json(respuestaPing(veredicto.ok ? { ok: true, nombre: veredicto.nombre } : { ok: false, motivo: veredicto.motivo }))
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
