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
import { aDisponibilidadUber, mapSnapshotToUberMenu, type UberMenuOptions } from './uber.menuMapper'
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
    // [doc] Uber manda esto cuando NECESITA el menú — típicamente porque se le perdió o
    // quedó incompleto de su lado. Ignorarlo deja la tienda con un menú viejo o vacío y
    // nadie se entera hasta que un cliente no encuentra qué pedir.
    if (eventType === 'store.menu_refresh_request') return 'MENU_REFRESH'
    // [verificado con un evento REAL, 2026-08-21] El reporte financiero llega por aquí, y
    // es la ÚNICA vía por la que nos enteramos de un reembolso: la API de pedidos no los
    // reporta ('Refunds/chargebacks appear only in Reporting', guía de Uber).
    if (eventType === 'eats.report.success') return 'REPORT_READY'
    // Pedido para MÁS TARDE. Antes caía en 'IGNORED' y se perdía ENTERO: el cliente pedía a
    // las 3pm para las 8pm y en Avoqado no existía. [doc] es de la generación 1.0.0 de la API.
    if (eventType === 'orders.scheduled.notification') return 'SCHEDULED_ORDER'
    // "Ya es hora" de un programado (Fast Order Release: el repartidor llegó a la zona).
    if (eventType === 'orders.release') return 'RELEASE'
    // El cliente cambió algo del pedido —quitó, sustituyó— y lo confirmó en su app.
    if (eventType === 'order.fulfillment_issues.resolved') return 'FULFILLMENT_CHANGED'
    // La tienda cambió de estado del lado de Uber. `deprovisioned` es el que más duele:
    // nos quitaron el acceso y seguiríamos creyendo que el canal está vivo.
    if (eventType === 'store.provisioned' || eventType === 'store.deprovisioned' || eventType === 'store.status.changed') {
      return 'STORE_STATE'
    }
    return 'IGNORED'
  },

  /** Los eventos de Uber que significan "llegó un pedido" — incluye los programados. */
  orderEventTypes(): string[] {
    return ['orders.notification', 'orders.scheduled.notification']
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
    // uAPI. Body `{}` verificado contra el sandbox (27-ago): pasa la validación de campos —
    // el clásico `accept_pos_order` ya no lo rastrea la validación de Uber.
    const r = await uberApi({
      method: 'POST',
      path: `/v1/delivery/order/${encodeURIComponent(orderId)}/accept`,
      storeId,
      body: {},
    })
    const ok = r.status < 400 || r.status === 409
    if (!ok) logger.warn('Uber rechazó el accept', { orderId, status: r.status, cuerpo: r.text.slice(0, 200) })
    return { ok, status: r.status, raw: r.text }
  },

  /**
   * Pausa o reanuda la tienda en el proveedor.
   *
   * 🔴 Es lo que evita el peor círculo de esta integración: si la cocina se satura o el
   * negocio cierra temprano y NO hay forma de pausar, los pedidos siguen entrando y hay que
   * rechazarlos uno por uno. Uber cuenta cada rechazo contra la tasa de inyección que exige
   * (99.9%, revocación por debajo de 99%): o sea que no poder pausar termina costando la
   * integración completa, no sólo unos pedidos.
   *
   * Pausar NO cierra el negocio: los clientes lo siguen viendo, sólo no pueden pedir. Es
   * reversible y es la herramienta correcta para "ahorita no", a diferencia de despublicar
   * el menú.
   */
  async setStoreStatus(paused: boolean, storeId: string, motivo?: string): Promise<UberActionResult> {
    const r = await uberApi({
      method: 'POST',
      // ⚠️ `store` en SINGULAR. La documentación de Uber lo publica en plural y ese da 404 —
      // verificado el 2026-08-17 contra la API real. No lo "corrijas" a `stores`.
      path: `/v1/eats/store/${encodeURIComponent(storeId)}/status`,
      storeId,
      body: paused ? { status: 'PAUSED', reason: motivo ?? 'Pausado desde el punto de venta', pause_duration: 3600 } : { status: 'ONLINE' },
    })
    const ok = r.status < 400
    if (!ok)
      logger.error('🚨 Uber rechazó el cambio de estado de la tienda', { storeId, paused, status: r.status, cuerpo: r.text.slice(0, 300) })
    else logger.info(`🏪 [Uber] tienda ${paused ? 'PAUSADA' : 'REANUDADA'}`, { storeId, motivo })
    return { ok, status: r.status, raw: r.text }
  },

  /** ¿Está la tienda recibiendo pedidos ahora mismo, según el proveedor? */
  async getStoreStatus(storeId: string): Promise<{ ok: boolean; status: number; estado?: string; motivo?: string; raw: string }> {
    const r = await uberApi({ method: 'GET', path: `/v1/eats/store/${encodeURIComponent(storeId)}/status`, storeId })
    const j = r.json as { status?: string; offlineReason?: string } | undefined
    return { ok: r.status < 400, status: r.status, estado: j?.status, motivo: j?.offlineReason, raw: r.text }
  },

  /**
   * Cancela un pedido YA ACEPTADO.
   *
   * Distinto de `denyOrder`, que es rechazarlo antes de aceptarlo. Este es para cuando ya
   * dijimos que sí y algo lo impide después — por ejemplo, que no podamos hacerle llegar a
   * la cocina una instrucción de ALERGIA.
   *
   * ⚠️ `cancelling_party` sólo acepta `MERCHANT` (medido: `RESTAURANT` devuelve 400).
   */
  async cancelOrder(orderId: string, storeId: string, reason = 'OUT_OF_ITEMS'): Promise<UberActionResult> {
    const r = await uberApi({
      method: 'POST',
      path: `/v1/delivery/order/${encodeURIComponent(orderId)}/cancel`,
      storeId,
      // Body `{}` verificado contra el sandbox: pasa la validación de campos del uAPI.
      body: {},
    })
    const ok = r.status < 400
    if (!ok) logger.error('🚨 Uber rechazó la cancelación', { orderId, status: r.status, cuerpo: r.text.slice(0, 200) })
    return { ok, status: r.status, raw: r.text }
  },

  /** El menú traducido, sin publicarlo — para que el sincronizador le saque huella. */
  buildMenuPayload(snapshot: MenuSnapshot, opts?: UberMenuOptions): unknown {
    return mapSnapshotToUberMenu(snapshot, opts)
  },

  /** Traduce el horario neutral del núcleo al formato de disponibilidad de Uber. */
  mapHours(horario: Parameters<typeof aDisponibilidadUber>[0]) {
    return aDisponibilidadUber(horario)
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
    // uAPI: `deny_reason.info` es REQUERIDO (verificado con el 400 de validación del
    // sandbox: "info is a required field"). `type` viaja también con el motivo del POS.
    const r = await uberApi({
      method: 'POST',
      path: `/v1/delivery/order/${encodeURIComponent(orderId)}/deny`,
      storeId,
      body: { deny_reason: { type: reason, info: reason } },
    })
    const ok = r.status < 400
    if (!ok) logger.warn('Uber rechazó el deny', { orderId, status: r.status, cuerpo: r.text.slice(0, 200) })
    return { ok, status: r.status, raw: r.text }
  },

  /**
   * "La comida ya está lista." Le dice a Uber que puede mandar (o apurar) al repartidor.
   *
   * 🔴 Capacidad NUEVA que la validación de Uber exige ver funcionando (caso 59605086:
   * "Order: Mark Order as Ready"). Se dispara cuando la COCINA marca listo en el KDS — el
   * mismo gesto que ya hacía para pedidos de mesa, sin botón nuevo.
   *
   * El 409 cuenta como éxito, igual que el accept: "ya estaba listo" tras un reintento no
   * es un error.
   */
  async markOrderReady(orderId: string, storeId: string): Promise<UberActionResult> {
    const r = await uberApi({
      method: 'POST',
      path: `/v1/delivery/order/${encodeURIComponent(orderId)}/ready`,
      storeId,
      body: {},
    })
    const ok = r.status < 400 || r.status === 409
    if (!ok) logger.warn('Uber rechazó el ready', { orderId, status: r.status, cuerpo: r.text.slice(0, 200) })
    return { ok, status: r.status, raw: r.text }
  },

  /**
   * "No tengo este artículo" DESPUÉS de aceptar: avisa al cliente en la app de Uber para
   * que decida (cancelar o modificar), en vez de recibir una bolsa incompleta sin aviso.
   *
   * Contrato verificado contra un pedido REAL del sandbox (27-ago), no contra la doc:
   * `issue_type: 'OUT_OF_ITEM'`, `item.cart_item_id` (el id de LÍNEA del pedido, no el del
   * menú) y **`action_type` es OBLIGATORIO** — sin él Uber responde 400 "All items within
   * fulfillment_issues must have a valid action_type passed". De los 7 valores probados sólo
   * `REMOVE_ITEM` pasa la validación; los demás repiten el mismo 400.
   *
   * 🔴 Sólo se puede ANTES de marcar listo: después Uber contesta "cannot modify order that
   * has already been marked ready".
   */
  async resolveFulfillmentIssues(orderId: string, storeId: string, cartItemIds: string[]): Promise<UberActionResult> {
    const r = await uberApi({
      method: 'POST',
      path: `/v1/delivery/order/${encodeURIComponent(orderId)}/resolve-fulfillment-issues`,
      storeId,
      body: {
        fulfillment_issues: cartItemIds.map(cartItemId => ({
          issue_type: 'OUT_OF_ITEM',
          action_type: 'REMOVE_ITEM',
          item: { cart_item_id: cartItemId },
        })),
      },
    })
    const ok = r.status < 400
    if (!ok) logger.warn('Uber rechazó el resolve-fulfillment-issues', { orderId, status: r.status, cuerpo: r.text.slice(0, 200) })
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
