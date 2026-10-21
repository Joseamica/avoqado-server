// src/services/exchanges/exchangePredicates.ts
/**
 * Predicados y catálogos PUROS del cambio de producto, sin un solo import (como `giftCardPredicados.ts`): los pueden usar módulos
 * que no deben cargar Prisma al cargarse (lo vigila `tests/unit/architecture/grafoDeImports.guard.test.ts`). No importes nada aquí.
 */

/** Un importe en centavos es un entero seguro y no negativo; otra cosa es un error de quien llama, no un caso de negocio. */
export function assertCents(what: string, cents: number): void {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error(`EXCHANGE_INVALID_CENTS: ${what} debe ser un entero de centavos ≥ 0 (llegó ${cents})`)
  }
}

/** ¿El tender es el de sistema «Crédito de cambio» (`systemKind = EXCHANGE_CREDIT`)? Se pregunta por el kind EXACTO. */
export function isExchangeCreditTenderKind(systemKind: string | null | undefined): boolean {
  return systemKind === 'EXCHANGE_CREDIT'
}

/** Motivo obligatorio por pieza que regresa (spec §4): Talla · Gusto · Defecto. */
export const EXCHANGE_REASONS = ['SIZE', 'TASTE', 'DEFECT'] as const
export type ExchangeReason = (typeof EXCHANGE_REASONS)[number]

/**
 * Sólo se cambia mercancía (spec §5.2): el núcleo de reembolsos no deshace citas ni boletos. Además de citas, clases, eventos y
 * productos digitales, tampoco una donación ni el legado `SERVICE`: ninguno es una pieza que regrese a la tienda.
 */
export const NON_MERCHANDISE_PRODUCT_TYPES: ReadonlySet<string> = new Set([
  'APPOINTMENTS_SERVICE',
  'CLASS',
  'EVENT',
  'DIGITAL',
  'DONATION',
  'SERVICE',
])

/** Orígenes de pedidos de plataforma: esos se cambian en la plataforma (spec §5.1). */
export const DELIVERY_PLATFORM_ORDER_SOURCES: ReadonlySet<string> = new Set(['UBER_EATS', 'RAPPI', 'DIDI_FOOD', 'DELIVERY_PLATFORM'])

/** Por qué un renglón (o la venta entera) no se puede cambiar; cada motivo tiene su texto para la cajera. */
export type LineBlockReason =
  | 'ALREADY_RETURNED'
  | 'PROMOTION_PARTIAL'
  | 'NOT_MERCHANDISE'
  | 'GIFT_CARD_SALE'
  | 'DELIVERY_PLATFORM'
  | 'NOT_ATTRIBUTABLE'
  | 'SOLD_BY_WEIGHT'
  | 'NOT_PAID'
  | 'NOTHING_LEFT_TO_REFUND'
  | 'SERIALIZED_ITEM'
