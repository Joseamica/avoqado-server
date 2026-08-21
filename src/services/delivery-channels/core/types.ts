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
}

/**
 * Reparto explícito de quién cobra qué. Lo entrega el ADAPTADOR; el core NO deduce nada.
 * Invariantes (verificadas por `assertDeliveryMoneyInvariants` en `core/money.ts`):
 *   saleAmount + merchantFees === externallyPaidSale + cashDueSale
 *   tipAmount                 === externallyPaidTip  + cashDueTip
 *
 * 🔴 Dinero en STRING DECIMAL, nunca `number` (`.claude/rules/critical-warnings.md`).
 */
export interface NormalizedDeliveryPayment {
  currency: 'MXN'
  /** artículos, IVA incluido (México) */
  saleAmount: string
  /** cargos cobrados al cliente que se pagan AL COMERCIO (bolsa, envío propio…) */
  merchantFees: string
  tipAmount: string
  /** parte de (saleAmount + merchantFees) que la plataforma liquida al comercio */
  externallyPaidSale: string
  externallyPaidTip: string
  /** parte que el comercio cobra en efectivo en persona */
  cashDueSale: string
  cashDueTip: string
}

export interface NormalizedDeliveryOrder {
  /** id del pedido en el proveedor. Se namespacea al guardarlo: `{PROVIDER}:{externalId}` */
  externalId: string
  /** número corto que ve el repartidor y va en el ticket */
  displayId: string
  source: OrderSource
  items: NormalizedDeliveryItem[]
  payment: NormalizedDeliveryPayment
  customer?: { name?: string; phone?: string; note?: string }
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

export type DenyReason = 'OUT_OF_ITEMS' | 'STORE_CLOSED' | 'TOO_BUSY' | 'OTHER'

export interface ActionResult {
  ok: boolean
  status: number
  /** Cuerpo crudo — se guarda para auditoría cuando falla. */
  raw: string
}

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
  fetchOrder?(orderId: string): Promise<unknown>

  /** Sólo si el proveedor espera que el POS conteste — y normalmente con un plazo. */
  acceptOrder?(orderId: string, storeId: string): Promise<ActionResult>
  denyOrder?(orderId: string, storeId: string, reason?: DenyReason): Promise<ActionResult>
  markReady?(orderId: string, storeId: string): Promise<ActionResult>

  publishMenu?(snapshot: MenuSnapshot, storeId: string, opts?: { availability?: unknown; precios?: unknown }): Promise<ActionResult>

  /** Agota o revive UN producto sin republicar el menú. La operación del día a día. */
  setItemSoldOut?(itemId: string, storeId: string, agotado: boolean): Promise<ActionResult>

  /** Pausa o reanuda la tienda: deja de recibir pedidos sin desaparecer de la app. */
  setStoreStatus?(paused: boolean, storeId: string, motivo?: string): Promise<ActionResult>

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
}
