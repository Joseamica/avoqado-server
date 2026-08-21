/**
 * Adaptador de Uber Eats: lo ÚNICO que el núcleo sabe de Uber.
 *
 * Sólo traduce y habla con la API. No crea órdenes, no cobra, no toca inventario — eso es
 * del núcleo, una sola vez para los cuatro proveedores.
 *
 * 🔴 El plazo que manda: [doc] Uber CANCELA el pedido si no se acepta o rechaza dentro de
 * los 11.5 minutos siguientes al webhook. Por eso `acceptOrder` trata el 409 como éxito
 * (ver abajo): el reintento no puede convertirse en un fallo.
 */
import { DeliveryProvider } from '@prisma/client'

import logger from '@/config/logger'

import { uberApi, fetchUberOrder } from './uber.client'
import { orderIdFromResourceHref } from './uber.http'
import { verifyUberSignature } from './uber.signature'
import { mapUberOrder } from './uber.mapper'
import { mapSnapshotToUberMenu, type UberMenuOptions } from './uber.menuMapper'
import type { MenuSnapshot } from '../../core/menuSnapshot.service'
import type { CanonicalDeliveryEvent, DirectDeliveryAdapter, NormalizedDeliveryOrder } from '../../core/types'

export type UberDenyReason = 'OUT_OF_ITEMS' | 'STORE_CLOSED' | 'TOO_BUSY' | 'OTHER'

export interface UberActionResult {
  ok: boolean
  status: number
  /** Cuerpo crudo — se guarda para auditoría cuando falla. */
  raw: string
}

export interface UberEventIdentity {
  eventId: string
  eventType: string
  /** id de la TIENDA en Uber. 🔴 Viaja en `meta.user_id`, no en `meta.store_id`. */
  storeId: string | null
  /** id del PEDIDO — agrupa todos los eventos de un mismo pedido. */
  orderId: string | null
  resourceRef: string | null
}

