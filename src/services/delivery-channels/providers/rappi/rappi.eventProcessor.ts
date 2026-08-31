/**
 * Del aviso de Rappi a una venta aceptada, sin intervención humana.
 *
 * Es el espejo de `uber.eventProcessor.ts`, con las CUATRO diferencias que Rappi impone —
 * cada una está aquí porque hacer lo mismo que Uber sería un bug:
 *
 *  1. **No hay `fetchOrder`**: el pedido viene COMPLETO en el webhook. Ir a buscarlo sería
 *     una llamada de más contra la tasa de éxito del 98% que exigen.
 *  2. **El reloj es de 4–6 minutos**, no ~11.5 (su propia documentación se contradice: el
 *     ciclo de vida dice 6, el FAQ dice 4 — se asume el corto). El orden accept-primero
 *     importa todavía más que en Uber.
 *  3. **Aceptar exige `cookingTime`** — pero Rappi lo manda en el propio pedido, con su
 *     rango permitido. Se le devuelve el suyo, recortado.
 *  4. **Un programado NO es una venta**: sus montos vienen en CERO por diseño. Se registra
 *     el aviso y nada más; la venta nace cuando Rappi libera el `NEW_ORDER` real. (Uber sí
 *     ingiere sus programados porque SÍ manda los montos — la divergencia es de ellos.)
 */
import { DeliveryChannelStatus, DeliveryOrderEventStatus, DeliveryProvider } from '@prisma/client'

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

import { cancelDeliveryOrder } from '../../core/cancelDeliveryOrder.service'
import { ingestDeliveryOrder } from '../../core/deliveryOrderIngestion.service'
import { markEventResult } from '../../core/deliveryWebhookEvent.service'
import { rappiAdapter, RAPPI_EVENTS } from './rappi.adapter'
import { tiempoDeCoccion, type RappiOrderPayload } from './rappi.mapper'

export type RappiProcessOutcome =
  | 'PROCESSED' // pedido aceptado en Rappi y convertido en venta
  | 'ALREADY_DONE' // reintento inofensivo
  | 'NOT_AN_ORDER' // evento informativo (courier, provisioning…)
  | 'ORPHANED' // llegó de una tienda sin vincular a ningún venue
  | 'CANCELLED' // Rappi canceló: dejó de ser venta y salió de cocina
  | 'SCHEDULED_NOTED' // programado registrado; la venta nace cuando lo liberen
  | 'MENU_VERDICT' // llegó la aprobación (o el rechazo) del menú
  | 'STORE_STATE' // la tienda cambió de estado del lado de Rappi
  | 'FAILED'

export interface RappiProcessResult {
  outcome: RappiProcessOutcome
  orderId?: string
  accepted?: boolean
  error?: string
}

/** Dependencias inyectables: sin esto no se puede probar sin red. */
export interface RappiProcessDeps {
  aceptar?: (orderId: string, storeId: string, cookingTime: number) => Promise<{ ok: boolean; status: number; raw: string }>
}

