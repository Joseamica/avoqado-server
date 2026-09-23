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
import { DeliveryOrderEventStatus, DeliveryProvider, OrderAcceptanceMode, OrderStatus } from '@prisma/client'

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

import { cancelDeliveryOrder } from '../../core/cancelDeliveryOrder.service'
import { syncChannelMenu } from '../../core/menuSync.service'
import { releaseScheduledOrder } from '../../core/releaseScheduledOrder.service'
import { ingestDeliveryOrder } from '../../core/deliveryOrderIngestion.service'
import { markEventResult } from '../../core/deliveryWebhookEvent.service'
import { esEvidenciaHttp } from '../../core/respondToDeliveryOrder.service'
import { reconcileDeliveryOrderFromProvider } from '../../core/deliveryReconciliation.service'
import { revocarTienda } from '../../core/deliveryStoreClaim.service'
import { uberAdapter } from './uber.adapter'
import { processUberReport } from './uber.reportProcessor'

/** Motivo de un `FULFILLMENT_CHANGED` cuya foto aún no trae el cambio: reintentable, no terminal. */
export const CAMBIO_SIN_REFLEJAR = 'CAMBIO_SIN_REFLEJAR'
/**
 * Cuánto se relee un pedido que avisó un cambio sin reflejarlo. Con el backoff del job de webhooks
 * (2, 4, 8, 16 min) son ~5 lecturas; después se cierra con rastro en `ActivityLog`.
 */
export const CAMBIO_SIN_REFLEJAR_VENTANA_MS = 30 * 60_000

/** Motivo de un FULFILLMENT_CHANGED que YA liquidó un cambio: se relee una vez más por si viene otro detrás. */
export const CAMBIO_POR_CONFIRMAR = 'CAMBIO_POR_CONFIRMAR'
/** Motivos de relectura ACOTADA: esperas, no fallas (el job los registra en warn). */
export const RELECTURAS_ACOTADAS = [CAMBIO_SIN_REFLEJAR, CAMBIO_POR_CONFIRMAR]

/**
 * ¿El retiro del cajero ya se reflejó en la venta hace poco? Una reconciliación de la RUTA o del
 * BARRIDO (no de un aviso) que repreció la orden en la ventana: entonces un aviso sin cambios es ese
 * mismo retiro, no una foto atrasada (P1-2, sin relecturas de más ni rastro falso).
 */
async function cambioReflejadoPorElCajero(orderId: string, recibido: Date): Promise<boolean> {
  const hit = await prisma.activityLog.findFirst({
    where: {
      entity: 'Order',
      entityId: orderId,
      action: 'DELIVERY_ORDER_REPRICED',
      createdAt: { gte: new Date(recibido.getTime() - CAMBIO_SIN_REFLEJAR_VENTANA_MS) },
      OR: [{ data: { path: ['trigger'], equals: 'ROUTE' } }, { data: { path: ['trigger'], equals: 'JOB' } }],
    },
    select: { id: true },
  })
  return hit !== null
}

