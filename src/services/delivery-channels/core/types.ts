import { DeliveryChannelLink, DeliveryProvider, OrderSource } from '@prisma/client'
import type { HorarioSemanal } from './deliveryHours.service'
import type { MenuSnapshot } from './menuSnapshot.service'

/** Estados internos que el core propaga hacia el canal (el adapter los traduce). */
export type DeliveryOrderStatus = 'ACCEPTED' | 'PREPARING' | 'READY' | 'PICKED_UP' | 'CANCELLED' | 'FAILED'

/**
 * 🔴 Todo el dinero viaja como STRING DECIMAL, nunca `number`
 * (`.claude/rules/critical-warnings.md`: Money = Decimal, Never Float).
 * El ÷100 de los centavos del proveedor ocurre en SU mapper, jamás aquí ni en el core.
 *
 * Historia: hasta 2026-08-20 este contrato usaba `number` y documentaba como normal que
 * los montos NO cuadraran ("pueden no cuadrar aritméticamente contra total"). Eso es lo
 * que permitió que la propina se contara dos veces. Ahora el reparto es explícito y se
 * verifica con `assertDeliveryMoneyInvariants`.
 */
export interface NormalizedDeliveryModifier {
  externalId: string
  name: string
  quantity: number
  /** PESOS, string decimal. Ya multiplicado por la cantidad del padre si aplica. */
  price: string
}

export interface NormalizedDeliveryItem {
  /** id del item en el catálogo del proveedor */
  externalId: string
  /** Lo que Avoqado escribió al publicar el menú (su `Product.sku`), si el proveedor lo devuelve */
  externalData?: string | null
  name: string
  quantity: number
  /** PESOS, string decimal */
  unitPrice: string
  /** total de la línea = unitPrice × quantity + modificadores */
  total: string
  /**
   * Lo que el cliente pidió por escrito para ESTE renglón ("sin cebolla", "bien cocido").
   * Va a la comanda de cocina: es la diferencia entre servir bien y servir mal.
   */
  notes?: string | null
  modifiers?: NormalizedDeliveryModifier[]
  /** id de LÍNEA del pedido en el proveedor (Uber: cart_item_id) */
  lineId?: string
}

/**
 * Reparto explícito de quién cobra qué. Lo entrega el ADAPTADOR; el core NO deduce nada.
 * Invariantes (verificadas por `assertDeliveryMoneyInvariants` en `core/money.ts`):
 *   saleAmount + shippingAsLine + merchantFees − discountAmount === externallyPaidSale + cashDueSale
 *   tipAmount                 === externallyPaidTip  + cashDueTip
 *
 * 🔴 Dinero en STRING DECIMAL, nunca `number` (`.claude/rules/critical-warnings.md`).
 */
export interface NormalizedDeliveryPayment {
  currency: 'MXN'
  /** artículos, IVA incluido (México) */
  saleAmount: string
  /**
   * Rappi 2b: envío del NEGOCIO (repartidor propio) que se registra como RENGLÓN «Envío» de la orden, no como cargo: así lo
   * cuentan el total canónico, el saldo y el CFDI. Es venta. Los renglones de `items` siguen cuadrando contra `saleAmount`
   * (sin el envío). Opcional: los canales que no lo usan se leen como 0.
   */
  shippingAsLine?: string
  /** cargos cobrados al cliente que se pagan AL COMERCIO (bolsa, envío propio…) */
  merchantFees: string
  /**
   * Promociones y descuentos aplicados al pedido, IVA incluido (México: el precio en pantalla
   * ya lo lleva, así que el descuento se aplica sobre el precio con impuesto).
   *
   * Se guarda APARTE de `saleAmount` a propósito, como hace el mercado: Square define las
   * ventas brutas SIN ajustar por descuentos y las netas como la resta, y Fudo tiene
   * «Descuentos ($)» como línea propia del reporte. Así el negocio ve cuánto le costaron sus
   * promociones en vez de encontrarse una venta más chica sin explicación — y de paso
   * `saleAmount` sigue cuadrando al centavo contra la suma de los renglones.
   *
   * Opcional: los canales que aún no lo informan siguen funcionando igual (se lee como 0).
   */
  discountAmount?: string
  tipAmount: string
  /** parte de (saleAmount + merchantFees) que la plataforma liquida al comercio */
  externallyPaidSale: string
  externallyPaidTip: string
  /** parte que el comercio cobra en efectivo en persona */
  cashDueSale: string
  cashDueTip: string
  /**
   * Rappi 2b (F7): dinero que el negocio cobra en efectivo POR CUENTA de la plataforma (tarifa de servicio de Rappi en
   * marketplace/cash). No es venta ni propina: entra al cajón como PAY_IN «cobrado por cuenta de Rappi». Sólo existe si hay
   * algo por cobrar en efectivo. Opcional (0).
   */
  thirdPartyCashDue?: string
}

