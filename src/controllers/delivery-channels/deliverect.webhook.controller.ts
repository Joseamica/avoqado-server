/**
 * Deliverect Order Webhook Controller
 *
 * Recibe pedidos entrantes de canales de delivery (Uber Eats, Rappi, DiDi Food)
 * a través del agregador Deliverect. Contrato ACK (patrón Blumon, persist-first):
 *
 * 1. 401 — HMAC inválido (firma sobre el body crudo, `deliverect.hmac.ts`, Task 2)
 * 2. 404 — channelLinkId inexistente o DISABLED
 * 3. 400 — payload inválido (mapper no pudo normalizar, `deliverect.mapper.ts`, Task 3)
 * 4. 200 SOLO después de persistir el DeliveryOrderEvent (`deliveryWebhookEvent.service.ts`)
 *    con el `eventType` clasificado (Fix C5, spec §10.1.8 — ver `classifyDeliverectEventType`
 *    abajo: 'order' | 'cancel' | 'status', NUNCA hardcoded 'order'):
 *    - DUPLICATE (mismo evento re-enviado, @@unique dedup POR eventType) → 200 sin re-procesar
 *    - eventType !== 'order' ('cancel'/'status') → 200 CANCEL_RECEIVED/STATUS_RECEIVED — el
 *      evento queda persistido DISTINTO del 'order' original (no lo pisa el dedup) pero el
 *      pipeline de ingesta normal NO corre sobre él (ver REVALIDAR EN STAGING abajo).
 *    - PROCESSED (ingesta OK, solo eventType 'order') → 200
 *    - FAILED_WILL_RETRY (ingesta falló DESPUÉS de persistir) → 200, el evento
 *      queda marcado FAILED para que la reconciliación lo reintente — el
 *      proveedor NO debe re-postear, ya tenemos el evento guardado.
 * 5. 503 — no se pudo ni persistir el evento (DB caída, etc.) o req.body no llegó
 *    como Buffer (misconfiguración del mounting raw-body) → Deliverect debe
 *    reintentar; el retry es seguro porque dedupamos por externalEventId.
 *
 * Bookkeeping (markEventResult) nunca cambia la verdad del ACK: evento
 * persistido => jamás 503; ingesta OK => jamás FAILED. Si un write de
 * bookkeeping falla, el evento queda RECEIVED y la reconciliación lo levanta.
 */

import { Request, Response } from 'express'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { DeliveryOrderEventStatus, DeliveryProvider } from '@prisma/client'
import { verifyDeliverectHmac, DELIVERECT_HMAC_HEADER } from '../../services/delivery-channels/providers/deliverect/deliverect.hmac'
import { parseDeliverectOrder } from '../../services/delivery-channels/providers/deliverect/deliverect.mapper'
import { ingestDeliveryOrder } from '../../services/delivery-channels/core/deliveryOrderIngestion.service'
import { persistDeliveryEvent, markEventResult } from '../../services/delivery-channels/core/deliveryWebhookEvent.service'
import { NormalizedDeliveryOrder } from '../../services/delivery-channels/core/types'

/**
 * Fix C5 (auditoría G-Stack + Codex, 2026-07-19, spec §10.1.8): Deliverect manda
 * cancelaciones sobre el MISMO webhook de orders, con el MISMO channelOrderId,
 * distinguidas SOLO por `status === 100`. Doc:
 * https://developers.deliverect.com/reference/create-channel-order
 *
 * Antes: TODO se persistía hardcoded `eventType: 'order'` → el dedup
 * (`@@unique([provider, externalEventId, eventType])`) clasificaba la cancelación
 * como DUPLICATE del pedido original y la ACKeaba sin re-procesar — el pedido
 * local quedaba CONFIRMED/PAID para siempre.
 *
 * REVALIDAR EN STAGING: la doc revisada solo confirma `status === 100` = cancelación
 * sobre ESTE payload — no enumera qué otros valores de `status` representan una
 * actualización de estado (vs. una orden nueva) en el mismo shape. Tratamos
 * ausente/0 como 'order' (pedido nuevo, coincide con el fixture real sin `status`) y
 * cualquier OTRO numérico distinto de 100 como 'status' — más seguro que asumir que
 * es una orden nueva y volver a correr la ingesta sobre un pedido ya conocido.
 */
