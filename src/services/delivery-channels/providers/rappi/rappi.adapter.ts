/**
 * Adaptador de Rappi — los CINCO métodos obligatorios del contrato directo.
 *
 * 🔴 ESTE ADAPTADOR NO ESTÁ REGISTRADO TODAVÍA, y es a propósito.
 *
 * `adapterRegistry` es la única fuente de verdad de "¿ya hay a quién delegarle?", y el
 * dashboard pinta `integrationReady` a partir de él. Registrarlo hoy diría que Rappi funciona
 * cuando lo único que existe es lo que se puede escribir SIN sandbox: traducir lo que entra.
 * No hay forma de aceptar un pedido, publicar un menú ni prender la tienda, porque no hay
 * credenciales con las que probar una sola llamada de salida.
 *
 * Registrarlo es UNA línea en `adapterRegistry.ts` el día que Rappi conteste el alta. Hasta
 * entonces, un canal RAPPI se ve como "no lista" — que es la verdad.
 *
 * Lo que sí está aquí es lo caro y lo verificable: la firma (algoritmo distinto al de Uber),
 * la traducción de los 11 eventos, y el mapeo del pedido con su red de cuadre. Eso vale
 * aunque cambie un endpoint.
 */
import type { DeliveryProvider } from '@prisma/client'

import type { CanonicalDeliveryEvent, EventIdentity, NormalizedDeliveryOrder } from '../../core/types'
import { extraerStoreId, normalizeRappiOrder, type RappiOrderPayload } from './rappi.mapper'
import { verifyRappiSignature } from './rappi.signature'

/** Los 11 eventos que Rappi documenta, tal cual los nombra. */
export const RAPPI_EVENTS = {
  NEW_ORDER: 'NEW_ORDER',
  NEW_ORDER_SCHEDULED: 'NEW_ORDER_SCHEDULED',
  NEW_ORDER_SCHEDULED_CANCELLED: 'NEW_ORDER_SCHEDULED_CANCELLED',
  ORDER_EVENT_CANCEL: 'ORDER_EVENT_CANCEL',
  ORDER_OTHER_EVENT: 'ORDER_OTHER_EVENT',
  MENU_APPROVED: 'MENU_APPROVED',
  MENU_REJECTED: 'MENU_REJECTED',
  PING: 'PING',
  STORE_CONNECTIVITY: 'STORE_CONNECTIVITY',
  ORDER_RT_TRACKING: 'ORDER_RT_TRACKING',
  STORE_PROVISIONING_STATUS: 'STORE_PROVISIONING_STATUS',
} as const