export const uberAdapter = {
  provider: DeliveryProvider.UBER_EATS,

  /** ¿El mensaje es auténtico? HMAC-SHA256 sobre los bytes crudos, comparación timing-safe. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, secrets: string[]): boolean {
    const firma = headers['x-uber-signature']
    const valor = Array.isArray(firma) ? firma[0] : firma
    return secrets.some(s => verifyUberSignature(rawBody, valor, s))
  },

  /**
   * Los nombres de Uber → lo que el núcleo entiende.
   *
   * `orders.failure` va junto con `orders.cancel` a CANCEL: [doc] es la generación nueva de
   * la API para el mismo hecho —el pedido ya no va a ocurrir— y tratarlos distinto dejaría
   * un camino sin cubrir el día que Uber mueva la integración de versión.
   */
  classifyEvent(eventType: string): CanonicalDeliveryEvent {
    if (eventType === 'orders.notification') return 'NEW_ORDER'
    if (eventType === 'orders.cancel' || eventType === 'orders.failure') return 'CANCEL'
    return 'IGNORED'
  },

  /** ¿De qué tienda y qué pedido es? Cada proveedor lo pone en otro campo. */
  extractIdentity(payload: unknown): UberEventIdentity {
    const p = payload as {
      event_id?: unknown
      event_type?: unknown
      resource_href?: unknown
      meta?: { user_id?: unknown }
    }
    return {
      eventId: typeof p?.event_id === 'string' ? p.event_id : '',
      eventType: typeof p?.event_type === 'string' ? p.event_type : '',
      // 🔴 Rareza real de la API de Uber: el store_id viaja en `meta.user_id`.
      storeId: typeof p?.meta?.user_id === 'string' ? p.meta.user_id : null,
      orderId: orderIdFromResourceHref(p?.resource_href),
      resourceRef: typeof p?.resource_href === 'string' ? p.resource_href : null,
    }
  },

  /**
   * Trae el pedido completo. Uber manda un PUNTERO en el webhook, no el contenido: sin este
   * GET no hay nada que ingerir.
   */
  async fetchOrder(orderId: string): Promise<unknown> {
    const r = await fetchUberOrder(orderId)
    if (r.status >= 400) {
      throw new Error(`Uber devolvió HTTP ${r.status} al traer el pedido ${orderId}: ${r.text.slice(0, 200)}`)
    }
    return r.json
  },

  /** Traduce el pedido crudo al contrato interno. Aquí vive TODA la diferencia de formato. */
  normalizeOrder(raw: unknown): NormalizedDeliveryOrder {
    return mapUberOrder(raw)
  },

  /**
   * Acepta el pedido en Uber.
   *
   * 🔴 El 409 (`resource_status_conflict`) cuenta como ÉXITO: significa "ya estaba aceptado".
   * El despacho es at-least-once, así que un reintento tras una respuesta perdida DEBE ser
   * inofensivo — tratarlo como error dejaría el pedido en reintento eterno hasta que Uber
   * lo cancele por plazo vencido.
   */
  async acceptOrder(orderId: string, storeId: string): Promise<UberActionResult> {
    const r = await uberApi({
      method: 'POST',
      path: `/v1/eats/orders/${encodeURIComponent(orderId)}/accept_pos_order`,
      storeId,
      body: { reason: 'Aceptado por el POS' },
    })
    const ok = r.status < 400 || r.status === 409
    if (!ok) logger.warn('Uber rechazó el accept', { orderId, status: r.status, cuerpo: r.text.slice(0, 200) })
    return { ok, status: r.status, raw: r.text }
  },

  /** El menú traducido, sin publicarlo — para que el sincronizador le saque huella. */
  buildMenuPayload(snapshot: MenuSnapshot, opts?: UberMenuOptions): unknown {
    return mapSnapshotToUberMenu(snapshot, opts)
  },

  /**
   * Publica el menú completo del venue en la tienda de Uber.
   *
   * 🔴 ES LA ESCRITURA MÁS PELIGROSA DE TODA LA INTEGRACIÓN: `PUT /menus` REEMPLAZA el menú
   * entero de la tienda. El 2026-08-17, con credenciales de SANDBOX, esta llamada modificó
   * el menú EN VIVO de un restaurante REAL de producción —apareció en su Uber Eats Manager
   * y hubo que restaurarlo desde respaldo—, porque el aislamiento del sandbox que Uber
   * documenta NO se cumple cuando la cuenta no tiene tienda de prueba asignada.
   *
   * Lo único que lo hace seguro es `assertStoreWritable` en `uber.http.ts`, que corre ANTES
   * de cualquier escritura y sólo deja pasar las tiendas de `UBER_WRITABLE_STORE_IDS_*`.
   * **Nunca quites ese candado ni lo muevas más arriba en la pila.**
   *
   * Para marcar UN producto agotado NO se usa esto: hay un update puntual
   * (`POST /v2/eats/stores/{id}/menus/items/{item_id}` con `suspension_info`) que no
   * republica nada. Republicar el menú entero para agotar un producto es traer una
   * excavadora a plantar una maceta.
   */
  async publishMenu(snapshot: MenuSnapshot, storeId: string, opts?: UberMenuOptions): Promise<UberActionResult> {
    const payload = mapSnapshotToUberMenu(snapshot, opts)
    const r = await uberApi({ method: 'PUT', path: `/v2/eats/stores/${encodeURIComponent(storeId)}/menus`, storeId, body: payload })
    const ok = r.status < 400
    if (!ok) logger.error('🚨 Uber rechazó el menú', { storeId, status: r.status, cuerpo: r.text.slice(0, 400) })
    else logger.info('📋 [Uber] menú publicado', { storeId, items: payload.items.length, categorias: payload.categories.length })
    return { ok, status: r.status, raw: r.text }
  },

  /**
   * Marca UN producto como agotado (o lo revive) sin republicar el menú.
   *
   * Es la operación del día a día —se acabó la cochinita a las 3pm— y es barata y acotada:
   * toca un item, no puede romper el menú entero. Es justo lo contrario de `publishMenu`.
   */
  async setItemSoldOut(itemId: string, storeId: string, agotado: boolean): Promise<UberActionResult> {
    const r = await uberApi({
      method: 'POST',
      path: `/v2/eats/stores/${encodeURIComponent(storeId)}/menus/items/${encodeURIComponent(itemId)}`,
      storeId,
      // `suspension_info` vacío = disponible. Con `suspend_until: 0` Uber lo deja agotado
      // hasta que alguien lo reactive, que es lo que espera una cocina: no adivinar cuándo
      // vuelve a haber.
      body: agotado ? { suspension_info: { suspension: { suspend_until: 0, reason: 'Agotado' } } } : { suspension_info: {} },
    })
    const ok = r.status < 400
    if (!ok) logger.warn('Uber rechazó el cambio de disponibilidad', { storeId, itemId, status: r.status, cuerpo: r.text.slice(0, 200) })
    return { ok, status: r.status, raw: r.text }
  },

  /** Rechaza el pedido. A diferencia del accept, un 409 aquí NO es éxito: el estado difiere. */
  async denyOrder(orderId: string, storeId: string, reason: UberDenyReason = 'OTHER'): Promise<UberActionResult> {
    const r = await uberApi({
      method: 'POST',
      path: `/v1/eats/orders/${encodeURIComponent(orderId)}/deny_pos_order`,
      storeId,
      body: { reason: { explanation: reason } },
    })
    const ok = r.status < 400
    if (!ok) logger.warn('Uber rechazó el deny', { orderId, status: r.status, cuerpo: r.text.slice(0, 200) })
    return { ok, status: r.status, raw: r.text }
  },
}

export type UberAdapter = typeof uberAdapter

// 🔴 LA PRUEBA de que Uber cumple el contrato — en tiempo de COMPILACIÓN, no en un comentario.
// Si alguien le quita `normalizeOrder`, o le cambia la firma a `acceptOrder`, esto truena aquí
// y no en producción con un pedido real esperando.
//
// `satisfies` y NO `const uberAdapter: DirectDeliveryAdapter = …`: anotar el tipo ENSANCHARÍA
// lo exportado y los llamadores perderían lo propio de Uber (`UberEventIdentity.resourceRef`,
// que es el puntero del que se saca el id del pedido). `satisfies` comprueba sin ensanchar.
const _uberCumpleElContrato = uberAdapter satisfies DirectDeliveryAdapter
void _uberCumpleElContrato