export interface NormalizedDeliveryOrder {
  /** id del pedido en el proveedor. Se namespacea al guardarlo: `{PROVIDER}:{externalId}` */
  externalId: string
  /** número corto que ve el repartidor y va en el ticket */
  displayId: string
  source: OrderSource
  items: NormalizedDeliveryItem[]
  payment: NormalizedDeliveryPayment
  customer?: { name?: string; phone?: string; phonePin?: string; note?: string }
  /** JSON crudo del proveedor, para auditoría — va a `Order.posRawData` */
  raw: unknown
  placedAt: Date
  /**
   * Para cuándo lo pidió el cliente, si NO es inmediato.
   *
   * 🔴 Un pedido programado NO va a la cocina al recibirse: se pidió a las 3pm para las 8pm
   * y cocinarlo al llegar tira la comida. La comanda espera al aviso de "ya es hora".
   */
  scheduledFor?: Date | null
  /**
   * El proveedor dice que el pedido YA está aceptado (Uber: `state = 'ACCEPTED'`). Es la
   * evidencia que recupera una aceptación cuyo 2xx se perdió; la ingesta sólo lee esta marca,
   * nunca pregunta quién es el proveedor.
   */
  providerAccepted?: boolean
  /** Hora acreditada de esa aceptación; al reintentar se conserva la original. */
  providerAcceptedAt?: Date
  /**
   * El proveedor ya CERRÓ el pedido (entregado, fallido): ya no admite cambios. Un retiro que siga
   * esperando con el renglón todavía presente no va a ocurrir (spec §3.4, ruling I-2 de la
   * revisión final). Ausente = el proveedor no lo informa: se trata como abierto.
   */
  providerClosed?: boolean
}

// ============================================================================
// Capacidades del adaptador (plan 2026-08-20, Tarea 2) — forward-looking: nada
// las consume todavía (ni deliverect.adapter.ts las implementa, ni statusDispatcher
// las llama). Existen como el contrato que un adaptador multi-provider futuro
// (Rappi/DiDi/Uber directo) implementará. El core las consultaría por presencia
// (`typeof adapter.X === 'function'`), nunca preguntando quién es el proveedor.
// ============================================================================

export interface EventIdentity {
  eventId: string
  eventType: string
  /** id de la tienda en el proveedor — es como se resuelve el venue */
  storeId: string | null
  /** id del PEDIDO (agrupa varios eventos del mismo pedido) */
  orderId: string | null
  /** Presente si el webhook manda un puntero en vez del pedido (Uber). */
  resourceRef?: string | null
}

export type WebhookVerdict = 'VALID' | 'INVALID_SIGNATURE' | 'MALFORMED'

/**
 * El repartidor asignado a un pedido, para "¿quién trae esto?" en el KDS. Todo opcional
 * porque el proveedor lo manda tal cual lo tenga — un campo ausente no es un error, es que
 * Uber todavía no lo sabe o no lo comparte.
 */
export interface CourierInfo {
  name?: string
  phone?: string
  /** Código/pin necesario para poder llamar al número anónimo del repartidor. */
  phoneCode?: string
  vehicle?: { make?: string; model?: string; licensePlate?: string }
  pictureUrl?: string
}

export type DenyReason = 'OUT_OF_ITEMS' | 'STORE_CLOSED' | 'TOO_BUSY' | 'OTHER'

export interface ActionResult {
  ok: boolean
  status: number
  /** Cuerpo crudo — se guarda para auditoría cuando falla. */
  raw: string
  /**
   * El proveedor ya no admite esta acción para este pedido: NO repetirla. Lo decide el adaptador (un tope de llamadas
   * del proveedor, una transición que su máquina de estados ya no permite). 🔴 No significa «hecho»: el núcleo nunca
   * acredita nada por esta marca, sólo deja de intentar. Ausente = se puede volver a intentar, como siempre.
   */
  terminal?: boolean
}