export const rappiAdapter = {
  provider: 'RAPPI' as DeliveryProvider,

  /**
   * HMAC-SHA256 sobre `timestamp.payload` — NO sobre el body crudo como Uber.
   *
   * Se prueban todos los secretos que el llamador pase (rotación) y basta uno. El detalle del
   * algoritmo vive en `rappi.signature.ts`, que es donde está el comentario que explica por
   * qué reusar el de Uber rechazaría todo en silencio.
   */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, secrets: string[]): boolean {
    const crudo = headers['rappi-signature'] ?? headers['Rappi-Signature']
    const header = Array.isArray(crudo) ? crudo[0] : crudo
    return secrets.some(s => verifyRappiSignature(rawBody, header, s))
  },

  /**
   * De qué tienda y qué pedido habla el mensaje.
   *
   * Los eventos de Rappi NO comparten una forma: el pedido viene anidado en `order_detail` y
   * la tienda en `store`, mientras la cancelación manda `order_id`/`store_id` planos y el
   * PING sólo trae la tienda. Se leen las dos formas en vez de asumir una.
   */
  extractIdentity(payload: unknown): EventIdentity {
    const p = (payload ?? {}) as RappiOrderPayload & {
      event?: string
      type?: string
      order_id?: string
      store_id?: string
      external_store_id?: string
    }

    const eventType = String(p.type ?? p.event ?? '').trim()
    const orderId = String(p.order_detail?.order_id ?? p.order_id ?? '').trim() || null
    const storeId = extraerStoreId(p) ?? (String(p.store_id ?? p.external_store_id ?? '').trim() || null)

    return {
      // Rappi no manda un id de evento propio. Se compone uno estable con lo que sí hay, para
      // que la deduplicación del núcleo tenga de dónde agarrarse: el mismo evento reenviado
      // produce la misma llave, y dos eventos distintos del mismo pedido no colisionan.
      eventId: [eventType || 'EVENTO', storeId ?? 'sin-tienda', orderId ?? 'sin-pedido'].join(':'),
      eventType,
      storeId,
      orderId,
    }
  },

  /**
   * Los 11 eventos de Rappi → el vocabulario del núcleo.
   *
   * 🔴 `NEW_ORDER_SCHEDULED` va a `SCHEDULED_ORDER` y NO a `NEW_ORDER`, aunque traiga el
   * pedido completo: sus montos vienen en CERO por diseño. Tratarlo como pedido normal
   * escribiría una venta de $0 marcada como pagada.
   *
   * 🔴 `MENU_APPROVED` es lo que de verdad significa "publicado" en Rappi. El `200` del POST
   * sólo significa "en revisión", así que la huella del menú se sella AQUÍ, no al publicar.
   * Sellarla antes dejaría al sincronizador creyendo que la carta ya está arriba cuando podría
   * estar rechazada.
   */
  classifyEvent(eventType: string): CanonicalDeliveryEvent {
    switch (eventType) {
      case RAPPI_EVENTS.NEW_ORDER:
        return 'NEW_ORDER'
      case RAPPI_EVENTS.NEW_ORDER_SCHEDULED:
        return 'SCHEDULED_ORDER'
      case RAPPI_EVENTS.NEW_ORDER_SCHEDULED_CANCELLED:
      case RAPPI_EVENTS.ORDER_EVENT_CANCEL:
        return 'CANCEL'
      case RAPPI_EVENTS.ORDER_OTHER_EVENT:
        return 'FULFILLMENT_CHANGED'
      case RAPPI_EVENTS.MENU_APPROVED:
      case RAPPI_EVENTS.MENU_REJECTED:
        return 'MENU_REFRESH'
      case RAPPI_EVENTS.STORE_CONNECTIVITY:
      case RAPPI_EVENTS.STORE_PROVISIONING_STATUS:
        return 'STORE_STATE'
      // El PING y el rastreo del repartidor no cambian NADA de nuestro lado. Se marcan como
      // ignorados a propósito: el PING se contesta en el ingreso del webhook (Rappi espera un
      // cuerpo específico) y el rastreo es información del courier que no tocamos.
      case RAPPI_EVENTS.PING:
      case RAPPI_EVENTS.ORDER_RT_TRACKING:
        return 'IGNORED'
      default:
        return 'IGNORED'
    }
  },

  /**
   * Qué eventos traen un PEDIDO. El núcleo lo usa para medir la tasa de aceptación sin
   * conocer el vocabulario de ningún proveedor.
   *
   * El programado va incluido porque también es un pedido que llegó, aunque su venta nazca
   * después: dejarlo fuera subestimaría cuántos pedidos nos mandaron.
   */
  orderEventTypes(): string[] {
    return [RAPPI_EVENTS.NEW_ORDER, RAPPI_EVENTS.NEW_ORDER_SCHEDULED]
  },

  normalizeOrder(raw: unknown): NormalizedDeliveryOrder {
    return normalizeRappiOrder(raw)
  },
}

/**
 * Lo que Rappi espera cuando nos hace PING (cada 3 minutos).
 *
 * 🔴 NO es cortesía: dos pings negativos seguidos y Rappi marca la tienda como caída, con lo
 * que deja de mandarle pedidos. Es la única obligación ENTRANTE de esta integración —el resto
 * del contrato es cosas que nosotros llamamos— y por eso vive aquí, junto al adaptador, en vez
 * de escondida en una ruta.
 *
 * Se contesta OK siempre que el proceso esté vivo, que es literalmente lo que la pregunta
 * significa: "¿estás ahí para recibir pedidos?". Encadenar la respuesta al estado de la base o
 * del proveedor haría que un hipo de 30 segundos apague la tienda de un comercio.
 */
export function respuestaPing(nombreTienda?: string | null): { status: 'OK'; description: string } {
  return { status: 'OK', description: nombreTienda?.trim() || 'Avoqado' }
}
