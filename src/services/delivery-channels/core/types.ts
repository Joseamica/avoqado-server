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

export interface ProviderContext {
  link: DeliveryChannelLink
  /** Rappi resuelve dominio por país; el core NUNCA arma URLs. */
  countryCode?: string
}

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
 * Contrato que TODO proveedor de delivery implementa (Deliverect hoy; DiDi/Rappi/Uber
 * directo mañana). Los primeros cinco métodos son los que `deliverect.adapter.ts` ya
 * implementa y `statusDispatcher.service.ts`/`deliveryChannelLink.service.ts` consumen
 * hoy en producción — se conservan intactos. Las capacidades nuevas de abajo son
 * OPCIONALES a propósito: ningún adapter las implementa todavía (existen para que un
 * proveedor futuro las adopte sin otra ronda de ampliar este contrato).
 */
export interface DeliveryProviderAdapter {
  readonly provider: DeliveryProvider
  verifySignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, link: DeliveryChannelLink): boolean
  parseOrderWebhook(rawBody: Buffer, link: DeliveryChannelLink): NormalizedDeliveryOrder
  sendStatusUpdate(link: DeliveryChannelLink, externalOrderId: string, status: DeliveryOrderStatus): Promise<void>
  pushMenu(link: DeliveryChannelLink, snapshot: MenuSnapshot): Promise<void>
  setChannelPaused(link: DeliveryChannelLink, paused: boolean): Promise<void>

  /** Sólo si el webhook manda un puntero y hay que ir por el pedido. */
  fetchOrder?(orderId: string, ctx: ProviderContext): Promise<unknown>

  verifyWebhook?(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, secrets: string[]): WebhookVerdict
  extractIdentity?(payload: unknown): EventIdentity
  normalizeOrder?(raw: unknown, ctx: ProviderContext): NormalizedDeliveryOrder
  acceptOrder?(orderId: string, ctx: ProviderContext): Promise<ActionResult>
  denyOrder?(orderId: string, reason: DenyReason, ctx: ProviderContext): Promise<ActionResult>
  markReady?(orderId: string, ctx: ProviderContext): Promise<ActionResult>
  publishMenu?(snapshot: MenuSnapshot, ctx: ProviderContext): Promise<ActionResult>
  setStoreStatus?(paused: boolean, ctx: ProviderContext): Promise<ActionResult>
}