export type UberProcessOutcome =
  | 'PROCESSED' // pedido aceptado en Uber y convertido en venta
  | 'ALREADY_DONE' // ya se había procesado: reintento inofensivo
  | 'NOT_AN_ORDER' // evento que no es un pedido (status, etc.)
  | 'ORPHANED' // llegó de una tienda sin vincular a ningún venue
  | 'CANCELLED' // el proveedor canceló el pedido: dejó de ser venta y salió de cocina
  | 'MENU_SENT' // Uber pidió el menú y se le mandó
  | 'SCHEDULED' // pedido para más tarde: entró como venta, NO fue a la cocina
  | 'RELEASED' // ya era hora del programado: fue a la cocina
  | 'STORE_STATE' // la tienda cambió de estado del lado del proveedor
  | 'REPORT' // llegó el reporte financiero; de ahí salen los reembolsos
  | 'RECONCILED' // el pedido cambió del lado del proveedor y la venta se reconcilió contra su foto
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

  // "Ya es hora" de un pedido programado: AHORA sí va a la cocina.
  if (tipo === 'RELEASE') {
    if (!identidad.orderId) {
      await markEventResult(eventRowId, DeliveryOrderEventStatus.PROCESSED)
      return { outcome: 'NOT_AN_ORDER' }
    }
    const r = await releaseScheduledOrder(`${DeliveryProvider.UBER_EATS}:${identidad.orderId}`)
    // Si la orden no existe todavía (el release se adelantó a la notificación), queda FAILED
    // para que la reconciliación lo reintente: enterrarlo dejaría el pedido sin comanda.
    const ok = r.outcome !== 'ORDER_NOT_FOUND'
    await markEventResult(
      eventRowId,
      ok ? DeliveryOrderEventStatus.PROCESSED : DeliveryOrderEventStatus.FAILED,
      r.orderId,
      ok ? undefined : 'ORDEN_NO_EXISTE',
    )
    return ok ? { outcome: 'RELEASED', orderId: r.orderId } : { outcome: 'FAILED', error: 'ORDEN_NO_EXISTE' }
  }

  // La tienda cambió de estado del lado de Uber. `deprovisioned` es el que más duele: nos
  // quitaron el acceso y seguiríamos creyendo que el canal está vivo, reintentando escrituras
  // que siempre van a fallar (es exactamente el síntoma del canal muerto de "La Ribera":
  // 401 al leer, 403 en pos_data, y en Avoqado figuraba ACTIVE).
  if (tipo === 'STORE_STATE') {
    if (identidad.eventType === 'store.deprovisioned' && identidad.storeId) {
      // 🔴 La revocación PREVALECE (spec §4.2, [C-3][N-16]) y se registra POR TIENDA aunque todavía no
      // exista el vínculo (P1-3): antes, sin vínculo el evento se tiraba y una conexión en curso
      // re-otorgaba la tienda al crearla. El vínculo se busca AHORA, no el que había al recibir el aviso.
      const deshabilitados = await revocarTienda(identidad.storeId)
      const datos = { eventRowId, storeId: identidad.storeId, linkIds: deshabilitados.map(l => l.id), venueIds: deshabilitados.map(l => l.venueId) }
      if (deshabilitados.length) logger.error('🚨 [Uber] el comercio QUITÓ el acceso a esta tienda — canal deshabilitado', datos)
      else logger.warn('🏪 [Uber] revocación de una tienda sin vínculo — registrada para que una conexión en curso no la reactive', datos)
    } else if (evento.channelLink) {
      logger.info('🏪 [Uber] la tienda cambió de estado del lado del proveedor', {
        eventRowId,
        tipo: identidad.eventType,
        linkId: evento.channelLink.id,
      })
    }
    await markEventResult(eventRowId, DeliveryOrderEventStatus.PROCESSED)
    return { outcome: 'STORE_STATE' }
  }

  // El pedido cambió del lado de Uber (el cliente aceptó sustituir o quitar algo). La venta se
  // RECONCILIA contra una foto fresca, bajo el candado del pedido, con la MISMA función que el
  // retiro desde el KDS (spec §3.1, H11): renglones retirados en todas las comandas, reembolso
  // compensatorio y reprecio. Sin foto confiable no se escribe nada y el evento queda FAILED
  // para que el job de webhooks lo reintente — antes quedaba PROCESSED y la venta seguía
  // reportando lo que el cliente ya no pagó.
  if (tipo === 'FULFILLMENT_CHANGED') {
    if (!identidad.orderId) {
      await markEventResult(eventRowId, DeliveryOrderEventStatus.PROCESSED)
      return { outcome: 'NOT_AN_ORDER' }
    }
    // El evento nombra al pedido de Uber pase lo que pase: un FAILED sin esto sólo lo guarda en el payload.
    await prisma.deliveryOrderEvent.update({ where: { id: eventRowId }, data: { externalOrderId: identidad.orderId } })
    if (!evento.channelLink) {
      await markEventResult(eventRowId, DeliveryOrderEventStatus.FAILED, undefined, 'SIN_VINCULO')
      return { outcome: 'ORPHANED' }
    }
    const orden = await prisma.order.findUnique({
      where: {
        venueId_externalId: { venueId: evento.channelLink.venueId, externalId: `${DeliveryProvider.UBER_EATS}:${identidad.orderId}` },
      },
      select: { id: true },
    })
    // El cambio se adelantó a la ingesta: queda FAILED y el reintento lo encuentra.
    if (!orden) {
      await markEventResult(eventRowId, DeliveryOrderEventStatus.FAILED, undefined, 'ORDEN_NO_EXISTE')
      return { outcome: 'FAILED', error: 'ORDEN_NO_EXISTE' }
    }
    let fallo: string | null
    let outcome: string | null = null
    try {
      outcome = (await reconcileDeliveryOrderFromProvider(orden.id, { trigger: 'WEBHOOK' })).outcome
      fallo = outcome === 'READ_FAILED' ? 'READ_FAILED' : null
    } catch (err) {
      fallo = err instanceof Error ? err.message : String(err)
    }
    if (fallo) {
      logger.error('🚨 [Uber] el pedido cambió y no se pudo reconciliar: el evento queda para reintento', {
        eventRowId,
        orderId: orden.id,
        venueId: evento.channelLink.venueId,
        error: fallo.slice(0, 300),
      })
      await markEventResult(eventRowId, DeliveryOrderEventStatus.FAILED, orden.id, fallo.slice(0, 500))
      return { outcome: 'FAILED', orderId: orden.id, error: fallo }
    }
    // P1-2: el GET puede ir DETRÁS del aviso. El evento se relee (FAILED con un motivo propio; el job
    // de webhooks con su backoff) hasta una lectura SIN cambios DESPUÉS de una que sí cambió: una
    // lectura que liquida algo no prueba que traiga TODO lo avisado (2ª pasada de Codex: bajó la
    // propina y el retiro llegó después). Pedido cancelado, cerrado o bloqueado = terminal.
    const dentro = Date.now() - evento.receivedAt.getTime() < CAMBIO_SIN_REFLEJAR_VENTANA_MS
    if ((outcome === 'REFUNDED' || outcome === 'NO_DELTA') && dentro) {
      await markEventResult(eventRowId, DeliveryOrderEventStatus.FAILED, orden.id, CAMBIO_POR_CONFIRMAR)
      return { outcome: 'FAILED', orderId: orden.id, error: CAMBIO_POR_CONFIRMAR }
    }
    // Sin cambios y sin un cambio previo que la acredite (de este aviso, o de la ruta del cajero hace poco).
    if (outcome === 'NO_ACTIONS' && evento.error !== CAMBIO_POR_CONFIRMAR && !(await cambioReflejadoPorElCajero(orden.id, evento.receivedAt))) {
      if (dentro) {
        logger.warn('[Uber] el pedido cambió y la foto aún no lo trae: se relee más tarde', { eventRowId, orderId: orden.id })
        await markEventResult(eventRowId, DeliveryOrderEventStatus.FAILED, orden.id, CAMBIO_SIN_REFLEJAR)
        return { outcome: 'FAILED', orderId: orden.id, error: CAMBIO_SIN_REFLEJAR }
      }
      logger.warn('[Uber] el proveedor avisó un cambio y su foto nunca mostró el cambio: se cierra el aviso', {
        eventRowId,
        orderId: orden.id,
        venueId: evento.channelLink.venueId,
        edadMin: Math.round((Date.now() - evento.receivedAt.getTime()) / 60_000),
      })
      await prisma.activityLog.create({
        data: {
          venueId: evento.channelLink.venueId,
          staffId: null,
          action: 'DELIVERY_ORDER_CHANGE_UNREFLECTED',
          entity: 'Order',
          entityId: orden.id,
          data: { eventId: eventRowId, externalOrderId: identidad.orderId, ventanaMin: CAMBIO_SIN_REFLEJAR_VENTANA_MS / 60_000 },
        },
      })
    }
    await markEventResult(eventRowId, DeliveryOrderEventStatus.PROCESSED, orden.id)
    return { outcome: 'RECONCILED', orderId: orden.id }
  }

  // El reporte financiero: la ÚNICA vía por la que nos enteramos de un reembolso. No
  // depende de un canal — el aviso viene de la cuenta, no de una tienda.
  if (tipo === 'REPORT_READY') {
    const r = await processUberReport(eventRowId)
    return r.outcome === 'PROCESSED' ? { outcome: 'REPORT' } : { outcome: 'FAILED', error: r.error }
  }

  // Ruido conocido (cambios de estado, provisioning): se marca visto para que la
  // reconciliación no lo persiga eternamente. Queda persistido y consultable.
  if ((tipo !== 'NEW_ORDER' && tipo !== 'SCHEDULED_ORDER') || !identidad.orderId) {
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
    const { order, created, kitchenTicketCreated, hayComanda } = await ingestDeliveryOrder(normalizado, link)

    // El accept salió ANTES de que existiera la orden: la marca se escribe ahora. Sólo un
    // 2xx acredita — el 409 ("ya estaba aceptado") y el placeholder MANUAL (status 0) no.
    if (automatico && esEvidenciaHttp(aceptacion.status)) {
      await prisma.order.updateMany({
        where: { id: order.id, providerAcceptedAt: null },
        data: { providerAcceptedAt: new Date(), providerAcceptedEvidence: 'HTTP_2XX' },
      })
    }

    // 🔴 REQUISITO DE UBER, y además es seguridad de una persona: la integración debe
    // RECHAZAR el pedido cuando no puede transmitir alergias o instrucciones especiales
    // ("Order rejection when allergens/special instructions cannot be relayed", Quality &
    // Performance Standards).
    //
    // El caso concreto: el cliente escribió "alérgico al cacahuate", la comanda de cocina
    // falló al crearse, y la venta se guardó igual. Sin esto la cocina prepara el platillo
    // SIN enterarse de la alergia — y nadie nota que faltó nada. Cancelar es peor servicio y
    // muchísimo mejor que eso.
    const traeInstrucciones = normalizado.items.some(i => typeof i.notes === 'string' && i.notes.trim().length > 0)
    // 🔴 La pregunta correcta es "¿HAY comanda?", no "¿era nueva la orden?".
    //
    // Aquí estuvo `created` y su motivo era bueno: los webhooks de Uber son at-least-once, y
    // en un evento DUPLICADO la ingesta reusa la venta sin recrear la comanda
    // (`kitchenTicketCreated=false`), así que sin ese término cada reintento cancelaba en Uber
    // un pedido perfectamente bueno que la cocina ya estaba preparando.
    //
    // Pero `created` responde otra cosa —"la orden no existía"— y en CUALQUIER reproceso vale
    // false, así que desarmaba la red de seguridad justo cuando sí hacía falta: si la comanda
    // vuelve a fallar en el reintento, el pedido se quedaba vivo en Uber con su nota de
    // alergia sin llegar a la cocina, y el evento se cerraba como PROCESSED.
    //
    // `hayComanda` cubre los dos casos con una sola pregunta: el duplicado la encuentra (no
    // cancela) y el reintento sin comanda no (cancela, que es para lo que se escribió).
    // `pedidoVivo` evita cancelar lo ya cancelado: ahí no hay nada que rescatar.
    const pedidoVivo = order.status !== OrderStatus.CANCELLED
    if (traeInstrucciones && !hayComanda && pedidoVivo && !normalizado.scheduledFor) {
      logger.error('🚨 [Uber] el pedido trae INSTRUCCIONES y no llegaron a la cocina — se CANCELA', {
        eventRowId,
        orderId: order.id,
        orderNumber: order.orderNumber,
      })
      const c = await uberAdapter.cancelOrder(identidad.orderId, link.externalLocationId, 'OUT_OF_ITEMS')
      await cancelDeliveryOrder(identidad.orderId, DeliveryProvider.UBER_EATS, 'no se pudieron transmitir las instrucciones a la cocina')
      await markEventResult(eventRowId, DeliveryOrderEventStatus.FAILED, order.id, 'INSTRUCCIONES_NO_TRANSMITIDAS')
      return {
        outcome: 'FAILED',
        orderId: order.id,
        accepted: aceptacion.ok,
        error: `INSTRUCCIONES_NO_TRANSMITIDAS (cancelado en Uber: ${c.ok})`,
      }
    }

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