/**
 * Algo del menú que el dueño tiene que ver: un producto que no se publicó, un precio que se ajustó, o un motivo con que el
 * proveedor rechazó el menú. `sku` es el del producto (o un marcador como `pasillo:…` o `(menú)` si no es de uno solo).
 */
export type ProblemaDeMenu = { sku: string; problema: string }

/**
 * El resultado de publicar el menú. `problemas` presente (aunque vacío) = el adaptador los informa y el sincronizador los
 * guarda a la vista; ausente = el adaptador no los informa y no se toca lo guardado.
 *
 * 🔴 CON REVISIÓN (`menuConRevision`), el `status` se lee así y el sincronizador decide con él:
 *  · 2xx = «lo recibí, lo voy a revisar» (NO publicado: lo dirá un veredicto aparte);
 *  · 4xx = el proveedor dijo que no (con 400/422 la huella queda rechazada);
 *  · `status: 0` = el adaptador NO salió a la red (p. ej. el menú quedó vacío tras filtrar): se SABE que no se mandó nada y la
 *    pendiente se suelta, sin esperar un veredicto que nunca va a llegar;
 *  · 5xx = no se sabe si lo procesó: la pendiente se queda.
 * Un timeout o un error de red NO vuelven como `status: 0`: se LANZAN (y quien llama no puede saber si el proveedor lo recibió,
 * así que la pendiente también se queda). Lo que sí se SABE que no salió (token, candado de escrituras) se lanza como
 * `DeliveryWriteNotSentError`.
 */
export interface PublicacionDeMenu extends ActionResult {
  problemas?: ProblemaDeMenu[]
}

/**
 * La escritura al proveedor NO salió: falló ANTES de la red (el candado de escrituras, su lectura a
 * la base, el token). Se SABE que el proveedor no recibió nada — a diferencia de un timeout/5xx, donde
 * no se sabe y por eso queda en duda. `STORE_NOT_AUTHORIZED`: la tienda no tiene permiso de escritura
 * (consentimiento revocado, app del proveedor cambiada); `UNAVAILABLE`: cualquier otro fallo previo.
 * `paraLaCocina` (opcional): el texto que ve la cocina cuando el proveedor sabe algo más preciso que el genérico de «tienda desconectada».
 */
export class DeliveryWriteNotSentError extends Error {
  readonly reason: 'STORE_NOT_AUTHORIZED' | 'UNAVAILABLE'
  readonly paraLaCocina?: string
  constructor(reason: 'STORE_NOT_AUTHORIZED' | 'UNAVAILABLE', message: string, paraLaCocina?: string) {
    super(message)
    this.name = 'DeliveryWriteNotSentError'
    this.reason = reason
    this.paraLaCocina = paraLaCocina
  }
}

/**
 * Lo que lee la cocina al intentar cancelar un pedido YA ACEPTADO cuyo proveedor no cancela por API y cuyo adaptador no
 * trae `instruccionesParaCancelar`. Vive aquí, junto al contrato, para que el núcleo y el controlador lean el mismo texto.
 */
export const TEXTO_PROVEEDOR_NO_CANCELA = 'Esta app de delivery no deja cancelar por sistema un pedido ya aceptado: pídeselo a su soporte.'

/**
 * Contrato LEGADO de Deliverect. Congelado: Deliverect es el fallback, no el camino nuevo.
 *
 * No se le agregan métodos. Un proveedor DIRECTO (Uber, y mañana Rappi/DiDi) implementa
 * `DirectDeliveryAdapter`, abajo.
 */
export interface DeliveryProviderAdapter {
  readonly provider: DeliveryProvider
  verifySignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, link: DeliveryChannelLink): boolean
  parseOrderWebhook(rawBody: Buffer, link: DeliveryChannelLink): NormalizedDeliveryOrder
  sendStatusUpdate(link: DeliveryChannelLink, externalOrderId: string, status: DeliveryOrderStatus): Promise<void>
  pushMenu(link: DeliveryChannelLink, snapshot: MenuSnapshot): Promise<void>
  setChannelPaused(link: DeliveryChannelLink, paused: boolean): Promise<void>
}

