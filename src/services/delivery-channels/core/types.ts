import { DeliveryChannelLink, DeliveryProvider, OrderSource } from '@prisma/client'
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
export interface DirectDeliveryAdapter {
  readonly provider: DeliveryProvider

  /** ¿El mensaje es auténtico? Recibe TODOS los secretos vigentes para tolerar la rotación. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, secrets: string[]): boolean

  /** ¿De qué tienda y de qué pedido es? Cada proveedor lo pone en otro campo. */
  extractIdentity(payload: unknown): EventIdentity

  /** Del formato crudo del proveedor al contrato interno. Aquí vive TODA la diferencia. */
  normalizeOrder(raw: unknown): NormalizedDeliveryOrder

  /** Sólo si el webhook manda un PUNTERO en vez del pedido (es el caso de Uber). */
  fetchOrder?(orderId: string): Promise<unknown>

  /** Sólo si el proveedor espera que el POS conteste — y normalmente con un plazo. */
  acceptOrder?(orderId: string, storeId: string): Promise<ActionResult>
  denyOrder?(orderId: string, storeId: string, reason?: DenyReason): Promise<ActionResult>
  markReady?(orderId: string, storeId: string): Promise<ActionResult>

  publishMenu?(snapshot: MenuSnapshot, storeId: string): Promise<ActionResult>
  setStoreStatus?(paused: boolean, storeId: string): Promise<ActionResult>
}
