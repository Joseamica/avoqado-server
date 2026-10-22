/**
 * Adaptador de Rappi — los CINCO métodos obligatorios del contrato directo.
 *
 * 🔴 Este adaptador YA ESTÁ REGISTRADO en `adapterRegistry` (fase 2, Tarea 5).
 *
 * `adapterRegistry` es la única fuente de verdad de "¿ya hay a quién delegarle?", y el dashboard
 * pinta `integrationReady` a partir de él. Con el registro, un canal RAPPI deja de verse como "no
 * lista": se puede pausar y reanudar la tienda desde Avoqado, y el menú, los agotados y el horario
 * viajan con las mismas llamadas que Uber.
 *
 * Rappi cancela solo el pedido que no se acepta en 4–6 minutos, por eso este adaptador declara
 * `soloAceptacionAutomatica`: no hay modo manual (ver la propiedad, más abajo).
 *
 * Lo que sí está aquí es lo caro y lo verificable: la firma (algoritmo distinto al de Uber),
 * la traducción de los 11 eventos, el mapeo del pedido con su red de cuadre, y las llamadas
 * de salida escritas contra los endpoints publicados — TODAS pasan por el candado de tiendas
 * de `rappi.http`, así que una tienda fuera de la lista de escritura del ambiente (o con la lista
 * vacía) no la puede tocar ninguna.
 *
 * 🔴 Las capacidades usan `import()` PEREZOSO de `rappi.client` a propósito: ese módulo lee
 * `@/config/env`, que valida y hace `process.exit` al cargarse — un import normal mataría a
 * los workers de Jest de todo el que importe este adaptador (regla del repo).
 */
import type { DeliveryProvider } from '@prisma/client'

import {
  DeliveryWriteNotSentError,
  type ActionResult,
  type CanonicalDeliveryEvent,
  type DenyReason,
  type EventIdentity,
  type NormalizedDeliveryOrder,
  type ProblemaDeMenu,
  type PublicacionDeMenu,
} from '../../core/types'
import type { MenuSnapshot } from '../../core/menuSnapshot.service'
import type { HorarioSemanal } from '../../core/deliveryHours.service'
// Sólo el TIPO (se borra al compilar): `rappi.estadoDelPedido` importa este archivo, así que su código se carga perezoso.
import type { CierreDeListo } from './rappi.estadoDelPedido'
import { aHorarioRappi } from './rappi.hours'
import { construirMenuRappi, type PreciosDeCanal } from './rappi.menuMapper'
import {
  extraerStoreId,
  normalizeRappiOrder,
  tiempoDeCoccion,
  type MetodoDeEntrega,
  type OpcionesDeTraduccion,
  type RappiOrderPayload,
} from './rappi.mapper'
import { verifyRappiSignature } from './rappi.signature'

/**
 * Qué lee la cocina al intentar cancelar un pedido de Rappi YA ACEPTADO (F2). Rappi no deja cancelarlo por API (M11, 21-oct:
 * 400 «Invalid transition from {TAKEN} to {REJECTED}»), así que aquí nunca se cancela: la venta se cancela cuando llega el
 * aviso de cancelación de Rappi (`ORDER_EVENT_CANCEL`).
 */
export const CANCELAR_ACEPTADO_RAPPI = {
  /** Repartidor de Rappi: la cancelación la hace su soporte. También es el texto si no se sabe quién entrega. */
  soporte:
    'Rappi no deja cancelar por sistema un pedido ya aceptado. Pídele la cancelación al soporte de Rappi; aquí se cancela solo cuando Rappi la confirme.',
  /** Repartidor del negocio o el cliente recoge: se cancela en la app de Rappi para aliados. */
  appDeAliados: 'Cancélalo en la app de Rappi para aliados; aquí se cancela solo cuando Rappi lo confirme.',
} as const