/**
 * 🔴 EL CONTRATO de un proveedor DIRECTO. Esto es lo que hay que implementar para que
 * "agregar Rappi" sea una semana y no tres.
 *
 * Los tres primeros son OBLIGATORIOS porque son, literalmente, lo que significa recibir un
 * pedido: comprobar que el mensaje es auténtico, saber de qué tienda y qué pedido es, y
 * traducirlo al contrato interno. Sin cualquiera de los tres no hay integración.
 *
 * 🔴 Que sean obligatorios es EL punto. La versión anterior de este archivo declaraba estos
 * mismos métodos como OPCIONALES junto a los cinco de Deliverect, y el resultado es que no
 * obligaba a nada: un adaptador de Rappi literalmente vacío compilaba, y Uber —que sí los
 * implementa— NO satisfacía la interface (le faltaban los cinco de Deliverect), así que el
 * registro tuvo que tipar con `typeof uberAdapter`. Un contrato que nadie puede cumplir no
 * es un contrato, es documentación que miente.
 *
 * Lo demás son CAPACIDADES: se declaran sólo si la API del proveedor las tiene. Uber exige
 * ir por el pedido (`fetchOrder`) y contestar dentro del plazo (`acceptOrder`); otro
 * proveedor puede mandar el pedido completo y no esperar respuesta.
 *
 * `storeId` es el id de la tienda EN EL PROVEEDOR (`DeliveryChannelLink.externalLocationId`).
 * Si algún proveedor necesita más contexto que eso, el parámetro crece ENTONCES, con el caso
 * real enfrente — no antes. (Aquí vivía un `ProviderContext` inventado para un Rappi que
 * todavía no existe: nadie lo usó nunca.)
 */
/**
 * Lo que el NÚCLEO entiende de un evento. Cada proveedor los llama distinto —Uber manda
 * `orders.notification` y `orders.cancel`, otro mandará otra cosa— y traducir es trabajo del
 * adaptador. El núcleo jamás compara contra la cadena de un proveedor.
 *
 * (Esa comparación ya nos costó un bug: `statusDispatcher` filtraba `eventType: 'order'`,
 * vocabulario de Deliverect, y por eso fallaba en CADA pedido de Uber.)
 */
export type CanonicalDeliveryEvent =
  | 'NEW_ORDER' // hay un pedido nuevo que ingerir
  | 'CANCEL' // el proveedor canceló el pedido: NO se debe seguir cocinando ni cobrar
  | 'MENU_REFRESH' // el proveedor PIDE el menú: se le manda aunque creamos que ya lo tiene
  | 'SCHEDULED_ORDER' // pedido para MÁS TARDE: entra como venta pero NO va a la cocina todavía
  | 'RELEASE' // ya es hora del pedido programado: AHORA sí va a la cocina
  | 'FULFILLMENT_CHANGED' // el cliente cambió algo del pedido y lo confirmó
  | 'STORE_STATE' // la tienda cambió de estado del lado del proveedor (conectada, quitada, pausada)
  | 'REPORT_READY' // el reporte financiero está listo: es la ÚNICA vía para enterarse de un reembolso
  | 'IGNORED' // ruido conocido (cambios de estado, provisioning) — se marca visto y ya

export interface DirectDeliveryAdapter {
  readonly provider: DeliveryProvider

  /** ¿El mensaje es auténtico? Recibe TODOS los secretos vigentes para tolerar la rotación. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, secrets: string[]): boolean

  /** ¿De qué tienda y de qué pedido es? Cada proveedor lo pone en otro campo. */
  extractIdentity(payload: unknown): EventIdentity

  /**
   * Traduce el nombre del evento del proveedor a uno canónico. 🔴 Devolver 'IGNORED' ante
   * algo desconocido es DELIBERADO y no es pereza: un evento que no sabemos leer NO puede
   * disparar una acción adivinada sobre dinero o comida. Queda persistido y visible.
   */
  classifyEvent(eventType: string): CanonicalDeliveryEvent

  /**
   * Los nombres de evento —SUYOS— que significan "un cliente hizo un pedido".
   *
   * Existe para que el núcleo pueda CONTAR pedidos (la tasa de inyección) sin escribir
   * `'orders.notification'`, que es vocabulario de Uber. Lo pide el guardrail de
   * `adapterRegistry.test.ts`, y con razón: el mismo error —el núcleo comparando contra la
   * cadena de un proveedor— ya causó tres bugs en este módulo.
   */
  orderEventTypes(): string[]

  /** Del formato crudo del proveedor al contrato interno. Aquí vive TODA la diferencia. */
  normalizeOrder(raw: unknown): NormalizedDeliveryOrder

