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
import { DeliveryOrderEventStatus, DeliveryProvider, OrderAcceptanceMode } from '@prisma/client'

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

import { cancelDeliveryOrder } from '../../core/cancelDeliveryOrder.service'
import { syncChannelMenu } from '../../core/menuSync.service'
import { ingestDeliveryOrder } from '../../core/deliveryOrderIngestion.service'
import { markEventResult } from '../../core/deliveryWebhookEvent.service'
import { uberAdapter } from './uber.adapter'

export type UberProcessOutcome =
  | 'PROCESSED' // pedido aceptado en Uber y convertido en venta
  | 'ALREADY_DONE' // ya se había procesado: reintento inofensivo
  | 'NOT_AN_ORDER' // evento que no es un pedido (status, etc.)
  | 'ORPHANED' // llegó de una tienda sin vincular a ningún venue
  | 'CANCELLED' // el proveedor canceló el pedido: dejó de ser venta y salió de cocina
  | 'MENU_SENT' // Uber pidió el menú y se le mandó
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

  // 🔴 Se clasifica por evento CANÓNICO, no comparando contra la cadena de Uber. Antes esto
  // decía `!== 'orders.notification'` y metía TODO lo demás —incluido `orders.cancel`— en el
  // mismo cajón de "no es un pedido, márcalo visto y olvídalo". Consecuencia real: si el
  // cliente cancelaba, la venta se quedaba PAID, la cocina seguía cocinando, y ese dinero
  // nunca llegaba pero sí se contaba.
  const tipo = uberAdapter.classifyEvent(identidad.eventType)

  if (tipo === 'CANCEL') {
    if (!identidad.orderId) {
      await markEventResult(eventRowId, DeliveryOrderEventStatus.FAILED, undefined, 'CANCEL_SIN_ORDER_ID')
      return { outcome: 'FAILED', error: 'CANCEL_SIN_ORDER_ID' }
    }
    // Deliberadamente ANTES del guard de `channelLink`: una cancelación se atiende aunque el
    // vínculo se haya borrado — la orden ya existe en la base y dejar de cocinarla no
    // depende de que el canal siga conectado.
    const r = await cancelDeliveryOrder(identidad.orderId, DeliveryProvider.UBER_EATS, 'cancelado por Uber')
    await markEventResult(eventRowId, DeliveryOrderEventStatus.PROCESSED, r.orderId)
    return { outcome: 'CANCELLED', orderId: r.orderId }
  }

  // Uber PIDE el menú. Se le manda con `force`, aunque nuestra huella diga que ya lo tiene:
  // si lo está pidiendo es porque de su lado se perdió, y discutirle con nuestro registro
  // sería confiar en él justo en el caso donde está mal. Sin esto, la tienda se queda con un
  // menú viejo o vacío y nadie se entera hasta que un cliente no encuentra qué pedir.
  if (tipo === 'MENU_REFRESH') {
    if (!evento.channelLink) {
      await markEventResult(eventRowId, DeliveryOrderEventStatus.FAILED, undefined, 'SIN_VINCULO')
      return { outcome: 'ORPHANED' }
    }
    const r = await syncChannelMenu(evento.channelLink, { force: true })
    // Un menú que el proveedor pidió y no pudimos mandar NO se marca como procesado: queda
    // FAILED y la reconciliación lo reintenta. Marcarlo visto lo enterraría.
    const ok = r.outcome === 'PUBLISHED'
    await markEventResult(
      eventRowId,
      ok ? DeliveryOrderEventStatus.PROCESSED : DeliveryOrderEventStatus.FAILED,
      undefined,
      ok ? undefined : r.error,
    )
    logger[ok ? 'info' : 'error']('📋 [Uber] el proveedor pidió el menú', { eventRowId, resultado: r.outcome })
    return ok ? { outcome: 'MENU_SENT' } : { outcome: 'FAILED', error: r.error }
  }

  // Ruido conocido (cambios de estado, provisioning): se marca visto para que la
  // reconciliación no lo persiga eternamente. Queda persistido y consultable.
  if (tipo !== 'NEW_ORDER' || !identidad.orderId) {
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
    //
    // 🔴 …salvo que el venue haya pedido aceptar A MANO. `orderAcceptanceMode` es la
    // decisión del dueño: aceptar solo cuando él pidió revisar cada pedido le quita el
    // control sobre su propia cocina.
    const automatico = link.orderAcceptanceMode === OrderAcceptanceMode.AUTO
    const aceptacion = automatico
      ? await acceptOrder(identidad.orderId, link.externalLocationId)
      : { ok: true, status: 0, raw: 'aceptación manual: la decide el staff' }

    if (!aceptacion.ok) {
      // 🔴 Si el pedido YA NO ESTÁ ACTIVO, crear la venta sería inventar una venta fantasma:
      // Uber ya lo canceló y ese dinero no va a llegar nunca. Se corta aquí.
      // Medido el 2026-08-20: pasado el plazo, Uber responde
      // `400 "The order is no longer active"` y el pedido queda en DENIED.
      const pedidoMuerto = /no longer active|not active|cancel/i.test(aceptacion.raw)
      logger.error('🚨 [Uber] no se pudo aceptar el pedido', {
        eventRowId,
        orderId: identidad.orderId,
        status: aceptacion.status,
        cuerpo: aceptacion.raw.slice(0, 200),
        pedidoMuerto,
      })

      if (pedidoMuerto) {
        await markEventResult(eventRowId, DeliveryOrderEventStatus.FAILED, undefined, 'PEDIDO_YA_NO_ACTIVO')
        return { outcome: 'FAILED', accepted: false, error: 'PEDIDO_YA_NO_ACTIVO' }
      }
      // Un fallo transitorio (red, 5xx) NO mata el pedido: se ingiere igual para no perder
      // la venta, y el evento queda marcado para reintentar el accept.
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
