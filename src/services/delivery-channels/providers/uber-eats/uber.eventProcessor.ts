/**
 * Del aviso de Uber a una venta aceptada, sin intervención humana.
 *
 * Uber manda un PUNTERO en el webhook, no el pedido. Esta función recorre el camino
 * completo: trae el pedido, lo traduce, lo convierte en venta, y lo acepta en Uber.
 *
 * 🔴 EL RELOJ MANDA: [medido 2026-08-20, no de la doc] Uber CANCELA el pedido si no se
 * acepta dentro de los ~11.5 minutos siguientes al webhook. Se comprobó con el pedido
 * `dbe79abc-…`: entró 20:05:56, nadie contestó, y al intentar aceptarlo Uber respondió
 * `400 "The order is no longer active"` con el pedido ya en `DENIED`. Por eso el orden de
 * los pasos importa y por eso NADA aquí puede quedarse esperando.
 *
 * ORDEN DELIBERADO — se ACEPTA antes de que el pedido llegue a la cocina, no después:
 * lo que no se puede recuperar es el plazo. Si la ingesta falla, el pedido está aceptado y
 * el evento queda FAILED para reconciliar con el comercio; al revés, un pedido perfectamente
 * ingerido se cancela solo y el cliente se queda sin comida.
 */
import { DeliveryOrderEventStatus } from '@prisma/client'

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

import { ingestDeliveryOrder } from '../../core/deliveryOrderIngestion.service'
import { markEventResult } from '../../core/deliveryWebhookEvent.service'
import { uberAdapter } from './uber.adapter'

export type UberProcessOutcome =
  | 'PROCESSED' // pedido aceptado en Uber y convertido en venta
  | 'ALREADY_DONE' // ya se había procesado: reintento inofensivo
  | 'NOT_AN_ORDER' // evento que no es un pedido (status, etc.)
  | 'ORPHANED' // llegó de una tienda sin vincular a ningún venue
  | 'FAILED'

export interface UberProcessResult {
  outcome: UberProcessOutcome
  orderId?: string
  accepted?: boolean
  error?: string
}

/** Dependencias inyectables: sin esto no se puede probar sin red. */
export interface UberProcessDeps {
  fetchOrder?: (orderId: string) => Promise<unknown>
  acceptOrder?: (orderId: string, storeId: string) => Promise<{ ok: boolean; status: number; raw: string }>
}

export async function processUberEvent(eventRowId: string, deps: UberProcessDeps = {}): Promise<UberProcessResult> {
  const fetchOrder = deps.fetchOrder ?? (id => uberAdapter.fetchOrder(id))
  const acceptOrder = deps.acceptOrder ?? ((id, store) => uberAdapter.acceptOrder(id, store))

  const evento = await prisma.deliveryOrderEvent.findUnique({
    where: { id: eventRowId },
    include: { channelLink: true },
  })
  if (!evento) return { outcome: 'FAILED', error: `El evento ${eventRowId} no existe` }

  // Idempotente: Uber reintenta hasta 7 veces ante 5xx, y el despacho es at-least-once.
  if (evento.status === DeliveryOrderEventStatus.PROCESSED) {
    return { outcome: 'ALREADY_DONE', orderId: evento.orderId ?? undefined }
  }

  const identidad = uberAdapter.extractIdentity(evento.payload)

  // Sólo los avisos de PEDIDO llevan a una venta. Los demás (cambios de estado, etc.) se
  // marcan procesados para que la reconciliación no los persiga eternamente.
  if (identidad.eventType !== 'orders.notification' || !identidad.orderId) {
    await markEventResult(eventRowId, DeliveryOrderEventStatus.PROCESSED)
    return { outcome: 'NOT_AN_ORDER' }
  }

  // Sin vínculo no hay venue: el pedido llegó de una tienda que nadie conectó a un negocio.
  // Se deja visible en vez de inventarle dueño.
  if (!evento.channelLink) {
    logger.error('🚨 [Uber] pedido de una tienda SIN vincular — no se puede ingerir', {
      eventRowId,
      storeId: identidad.storeId,
      orderId: identidad.orderId,
    })
    await markEventResult(eventRowId, DeliveryOrderEventStatus.FAILED, undefined, 'SIN_VINCULO')
    return { outcome: 'ORPHANED' }
  }

  const link = evento.channelLink

  try {
    // 1. Traer el pedido — el webhook sólo trajo el puntero.
    const crudo = await fetchOrder(identidad.orderId)

    // 2. Guardarlo ANTES de procesarlo: si algo falla después, la evidencia de qué mandó
    //    Uber ya está en la base y el pedido se puede reconstruir sin volver a pedírselo.
    await prisma.deliveryOrderEvent.update({
      where: { id: eventRowId },
      data: { resourcePayload: crudo as object, resourceFetchedAt: new Date(), externalOrderId: identidad.orderId },
    })

    // 3. ACEPTAR YA. Antes de ingerir: el plazo es lo único irrecuperable.
    const aceptacion = await acceptOrder(identidad.orderId, link.externalLocationId)
    if (!aceptacion.ok) {
      logger.error('🚨 [Uber] no se pudo aceptar el pedido — Uber lo cancelará al vencer el plazo', {
        eventRowId,
        orderId: identidad.orderId,
        status: aceptacion.status,
        cuerpo: aceptacion.raw.slice(0, 200),
      })
    }

    // 4. Convertirlo en venta.
    const normalizado = uberAdapter.normalizeOrder(crudo)
    const { order } = await ingestDeliveryOrder(normalizado, link)

    await markEventResult(eventRowId, DeliveryOrderEventStatus.PROCESSED, order.id)
    logger.info('🛵 [Uber] pedido procesado', {
      eventRowId,
      orderId: order.id,
      externalId: order.externalId,
      aceptado: aceptacion.ok,
    })
    return { outcome: 'PROCESSED', orderId: order.id, accepted: aceptacion.ok }
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : 'desconocido'
    logger.error('🚨 [Uber] falló el procesamiento del pedido', { eventRowId, orderId: identidad.orderId, error: mensaje })
    await markEventResult(eventRowId, DeliveryOrderEventStatus.FAILED, undefined, mensaje.slice(0, 500))
    return { outcome: 'FAILED', error: mensaje }
  }
}
