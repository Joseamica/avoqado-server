import { DeliveryChannelLink, OrderSource } from '@prisma/client'
import type { MenuSnapshot } from './menuSnapshot.service'

/** Estados internos que el core propaga hacia el canal (el adapter los traduce). */
export type DeliveryOrderStatus = 'ACCEPTED' | 'PREPARING' | 'READY' | 'PICKED_UP' | 'CANCELLED' | 'FAILED'

export interface NormalizedDeliveryItem {
  /** PLU = Product.sku de Avoqado (el menú lo publicamos nosotros) */
  plu: string
  name: string
  quantity: number
  /** PESOS por unidad (el adapter ya convirtió de centavos) */
  unitPrice: number
  /** Modificadores aplanados como texto (v1) + monto ya incluido en unitPrice=false → se suma */
  modifiers: Array<{ plu: string; name: string; quantity: number; unitPrice: number }>
  notes?: string
}

export interface NormalizedDeliveryOrder {
  /** ID del pedido en el proveedor — va a Order.externalId (unique por venue) */
  externalId: string
  /** Número corto para mostrar en KDS/tickets (channelOrderDisplayId) */
  displayId: string
  /** Canal real resuelto (UBER_EATS/RAPPI/DIDI_FOOD) o DELIVERY_PLATFORM */
  source: OrderSource
  items: NormalizedDeliveryItem[]
  /** PESOS. Informativo del payload del proveedor — ver nota en `total` sobre por qué NO cuadra como suma. */
  subtotal: number
  taxAmount: number
  discountAmount: number
  tipAmount: number
  serviceChargeAmount: number
  deliveryFeeAmount: number
  /**
   * PESOS. total = payment.amount del canal (lo que el cliente pagó; tax-inclusive en MX).
   * NO es una suma derivada de subtotal/tax/tip/fees — esos campos son informativos del
   * payload del proveedor y pueden no cuadrar aritméticamente contra total (ej. real:
   * 130 + 19.31 + 10 ≠ 140 en el fixture de Deliverect).
   */
  total: number
  customer?: { name?: string; phone?: string; note?: string }
  /** Payload crudo del proveedor — va a Order.posRawData */
  raw: unknown
  placedAt: Date
}

/** Contrato que TODO proveedor de delivery implementa (Deliverect hoy; DiDi/Rappi/Uber directo mañana). */
export interface DeliveryProviderAdapter {
  readonly provider: 'DELIVERECT' | 'UBER_EATS' | 'RAPPI' | 'DIDI_FOOD'
  verifySignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, link: DeliveryChannelLink): boolean
  parseOrderWebhook(rawBody: Buffer, link: DeliveryChannelLink): NormalizedDeliveryOrder
  sendStatusUpdate(link: DeliveryChannelLink, externalOrderId: string, status: DeliveryOrderStatus): Promise<void>
  pushMenu(link: DeliveryChannelLink, snapshot: MenuSnapshot): Promise<void>
  setChannelPaused(link: DeliveryChannelLink, paused: boolean): Promise<void>
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