/** Las variantes en las que Rappi no manda repartidor: el negocio cancela en la app de aliados. */
const SIN_REPARTIDOR_DE_RAPPI: ReadonlySet<string> = new Set<MetodoDeEntrega>(['marketplace', 'pickup'])

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
   * 🔴 Rappi no admite el modo MANUAL: cancela el pedido que no se acepta en 4 a 6 minutos, así que una
   * cocina que "decide desde el POS" lo dejaría vencer. El núcleo lee este texto (nunca compara contra
   * el nombre del proveedor) y rechaza el MANUAL al crear o editar un canal con él.
   */
  soloAceptacionAutomatica:
    'Los pedidos de Rappi se aceptan solos: Rappi los cancela si no se aceptan en 4 a 6 minutos. Para dejar de recibirlos, pausa la tienda.',

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

  /** `opts` es de Rappi (la zona del negocio para la hora del pedido); el núcleo llama con el crudo solo. */
  normalizeOrder(raw: unknown, opts?: OpcionesDeTraduccion): NormalizedDeliveryOrder {
    return normalizeRappiOrder(raw, opts)
  },

  /**
   * Aceptar, declarando los minutos de preparación que RAPPI mismo sugirió en el pedido.
   *
   * Este camino lo usa el botón "Aceptar" del POS (`acceptDeliveryOrder`), que sólo trae los ids. Rappi ya no admite el
   * modo MANUAL: el procesador de eventos acepta SIEMPRE solo (`rappi.eventProcessor.ts`), así que el botón sólo aplica a un
   * pedido PENDING viejo, de antes de esa migración. El tiempo se recupera del evento persistido — el pedido completo
   * viajó en el webhook y ahí quedó guardado. Sin dato se cae al recorte de `tiempoDeCoccion`, nunca a un número fuera
   * del rango (Rappi lo rechazaría y el pedido seguiría vivo con el reloj corriendo).
   */
  async acceptOrder(orderId: string, storeId: string): Promise<ActionResult> {
    const [{ aceptarPedidoRappi }, { default: prisma }] = await Promise.all([import('./rappi.client'), import('@/utils/prismaClient')])

    const evento = await prisma.deliveryOrderEvent.findFirst({
      where: { provider: 'RAPPI', externalOrderId: orderId },
      orderBy: { receivedAt: 'desc' },
      select: { payload: true },
    })
    const detail = (evento?.payload as RappiOrderPayload | null)?.order_detail ?? {}
    return aceptarPedidoRappi(orderId, storeId, tiempoDeCoccion(detail))
  },

  /**
   * Rechazar. 🔴 Si el motivo es "estoy saturado" o "cerrado", Rappi NO lo admite — su
   * catálogo es sobre el pedido estando mal, no sobre la tienda. En ese caso NO se llama a
   * la red: se devuelve `ok:false` con la explicación de que lo correcto es PAUSAR, para que
   * el caller la muestre en vez de un error opaco.
   */
  async denyOrder(orderId: string, storeId: string, reason?: DenyReason): Promise<ActionResult> {
    const { rechazarPedidoRappi } = await import('./rappi.client')
    const { traduccion, http } = await rechazarPedidoRappi(orderId, storeId, reason)
    if (!traduccion.rechazable) return { ok: false, status: 0, raw: traduccion.explicacion }
    return http as ActionResult
  },

  /**
   * 🔴 No hay `cancelOrder` A PROPÓSITO: Rappi no deja cancelar por API un pedido ya aceptado (M11). Sin él, el núcleo no
   * cancela nada en Avoqado y muestra ESTE texto, que depende de quién entrega (`order_detail.delivery_method` del aviso
   * `NEW_ORDER` guardado en la venta, leído igual que en la ingesta: sin mayúsculas ni espacios). Sin el dato, o con uno
   * que no se reconoce, el del soporte: nunca se manda a una app que quizá no aplica.
   */
  instruccionesParaCancelar(raw: unknown): string {
    const metodo = String((raw as RappiOrderPayload | null)?.order_detail?.delivery_method ?? '')
      .trim()
      .toLowerCase()
    return SIN_REPARTIDOR_DE_RAPPI.has(metodo) ? CANCELAR_ACEPTADO_RAPPI.appDeAliados : CANCELAR_ACEPTADO_RAPPI.soporte
  },

  /**
   * "Listo para el repartidor". 🔴 Se llama `markOrderReady` porque es el nombre que el núcleo busca: con el nombre viejo
   * (`markReady`) el núcleo contestaba NOT_A_DELIVERY_ORDER y Rappi nunca se enteraba.
   *
   * Rappi deja de ejecutar acciones después de la TERCERA solicitud por pedido, y lo que siga es mal uso. Por eso cada
   * llamada se reserva y se CUENTA en la base ANTES de salir (`reservarLlamadaDeListo`, en la fila del aviso `NEW_ORDER`): un
   * reinicio no las olvida. Y cada reserva es UNA petición HTTP (`reintentarEn401: false`).
   *  · sin permiso (ya se usaron las 3, o ya cerró) ⇒ no sale a la red: `terminal`, `TOPE_DE_LISTO`;
   *  · sin el aviso del pedido, ni por su llave ni por el pedido (no hay dónde contar) ⇒ tampoco sale: `terminal`,
   *    `LISTO_SIN_AVISO`, sin cierre (no hay fila; el 🚨 lo deja la reserva). Codex b1 #4;
   *  · 2xx ⇒ se cierra (`HTTP_2XX`);
   *  · 400 de transición inválida ⇒ se cierra y es `terminal` (repetirla daría lo mismo);
   *  · el candado de tiendas o un token que no se pudo pedir (`DeliveryWriteNotSentError`: la llamada NO salió, Rappi no recibió
   *    nada) ⇒ se DEVUELVE la reserva (`devolverLlamadaDeListo`) y el error se relanza igual: no gasta una de las 3;
   *  · lo demás (el 424 «inténtelo más tarde» que dio el sandbox, un 5xx, un 401) se devuelve tal cual: ya contó.
   * Si la reserva no se puede escribir, la llamada NO sale (sin contar no se llama). Si falla el CIERRE, la respuesta se
   * devuelve igual: el 2xx no se pierde (el núcleo lo acredita) y, sin cierre, el tope sigue protegiendo.
   */
  async markOrderReady(orderId: string, storeId: string): Promise<ActionResult> {
    const [{ marcarListoRappi }, estado, { default: logger }] = await Promise.all([
      import('./rappi.client'),
      import('./rappi.estadoDelPedido'),
      import('@/config/logger'),
    ])
    const cerrar = (como: CierreDeListo) =>
      estado.cerrarListo(orderId, storeId, como).catch(error =>
        logger.warn('🛵 [Rappi] no se pudo anotar el cierre del «listo» (el tope de llamadas sigue protegiendo)', {
          orderId,
          storeId,
          como,
          error: error instanceof Error ? error.message : String(error),
        }),
      )

    const reserva = await estado.reservarLlamadaDeListo(orderId, storeId)
    if (!reserva.permitido) {
      // Sin aviso no hay qué cerrar: otra búsqueda sólo repetiría la que acaba de fallar.
      if (reserva.sinAviso) return { ok: false, status: 0, raw: 'LISTO_SIN_AVISO', terminal: true }
      logger.warn('🛵 [Rappi] «listo» sin llamada: ya se usaron las 3 que Rappi atiende (o ya cerró); no sale a la red', {
        orderId,
        storeId,
      })
      await cerrar('TOPE')
      return { ok: false, status: 0, raw: 'TOPE_DE_LISTO', terminal: true }
    }

    let r: Awaited<ReturnType<typeof marcarListoRappi>>
    try {
      r = await marcarListoRappi(orderId, storeId, { reintentarEn401: false })
    } catch (error) {
      // 🔴 SÓLO cuando se SABE que no salió. Cualquier otra falla (red a medias, un timeout) pudo haber llegado a Rappi: ya contó.
      if (error instanceof DeliveryWriteNotSentError) {
        await estado.devolverLlamadaDeListo(orderId, storeId).catch(e =>
          logger.warn('🛵 [Rappi] no se pudo devolver la reserva del «listo» que no salió (queda contada: el tope sigue protegiendo)', {
            orderId,
            storeId,
            error: e instanceof Error ? e.message : String(e),
          }),
        )
      }
      throw error
    }
    if (r.status >= 200 && r.status < 300) {
      await cerrar('HTTP_2XX')
      return r
    }
    if (r.status === 400 && estado.esTransicionInvalida(r.raw)) {
      await cerrar('TRANSICION_INVALIDA')
      return { ...r, terminal: true }
    }
    return r
  },

  /**
   * Agotado/disponible por SKU. ⚠️ Es el ÚNICO camino que reactiva un producto apagado:
   * republicar el menú NO lo hace (documentado en su FAQ).
   */
  async setItemSoldOut(itemId: string, storeId: string, agotado: boolean): Promise<ActionResult> {
    const { disponibilidadItemsRappi } = await import('./rappi.client')
    return disponibilidadItemsRappi(storeId, agotado ? { turn_off: [itemId] } : { turn_on: [itemId] })
  },

  /**
   * Pausar/reanudar la tienda — por el endpoint SÍNCRONO, que contesta por tienda si de
   * verdad quedó. `SUSPENDED` o `STORE_NOT_PUBLISHED` es `ok:false` AUNQUE el HTTP sea 200:
   * pintar "activa" cuando Rappi dijo que no es el botón que miente que ya se arregló una
   * vez en Uber.
   */
  async setStoreStatus(paused: boolean, storeId: string): Promise<ActionResult> {
    const { habilitarTiendaRappi } = await import('./rappi.client')
    const r = await habilitarTiendaRappi(storeId, !paused)

    const quedo = r.resultadoTienda === 'SUCCESS' || r.resultadoTienda === 'STORE_ALREADY_IN_STATUS'
    if (r.ok && !quedo) {
      return { ok: false, status: r.status, raw: `${r.resultadoTienda ?? 'SIN_RESULTADO'}: ${r.mensajeTienda ?? r.raw.slice(0, 200)}` }
    }
    return r
  },

  /**
   * 🔴 El 2xx del `POST /menu` significa «en revisión» (*"Menu updated and ready to be validated"*), NO publicado: lo
   * publicado lo dice `MENU_APPROVED`. Con esto el sincronizador no sella la huella con el 2xx y no republica encima de la
   * revisión.
   */
  menuConRevision: true,

  /**
   * Publicar el menú. 🔴 Un `ok` aquí significa "en revisión", NO publicado — lo publicado
   * llega por `MENU_APPROVED`. Los productos que Rappi rechazaría se filtran y REPORTAN
   * antes de mandar: el rechazo asíncrono (`MENU_REJECTED`) viene sin motivo, así que cada
   * regla atrapada aquí es un rechazo que no habrá que adivinar.
   *
   * `problemas` junta, a la vista del dueño: lo que el mapeo filtró, cada precio redondeado y, con un 400 (o 422) del POST,
   * los `errors[]` del cuerpo (la validación inmediata de Rappi SÍ trae motivos: `{ reason, relatedItems[] }`).
   */
  async publishMenu(snapshot: MenuSnapshot, storeId: string, opts?: { precios?: unknown }): Promise<PublicacionDeMenu> {
    const [{ publicarMenuRappi }, { default: logger }] = await Promise.all([import('./rappi.client'), import('@/config/logger')])

    const { payload, problemas } = construirMenuRappi(snapshot, storeId, { precios: opts?.precios as PreciosDeCanal | undefined })
    if (problemas.length) {
      logger.warn('📋 [Rappi] lo que no se publica tal cual (filtrado porque Rappi lo rechazaría, o precio redondeado)', {
        storeId,
        problemas,
      })
    }
    if (payload.items.length === 0) {
      return { ok: false, status: 0, raw: 'El menú quedó vacío tras filtrar lo que Rappi rechazaría — no se mandó nada.', problemas }
    }
    const r = await publicarMenuRappi(payload)
    return { ...r, problemas: r.status === 400 || r.status === 422 ? [...problemas, ...motivosDelRechazo(r.raw)] : problemas }
  },

  buildMenuPayload(snapshot: MenuSnapshot, opts?: { precios?: unknown }): unknown {
    return construirMenuRappi(snapshot, 'PREVIEW', { precios: opts?.precios as PreciosDeCanal | undefined }).payload
  },

  mapHours(horario: HorarioSemanal): unknown {
    return aHorarioRappi(horario)
  },
}