  /** Sólo si el webhook manda un PUNTERO en vez del pedido (es el caso de Uber). */
  fetchOrder?(orderId: string, signal?: AbortSignal): Promise<unknown>

  /** Sólo si el proveedor espera que el POS conteste — y normalmente con un plazo. */
  acceptOrder?(orderId: string, storeId: string): Promise<ActionResult>
  denyOrder?(orderId: string, storeId: string, reason?: DenyReason): Promise<ActionResult>

  /**
   * Cancela un pedido YA ACEPTADO. NO es lo mismo que `denyOrder`:
   *  · denegar  = rechazarlo ANTES de decir que sí. Limpio; el cliente se entera al instante.
   *  · cancelar = deshacerlo DESPUÉS. Cuesta más caro: el cliente ya está esperando su comida.
   */
  cancelOrder?(orderId: string, storeId: string, reason?: DenyReason): Promise<ActionResult>

  /**
   * Para un proveedor SIN `cancelOrder`: qué debe hacer la cocina para cancelar un pedido YA ACEPTADO, en español y listo
   * para mostrarse. `raw` es el crudo del pedido guardado en la venta (`Order.posRawData`), por si el camino depende del
   * pedido (p. ej. de quién lo entrega).
   *
   * 🔴 Existe porque, sin cancelación por API, el núcleo NO cancela en Avoqado (F2): cancelar sólo de nuestro lado sacaba
   * el pedido de la cocina mientras el proveedor seguía mandando al repartidor. La venta se cancela cuando llega el aviso
   * de cancelación del proveedor. Sin esta capacidad, el núcleo usa un texto genérico que manda al soporte del proveedor.
   */
  instruccionesParaCancelar?(raw: unknown): string

  /**
   * "La comida ya está lista": avisa al proveedor que puede mandar (o apurar) al repartidor.
   * Capacidad que la validación de producción de Uber exige ver funcionando (caso 59605086,
   * "Order: Mark Order as Ready"). La dispara el KDS al marcar listo — sin botón nuevo.
   *
   * Un proveedor que limita cuántas veces se puede decir (o que ya no admite el cambio de estado) contesta `terminal`: el
   * núcleo deja de intentar (`NO_REINTENTAR`) sin dar el pedido por listo. 🔴 Es el ÚNICO nombre que el núcleo busca.
   */
  markOrderReady?(orderId: string, storeId: string): Promise<ActionResult>

  /**
   * "No tengo estos artículos" DESPUÉS de aceptar: el proveedor avisa al cliente en su app
   * para que decida (cancelar o modificar) en vez de recibir una bolsa incompleta.
   * `cartItemIds` son ids de LÍNEA del pedido del proveedor, no de nuestro menú.
   */
  resolveFulfillmentIssues?(orderId: string, storeId: string, cartItemIds: string[]): Promise<ActionResult>

  /**
   * "¿Quién trae este pedido?" — nombre, teléfono (con su código para poder llamarlo) y
   * vehículo del repartidor YA asignado. `null` = el proveedor todavía no asigna a nadie —
   * no es un error, es el estado normal mientras la cocina cocina.
   */
  fetchCourier?(externalOrderId: string, storeId: string): Promise<CourierInfo | null>

  publishMenu?(snapshot: MenuSnapshot, storeId: string, opts?: { availability?: unknown; precios?: unknown }): Promise<PublicacionDeMenu>

  /**
   * 🔴 `true` = el 2xx del POST del menú significa «en revisión», NO «publicado»: lo publicado lo dice un veredicto aparte
   * (un aviso de aprobado o rechazado). El sincronizador entonces NO sella la huella con el 2xx: deja el menú en revisión
   * hasta el veredicto, y mientras tanto no lo republica. Ausente = el 2xx ya es «publicado» y se sella en el acto.
   *
   * Existe para que el núcleo decida por la CAPACIDAD, nunca por el nombre del proveedor (lo vigila `adapterRegistry.test.ts`).
   */
  readonly menuConRevision?: boolean

  /** Agota o revive UN producto sin republicar el menú. La operación del día a día. */
  setItemSoldOut?(itemId: string, storeId: string, agotado: boolean): Promise<ActionResult>

  /** Pausa o reanuda la tienda: deja de recibir pedidos sin desaparecer de la app. */
  setStoreStatus?(paused: boolean, storeId: string, motivo?: string): Promise<ActionResult>