function classifyDeliverectEventType(payload: unknown): 'order' | 'cancel' | 'status' {
  const status = (payload as any)?.status
  if (status === 100) return 'cancel'
  if (typeof status === 'number' && status !== 0) return 'status'
  return 'order'
}

/**
 * POST /api/v1/webhooks/delivery/deliverect/:channelLinkId/orders
 *
 * Mismo router raw-body ya montado en app.ts (`express.raw({ type: 'application/json' })`
 * sobre `/api/v1/webhooks`) — req.body llega como Buffer.
 */
export async function handleDeliverectOrderWebhook(req: Request, res: Response): Promise<void> {
  try {
    // El router raw-body (express.raw en app.ts) SIEMPRE debe entregar un Buffer.
    // Si no lo es, es una misconfiguración de mounting (NO una firma inválida):
    // re-serializar con JSON.stringify jamás reproduce los bytes firmados, así que
    // el HMAC fallaría en silencio con 401 y Deliverect DESCARTARÍA el pedido.
    // 503 = transitorio: fuerza retry mientras se arregla la config.
    if (!Buffer.isBuffer(req.body)) {
      logger.error('[🛵 DeliverectWebhook] req.body NO es Buffer — misconfiguración del mounting raw-body (no es firma inválida)', {
        channelLinkId: req.params.channelLinkId,
        bodyType: typeof req.body,
      })
      res.status(503).json({ success: false, message: 'Error temporal, reintentar' })
      return
    }
    const rawBody: Buffer = req.body
    const link = await prisma.deliveryChannelLink.findUnique({ where: { id: req.params.channelLinkId } })
    if (!link || link.status === 'DISABLED') {
      res.status(404).json({ success: false, message: 'Canal no registrado' })
      return
    }
    if (!verifyDeliverectHmac(rawBody, req.header(DELIVERECT_HMAC_HEADER), link.webhookSecret)) {
      logger.warn('[🛵 DeliverectWebhook] HMAC inválido', { channelLinkId: link.id })
      res.status(401).json({ success: false, message: 'Firma inválida' })
      return
    }

    let normalized: NormalizedDeliveryOrder
    try {
      normalized = parseDeliverectOrder(rawBody, link)
    } catch (e: any) {
      res.status(400).json({ success: false, message: e.message })
      return
    }

    // Fix C5 (spec §10.1.8): eventType clasificado por status del payload, no
    // hardcoded — así una cancelación (status 100) usa una key de dedup DISTINTA
    // del 'order' original y no se traga como DUPLICATE.
    const eventType = classifyDeliverectEventType(normalized.raw)

    // Contrato ACK (patrón Blumon): persistir ANTES de responder 200.
    const { event, duplicate } = await persistDeliveryEvent({
      provider: DeliveryProvider.DELIVERECT,
      externalEventId: normalized.externalId,
      eventType,
      channelLinkId: link.id,
      venueId: link.venueId,
      payload: normalized.raw,
    })
    if (duplicate) {
      res.status(200).json({ success: true, status: 'DUPLICATE', eventId: event.id })
      return
    }

    if (eventType !== 'order') {
      // REVALIDAR EN STAGING: handler de cancelación (revertir order/payment). El
      // PROCESAMIENTO completo de un 'cancel'/'status' (revertir Order→CANCELLED,
      // Payment, restock de inventario) es delicado y depende de semántica que solo
      // se puede confirmar con staging real — por ahora el evento queda persistido
      // DISTINTO (eventType != 'order', dedup key propia), visible y trazable, pero
      // el pipeline de ingesta normal (`ingestDeliveryOrder`, que crea/confirma la
      // Order como pedido nuevo) NUNCA corre sobre él — correrlo aquí dejaría el
      // pedido local CONFIRMED/PAID exactamente como el bug que este fix corrige.
      logger.warn(`[🛵 DeliverectWebhook] Evento '${eventType}' recibido — procesamiento completo pendiente (REVALIDAR EN STAGING)`, {
        eventId: event.id,
        externalId: normalized.externalId,
        channelLinkId: link.id,
      })
      try {
        // Marcado PROCESSED (terminal, sin orderId — ninguna Order se mutó) para
        // sacarlo del sweep de delivery-webhook-reconciliation.job: ese job recoge
        // CUALQUIER evento RECEIVED/FAILED sin distinguir eventType y le corre
        // `ingestDeliveryOrder` — si este evento quedara RECEIVED, 10 min después el
        // job lo re-procesaría como pedido nuevo, deshaciendo esta misma protección.
        await markEventResult(event.id, DeliveryOrderEventStatus.PROCESSED)
      } catch (bookErr: any) {
        logger.error(`[🛵 DeliverectWebhook] Bookkeeping de evento '${eventType}' falló — queda RECEIVED`, {
          eventId: event.id,
          error: bookErr?.message,
        })
      }
      res.status(200).json({ success: true, status: eventType === 'cancel' ? 'CANCEL_RECEIVED' : 'STATUS_RECEIVED', eventId: event.id })
      return
    }

    // Bookkeeping nunca cambia la verdad del ACK: evento persistido => jamás 503; ingesta OK => jamás FAILED.
    let ingestedOrderId: string | null = null
    try {
      const { order } = await ingestDeliveryOrder(normalized, link)
      ingestedOrderId = order.id
    } catch (e: any) {
      // Ingesta REALMENTE falló (este try solo envuelve la ingesta). Evento YA
      // persistido → 200 (la reconciliación lo reintenta; el proveedor no debe re-postear).
      logger.error('[🛵 DeliverectWebhook] Ingesta falló, evento FAILED para reconciliación', { eventId: event.id, error: e?.message })
      try {
        await markEventResult(event.id, DeliveryOrderEventStatus.FAILED, undefined, e?.message ?? 'unknown')
      } catch (bookErr: any) {
        // Bookkeeping FAILED falló → el evento queda RECEIVED; la reconciliación
        // barre RECEIVED viejos (Task 6). Jamás escalar al catch externo de 503:
        // el evento SÍ está persistido.
        logger.error('[🛵 DeliverectWebhook] Bookkeeping FAILED falló — evento queda RECEIVED para reconciliación', {
          eventId: event.id,
          error: bookErr?.message,
        })
      }
      res.status(200).json({ success: true, status: 'FAILED_WILL_RETRY', eventId: event.id })
      return
    }

    // Ingesta OK. El bookkeeping PROCESSED va en su PROPIO try/catch: si falla,
    // la ingesta sigue siendo un éxito — responder PROCESSED igual. El evento
    // queda RECEIVED y la reconciliación lo re-procesa idempotente (la orden ya
    // está upserteada por venueId_externalId; los payments van tras un count-guard).
    try {
      await markEventResult(event.id, DeliveryOrderEventStatus.PROCESSED, ingestedOrderId)
    } catch (bookErr: any) {
      logger.error('[🛵 DeliverectWebhook] Bookkeeping PROCESSED falló (ingesta OK) — evento queda RECEIVED, reconciliación idempotente', {
        eventId: event.id,
        orderId: ingestedOrderId,
        error: bookErr?.message,
      })
    }
    res.status(200).json({ success: true, status: 'PROCESSED', orderId: ingestedOrderId, eventId: event.id })
  } catch (e: any) {
    // Ni siquiera pudimos persistir el evento → 503 para que Deliverect reintente
    logger.error('[🛵 DeliverectWebhook] Error pre-persistencia', { error: e?.message })
    res.status(503).json({ success: false, message: 'Error temporal, reintentar' })
  }
}

/**
 * GET /api/v1/webhooks/delivery/deliverect/health
 */
export function deliverectWebhookHealthCheck(_req: Request, res: Response): void {
  res.status(200).json({ status: 'healthy', service: 'deliverect-webhook', timestamp: new Date().toISOString() })
}