export async function processRappiEvent(eventRowId: string, deps: RappiProcessDeps = {}): Promise<RappiProcessResult> {
  const aceptar =
    deps.aceptar ??
    (async (orderId: string, storeId: string, cookingTime: number) => {
      // Perezoso: `rappi.client` lee `@/config/env` al cargarse (regla del repo).
      const { aceptarPedidoRappi } = await import('./rappi.client')
      return aceptarPedidoRappi(orderId, storeId, cookingTime)
    })

  const evento = await prisma.deliveryOrderEvent.findUnique({
    where: { id: eventRowId },
    include: { channelLink: true },
  })
  if (!evento) return { outcome: 'FAILED', error: `El evento ${eventRowId} no existe` }

  // Idempotente: el despacho es at-least-once, y el sondeo puede volver a topar el mismo pedido.
  if (evento.status === DeliveryOrderEventStatus.PROCESSED) {
    return { outcome: 'ALREADY_DONE', orderId: evento.orderId ?? undefined }
  }

  // 🔴 El tipo viene de la FILA (que lo estampó la RUTA), no del payload: varios cuerpos de
  // Rappi no traen tipo, y dos de ellos son literalmente idénticos entre sí.
  const tipo = rappiAdapter.classifyEvent(evento.eventType)
  const identidad = rappiAdapter.extractIdentity(evento.payload)

  // ── Cancelación ─────────────────────────────────────────────────────────────────────
  // Antes del guard de vínculo, igual que Uber: una orden ya existente se cancela aunque el
  // canal se haya desconectado. `ORDER_NOT_FOUND` NO es error — para el programado cancelado
  // es lo NORMAL (nunca fue venta), y para un cancel adelantado el evento queda registrado.
  if (tipo === 'CANCEL') {
    if (!identidad.orderId) {
      await markEventResult(eventRowId, DeliveryOrderEventStatus.FAILED, undefined, 'CANCEL_SIN_ORDER_ID')
      return { outcome: 'FAILED', error: 'CANCEL_SIN_ORDER_ID' }
    }
    const r = await cancelDeliveryOrder(identidad.orderId, DeliveryProvider.RAPPI, 'cancelado por Rappi')
    await markEventResult(eventRowId, DeliveryOrderEventStatus.PROCESSED, r.orderId)
    return { outcome: 'CANCELLED', orderId: r.orderId }
  }

  // ── Programado: se ANOTA, no se vende ───────────────────────────────────────────────
  // 🔴 Sus montos vienen en cero POR DISEÑO (documentado). Ingerirlo escribiría una venta de
  // $0 marcada como pagada — el bug que ya ocurrió una vez con Uber. La venta real llega como
  // `NEW_ORDER` cuando Rappi libera el pedido; este evento sólo sirve de aviso a cocina.
  if (tipo === 'SCHEDULED_ORDER') {
    await markEventResult(eventRowId, DeliveryOrderEventStatus.PROCESSED)
    logger.info('📅 [Rappi] pedido PROGRAMADO anotado — la venta nace cuando lo liberen', {
      eventRowId,
      orderId: identidad.orderId,
      venueId: evento.venueId,
    })
    return { outcome: 'SCHEDULED_NOTED', orderId: identidad.orderId ?? undefined }
  }

  // ── El veredicto del menú ───────────────────────────────────────────────────────────
  // 🔴 En Rappi el 200 del POST de menú significa "en revisión". ESTO es lo que significa
  // publicado (`MENU_APPROVED`) o rechazado (`MENU_REJECTED` — que viene SIN motivo, así que
  // lo único honesto es gritar y apuntar a la validación previa de `rappi.menuMapper`).
  if (tipo === 'MENU_REFRESH') {
    if (!evento.channelLink) {
      await markEventResult(eventRowId, DeliveryOrderEventStatus.FAILED, undefined, 'SIN_VINCULO')
      return { outcome: 'ORPHANED' }
    }

    const aprobado = evento.eventType === RAPPI_EVENTS.MENU_APPROVED
    const config = (evento.channelLink.config ?? {}) as Record<string, unknown>
    const huellaPendiente = typeof config.rappiPendingMenuHash === 'string' ? config.rappiPendingMenuHash : null

    if (aprobado) {
      await prisma.deliveryChannelLink.update({
        where: { id: evento.channelLink.id },
        data: {
          lastMenuSyncAt: new Date(),
          // La huella se sella AQUÍA — no al publicar. Si no había pendiente (publicación
          // manual, o de antes de este mecanismo), al menos queda la fecha.
          ...(huellaPendiente ? { lastMenuHash: huellaPendiente, config: { ...config, rappiPendingMenuHash: null } } : {}),
        },
      })
      logger.info('📋 [Rappi] menú APROBADO — ahora sí está publicado', {
        eventRowId,
        linkId: evento.channelLink.id,
        venueId: evento.venueId,
        selladoConHuella: Boolean(huellaPendiente),
      })
    } else {
      await prisma.deliveryChannelLink.update({
        where: { id: evento.channelLink.id },
        data: { config: { ...config, rappiPendingMenuHash: null } },
      })
      // Sin huella sellada, `menuSyncStatusOf` seguirá diciendo NUNCA_PUBLICADO/desfasado —
      // que es la verdad, y es lo que hace visible el problema en el dashboard y el MCP.
      logger.error('🚨 [Rappi] menú RECHAZADO — y Rappi NO dice por qué. Revisar contra las reglas de rappi.menuMapper', {
        eventRowId,
        linkId: evento.channelLink.id,
        venueId: evento.venueId,
      })
    }

    await markEventResult(eventRowId, DeliveryOrderEventStatus.PROCESSED)
    return { outcome: 'MENU_VERDICT' }
  }

  // ── Estado de la tienda del lado de Rappi ───────────────────────────────────────────
  if (tipo === 'STORE_STATE') {
    if (evento.eventType === RAPPI_EVENTS.STORE_CONNECTIVITY && evento.channelLink) {
      const cuerpo = evento.payload as { enabled?: boolean; message?: string }
      if (cuerpo.enabled === false) {
        // Rappi apagó la tienda de SU lado. Se refleja para no repetir el canal muerto de
        // "La Ribera" (figuraba ACTIVE con el acceso revocado). El sentido contrario NO se
        // automatiza: si está PAUSED puede ser la pausa del dueño, y reactivarla sola
        // reabriría una tienda que él cerró a propósito.
        await prisma.deliveryChannelLink.update({
          where: { id: evento.channelLink.id },
          data: { status: DeliveryChannelStatus.PAUSED },
        })
        logger.error('🚨 [Rappi] la tienda quedó DESHABILITADA del lado de Rappi', {
          eventRowId,
          linkId: evento.channelLink.id,
          venueId: evento.venueId,
          mensaje: cuerpo.message,
        })
      } else {
        logger.info('🏪 [Rappi] la tienda cambió de estado del lado del proveedor', {
          eventRowId,
          linkId: evento.channelLink.id,
          enabled: cuerpo.enabled,
        })
      }
    }
    await markEventResult(eventRowId, DeliveryOrderEventStatus.PROCESSED)
    return { outcome: 'STORE_STATE' }
  }

  // ── Eventos informativos ────────────────────────────────────────────────────────────
  // En Rappi, `ORDER_OTHER_EVENT` es el CICLO DE VIDA DEL REPARTIDOR (asignado, llegó, ETA),
  // no un cambio del pedido por el cliente como en Uber. Información útil, cero mutación.
  if (tipo === 'FULFILLMENT_CHANGED' || tipo === 'IGNORED') {
    await markEventResult(eventRowId, DeliveryOrderEventStatus.PROCESSED)
    return { outcome: 'NOT_AN_ORDER' }
  }

  // ── Pedido nuevo ────────────────────────────────────────────────────────────────────
  if (tipo !== 'NEW_ORDER') {
    await markEventResult(eventRowId, DeliveryOrderEventStatus.PROCESSED)
    return { outcome: 'NOT_AN_ORDER' }
  }

  if (!evento.channelLink) {
    // La tienda no está vinculada a ningún venue. El evento queda FAILED y visible: hay un
    // PEDIDO REAL de un cliente en él, y enterrarlo sería perderle la comida a alguien.
    await markEventResult(eventRowId, DeliveryOrderEventStatus.FAILED, undefined, 'TIENDA_SIN_VINCULO')
    logger.error('🚨 [Rappi] llegó un pedido de una tienda SIN VINCULAR', { eventRowId, storeId: identidad.storeId })
    return { outcome: 'ORPHANED' }
  }

  // Traducir ANTES de aceptar: si el dinero no cuadra (la red contra el error de unidades),
  // NO se acepta un pedido que no podemos registrar — lanza, queda FAILED, y se revisa.
  let normalizado
  try {
    normalizado = rappiAdapter.normalizeOrder(evento.payload)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await markEventResult(eventRowId, DeliveryOrderEventStatus.FAILED, undefined, msg.slice(0, 500))
    logger.error('🚨 [Rappi] el pedido NO se pudo traducir — no se aceptó', { eventRowId, error: msg })
    return { outcome: 'FAILED', error: msg }
  }

  // 🔴 ACEPTAR PRIMERO, con el reloj de 4–6 min corriendo — sólo en modo AUTO. En MANUAL la
  // cocina decide desde el POS, y la venta entra PENDING (eso lo resuelve la ingesta según el
  // modo del canal). El orden es el mismo que Uber y por la misma razón: lo que no se puede
  // recuperar es el plazo. Si la ingesta falla después, el evento queda FAILED para
  // reconciliar; al revés, un pedido perfectamente ingerido se cancela solo.
  let accepted = false
  if (evento.channelLink.orderAcceptanceMode === 'AUTO') {
    const detail = (evento.payload as RappiOrderPayload).order_detail ?? {}
    const storeId = identidad.storeId ?? evento.channelLink.externalLocationId
    let r
    try {
      r = await aceptar(normalizado.externalId, storeId, tiempoDeCoccion(detail))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await markEventResult(eventRowId, DeliveryOrderEventStatus.FAILED, undefined, `ACCEPT: ${msg.slice(0, 400)}`)
      logger.error('🚨 [Rappi] aceptar el pedido lanzó — queda FAILED para reconciliar', {
        eventRowId,
        orderId: normalizado.externalId,
        error: msg,
      })
      return { outcome: 'FAILED', accepted: false, error: msg }
    }
    if (!r.ok) {
      await markEventResult(eventRowId, DeliveryOrderEventStatus.FAILED, undefined, `ACCEPT_${r.status}: ${r.raw.slice(0, 300)}`)
      logger.error('🚨 [Rappi] no se pudo ACEPTAR el pedido — el reloj lo va a cancelar', {
        eventRowId,
        orderId: normalizado.externalId,
        status: r.status,
      })
      return { outcome: 'FAILED', error: `ACCEPT_${r.status}` }
    }
    accepted = true
  }

  try {
    const r = await ingestDeliveryOrder(normalizado, evento.channelLink)
    await markEventResult(eventRowId, DeliveryOrderEventStatus.PROCESSED, r.order.id)
    return { outcome: 'PROCESSED', orderId: r.order.id, accepted }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Si ya se aceptó, el dinero del cliente está comprometido y la venta NO quedó
    // registrada: FAILED visible para reconciliar con el comercio, jamás silencio.
    await markEventResult(eventRowId, DeliveryOrderEventStatus.FAILED, undefined, `INGEST: ${msg.slice(0, 400)}`)
    logger.error('🚨 [Rappi] pedido ACEPTADO pero la ingesta falló — reconciliar a mano', {
      eventRowId,
      orderId: normalizado.externalId,
      accepted,
      error: msg,
    })
    return { outcome: 'FAILED', error: msg, accepted }
  }
}