/**
 * Los motivos de un 400 del `POST /menu`, uno por producto señalado. Forma documentada (referencia de menús, «400 La estructura
 * del menú es invalida»): `{ message, errors: [{ reason, relatedItems: [{ sku, … }] }] }`. Un error sin productos queda como
 * `(menú)`. Un cuerpo que no tiene esa forma no truena: queda su texto (recortado) como único motivo.
 */
export function motivosDelRechazo(raw: string): ProblemaDeMenu[] {
  let errores: unknown
  try {
    errores = (JSON.parse(raw) as { errors?: unknown } | null)?.errors
  } catch {
    errores = undefined
  }
  if (!Array.isArray(errores) || errores.length === 0) {
    return [{ sku: '(menú)', problema: `Rappi rechazó el menú sin motivos legibles: ${raw.slice(0, 300)}` }]
  }
  return errores.flatMap((e): ProblemaDeMenu[] => {
    const err = (e ?? {}) as { reason?: unknown; relatedItems?: unknown }
    const problema = `Rappi rechazó: ${String(err.reason ?? 'sin motivo').slice(0, 500)}`
    const items = Array.isArray(err.relatedItems) ? err.relatedItems : []
    if (items.length === 0) return [{ sku: '(menú)', problema }]
    return items.map(i => ({ sku: String((i as { sku?: unknown } | null)?.sku ?? '(sin sku)').slice(0, 500), problema }))
  })
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