  /**
   * «Integrada sí/no»: le dice al proveedor si los pedidos de esta tienda llegan por la integración (`true`) o se atienden a
   * mano en su portal de aliados (`false`). NO pausa ni reanuda la tienda (eso es `setStoreStatus`).
   *
   * 🔴 Quien construya «desconectar» desde NUESTRO lado (el botón del dashboard, fase 3) debe llamarla con `false` DESPUÉS del
   * commit que deshabilita el vínculo. Hoy sólo se avisa `true`, al promover un vínculo a ACTIVE por el aprovisionamiento; una
   * baja que manda el proveedor NUNCA la llama. Es best-effort: devuelve `ok:false` (o lanza, p. ej. el candado de escritura) y
   * quien llama lo registra en el log y en la bitácora sin revertir ni lanzar nada.
   */
  notifyIntegrationStatus?(storeId: string, integrada: boolean): Promise<ActionResult>

  /**
   * Deja el horario regular de la TIENDA en el proveedor igual a `horario` (el neutral del núcleo). `ok` = el proveedor ya tiene
   * exactamente ese horario; sólo entonces el núcleo guarda la huella (`hoursSync.service.ts`).
   *
   * 🔴 El núcleo NUNCA la llama con una semana toda cerrada: hay proveedores que toman «sin horario» como abierta las 24 h. El
   * adaptador decide CÓMO se dice el horario (una llamada o varias, crear o actualizar); si se detiene a la mitad devuelve
   * `ok:false` (o lanza), y la siguiente pasada vuelve a partir de lo que el proveedor de verdad tenga. Una escritura que no salió
   * (el candado de tiendas, el token) lanza `DeliveryWriteNotSentError`. Ausente = el proveedor no recibe el horario de la tienda.
   */
  publishStoreHours?(horario: HorarioSemanal, storeId: string): Promise<ActionResult>

  /**
   * El menú YA TRADUCIDO al formato del proveedor, SIN publicarlo.
   *
   * Existe para que el sincronizador pueda sacarle huella y decidir si hace falta publicar,
   * sin gastar una llamada de red. Se hashea lo traducido y no el snapshot interno a
   * propósito: si mañana se arregla un bug del traductor, la huella cambia y el menú se
   * republica solo — hashear el snapshot dejaría al proveedor con el menú mal traducido
   * hasta que alguien editara un producto por casualidad.
   */
  buildMenuPayload?(snapshot: MenuSnapshot, opts?: { availability?: unknown; precios?: unknown }): unknown

  /**
   * Traduce el horario NEUTRAL del núcleo al formato del proveedor.
   *
   * Existe para que el núcleo no tenga que saber que Uber llama a esto `service_availability`
   * con `day_of_week` y `time_periods`. El núcleo resuelve QUÉ horas; el adaptador sabe CÓMO
   * se dicen.
   */
  mapHours?(horario: HorarioSemanal): unknown
  setStoreStatus?(paused: boolean, storeId: string): Promise<ActionResult>

  /**
   * 🔴 Si el proveedor sólo admite la aceptación AUTOMÁTICA de pedidos, aquí va la RAZÓN, en español y
   * lista para mostrársela a quien intente poner el modo manual. Sin esta propiedad, el proveedor
   * admite los dos modos.
   *
   * Existe para que el núcleo rechace el modo manual SIN nombrar a un proveedor: lee esta propiedad
   * del adaptador, nunca compara contra un nombre (lo vigila el guardrail de `adapterRegistry.test.ts`).
   * El caso: un proveedor cancela solo el pedido que no se acepta en pocos minutos, y un modo manual
   * (la cocina decide desde el POS) lo dejaría correr hasta que el reloj del proveedor lo cancele.
   */
  readonly soloAceptacionAutomatica?: string

  /**
   * Campos EXTRA que el listado de canales le agrega a cada vínculo de este proveedor (aditivos: nunca pisan los de
   * siempre). Recibe TODOS los vínculos del proveedor en el venue y debe resolverlos en una sola consulta.
   *
   * Existe para que el listado del núcleo no tenga que saber qué necesita cada proveedor. El caso (Rappi fase 3): cuántos
   * pedidos siguen en curso (el panel pone «Desconectar» en gris) y qué conexión está viendo el dueño (la manda de vuelta
   * al desconectar).
   */
  datosDelListado?(links: Array<{ id: string; config: unknown; externalLocationId: string }>): Promise<Map<string, Record<string, unknown>>>
}
