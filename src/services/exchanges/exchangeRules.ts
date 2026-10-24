/**
 * Reglas PURAS del cambio de producto (spec `docs/superpowers/specs/2026-10-20-cambio-de-producto-design.md` §4, §5.1, §5.2 y
 * §6.3): si el cambio está prendido, qué renglón y qué venta se pueden cambiar, por qué medios se devuelve lo de cada cobro y de
 * qué cobro sale cada peso cuando la venta tiene varios. Sin Prisma ni red: quien llama trae los datos y aplica el veredicto.
 */
import type { VenueType } from '@prisma/client'
import { centavosYaDevueltos, centavosDevueltosPorComponente, type FilaDeReembolso } from '../shared/devueltoDeUnCobro'
import { categoryOfVenueType } from '../../utils/venueTypeCategory'
import { isGiftCardTenderKind } from '../giftCards/giftCardPredicados'
import { claseDeEstado, esVentaCerrada } from '../shared/orderBalance'
import { paymentCountsAsDrawerCash } from '../shared/tenderSemantics'
import { seDevuelveEnTerminal, sePuedeEscogerComoDevolver } from '../tpv/terminalRefundTarget'
import {
  assertCents,
  DELIVERY_PLATFORM_ORDER_SOURCES,
  isExchangeCreditTenderKind,
  NON_MERCHANDISE_PRODUCT_TYPES,
  type LineBlockReason,
} from './exchangePredicates'

/**
 * El interruptor que de verdad rige (spec §4): el ajuste de la sucursal si lo hay; si es nulo, el default por giro, prendido en
 * tiendas, belleza y servicios (`RETAIL` y `SERVICES`) y apagado en restaurantes, bares, hoteles y entretenimiento. Un giro
 * desconocido queda apagado.
 */
export function effectiveExchangesEnabled(setting: boolean | null | undefined, venueType: string | null | undefined): boolean {
  if (setting != null) return setting
  if (!venueType) return false
  const category = categoryOfVenueType(venueType as VenueType)
  return category === 'RETAIL' || category === 'SERVICES'
}

/**
 * Por qué un renglón de la venta original no se puede cambiar, o null (spec §5.2). Primero lo que el renglón ES y al final lo que
 * le queda. El serializado va ANTES que «sin producto»: un renglón lleva producto O pieza con número de serie, nunca los dos, y
 * una pieza así (un SIM) tiene identidad propia: no se cambia.
 */
export function lineBlockReason(line: {
  productId: string | null
  productType: string | null
  giftCardId: string | null
  soldByWeight: boolean
  remainingQtyOrder: number
  serialized: boolean
}): LineBlockReason | null {
  if (line.giftCardId != null) return 'GIFT_CARD_SALE'
  if (line.serialized) return 'SERIALIZED_ITEM'
  if (line.productId == null) return 'NOT_MERCHANDISE'
  if (line.productType != null && NON_MERCHANDISE_PRODUCT_TYPES.has(line.productType)) return 'NOT_MERCHANDISE'
  if (line.soldByWeight) return 'SOLD_BY_WEIGHT'
  if (line.remainingQtyOrder <= 0) return 'ALREADY_RETURNED'
  return null
}

/**
 * Por qué la venta entera no se puede cambiar, o null (spec §5.1). Un pedido de plataforma se cambia en la plataforma. Sólo una
 * venta cobrada (PAID o REFUNDED: `esVentaCerrada`) y viva se cambia; si ya se devolvió todo, lo dicen sus renglones.
 */
export function saleBlockReason(sale: {
  source: string
  status: string
  paymentStatus: string
  paymentSources: string[]
}): 'DELIVERY_PLATFORM' | 'NOT_PAID' | null {
  if (DELIVERY_PLATFORM_ORDER_SOURCES.has(sale.source) || sale.paymentSources.includes('DELIVERY_PLATFORM')) return 'DELIVERY_PLATFORM'
  if (claseDeEstado(sale.status) === 'CANCELADA' || !esVentaCerrada(sale.paymentStatus)) return 'NOT_PAID'
  return null
}

/** Por dónde se le devuelve a la clienta la diferencia a su favor (spec §6.3). La tarjeta no está aquí: va por la terminal (§6.5). */
export type PayoutMethod = 'CASH' | 'BANK_TRANSFER' | 'GIFT_CARD_BALANCE'

/** El historial sin reparto comprobable no aporta capacidad; el escritor repite la regla bajo su candado. */
export function effectiveExchangeCapacity(payment: {
  amountCents: number
  tipCents: number
  processorData: unknown
  refunds: readonly FilaDeReembolso[]
}): number {
  const totalRefunded = centavosYaDevueltos({ processorData: payment.processorData, filas: payment.refunds })
  const { salesCents, tipCents } = centavosDevueltosPorComponente(payment.refunds)
  if (totalRefunded > salesCents + tipCents) return 0
  return Math.max(0, Math.min(payment.amountCents - salesCents, payment.amountCents + payment.tipCents - totalRefunded))
}
/** `SAME` = por el mismo medio del cobro; `CHOSEN` = «Devolver con» otro medio que el cobro admite. */
export type PayoutMode = 'SAME' | 'CHOSEN'
/** Por qué medios se devuelve lo de un cobro, y en qué modo. */
export type PayoutModes = Partial<Record<PayoutMethod, PayoutMode>>

const PAYOUT_METHODS: readonly PayoutMethod[] = ['CASH', 'BANK_TRANSFER', 'GIFT_CARD_BALANCE']

/** Lo que las reglas de devolución necesitan del cobro (incluye todo `CobroParaDevolver`). */
export interface MoneyShape {
  method: string
  source: string | null
  externalSource: string | null
  fundsFlow: string | null
  tenderTypeId: string | null
  tenderCountsAsCash: boolean | null
  tenderSatFormaPago: string | null
  tenderSystemKind: string | null
}

/**
 * Por qué medios se puede devolver lo de un cobro que NO es «Crédito de cambio» (spec §6.1: «lo que sale de la tienda sale por
 * donde entró»; §6.3). Un crédito de cambio no escoge nada por sí mismo (por eso da `{}`): los modos de un cobro pagado con
 * crédito salen de `modesForExchangeCreditRoot(raíz)`, nunca de `payoutModesFor(raíz)`.
 */
export function payoutModesFor(payment: MoneyShape): PayoutModes {
  if (isExchangeCreditTenderKind(payment.tenderSystemKind)) return {}
  if (isGiftCardTenderKind(payment.tenderSystemKind)) return { GIFT_CARD_BALANCE: 'SAME' }
  if (seDevuelveEnTerminal(payment)) return {}
  const choosable = sePuedeEscogerComoDevolver(payment)
  if (paymentCountsAsDrawerCash(payment)) return choosable ? { CASH: 'SAME', BANK_TRANSFER: 'CHOSEN' } : { CASH: 'SAME' }
  if (payment.method === 'BANK_TRANSFER') return choosable ? { BANK_TRANSFER: 'SAME', CASH: 'CHOSEN' } : { BANK_TRANSFER: 'SAME' }
  return choosable ? { CASH: 'CHOSEN', BANK_TRANSFER: 'CHOSEN' } : {}
}

/**
 * Los modos de un cobro pagado con «Crédito de cambio», a partir de su cobro RAÍZ (spec §6.7): lo pagado con crédito sale SÓLO
 * por el método de la raíz, por Reembolso o por otro Cambio. Quedan sólo las entradas SAME de la raíz, nunca «Devolver con». Una
 * raíz pagada con saldo de tarjeta de regalo da `{}`: esa cadena todavía no se abre.
 */
export function modesForExchangeCreditRoot(root: MoneyShape): PayoutModes {
  if (isGiftCardTenderKind(root.tenderSystemKind)) return {}
  const modes = payoutModesFor(root)
  const same: PayoutModes = {}
  for (const method of PAYOUT_METHODS) if (modes[method] === 'SAME') same[method] = 'SAME'
  return same
}

/** Un cobro de la venta original: lo que le queda por devolver de la venta (sin propina) y sus medios de devolución. */
export interface PaymentCapacity {
  paymentId: string
  saleRemainingCents: number
  modes: PayoutModes
}
/**
 * Lo más que se puede devolver por un medio. `maxSameCents` es la parte que sale por el MISMO medio, sin «Devolver con»: una
 * diferencia en efectivo de hasta ese monto no pide `payments:refund-to-cash` y una mayor sí. `needsRefundToCash`: alguna parte
 * del máximo sale de un cobro CHOSEN con CASH.
 */
export interface PayoutOption {
  method: PayoutMethod
  maxCents: number
  maxSameCents: number
  needsRefundToCash: boolean
}
/** Un pedazo del cambio: `PAYOUT` es diferencia que sale de la tienda; `CREDIT` es crédito para la venta nueva (no mueve dinero). */
export interface AllocationSlice {
  paymentId: string
  cents: number
  role: 'PAYOUT' | 'CREDIT'
  mode: PayoutMode | null
}
export type AllocationResult =
  | { ok: true; slices: AllocationSlice[]; needsRefundToCash: boolean }
  | { ok: false; reason: 'INSUFFICIENT_FOR_METHOD' | 'NOTHING_LEFT_TO_REFUND'; payoutOptions: PayoutOption[] }

/** Lo que le queda a un cobro, nunca negativo: uno devuelto de más (dato viejo) no presta nada. */
function remainingOf(capacity: PaymentCapacity): number {
  const cents = Math.max(0, capacity.saleRemainingCents)
  assertCents(`saleRemainingCents de ${capacity.paymentId}`, cents)
  return cents
}

/** Lo más que se puede devolver por cada medio, sumando los cobros que lo admiten; los medios en cero no se ofrecen. */
export function payoutOptionsOf(capacities: PaymentCapacity[]): PayoutOption[] {
  return PAYOUT_METHODS.flatMap(method => {
    const from = capacities.filter(c => c.modes[method] && remainingOf(c) > 0)
    const maxCents = from.reduce((sum, c) => sum + remainingOf(c), 0)
    if (maxCents === 0) return []
    const maxSameCents = from.filter(c => c.modes[method] === 'SAME').reduce((sum, c) => sum + remainingOf(c), 0)
    return [{ method, maxCents, maxSameCents, needsRefundToCash: method === 'CASH' && maxCents > maxSameCents }]
  })
}

/**
 * De qué cobro sale cada peso (spec §6.3). Ningún cobro da más de lo que le queda. La diferencia `payout` sale primero de
 * los cobros que la devuelven por el MISMO medio y luego de los que admiten «Devolver con», cada grupo en el orden de entrada
 * (quien llama pone primero el cobro desde el que se abrió). Después el crédito, con lo que le quede a cada cobro, también en el
 * orden de entrada: tarjeta incluida, porque no mueve dinero. Si diferencia + crédito pasan de lo que le queda a la venta:
 * `NOTHING_LEFT_TO_REFUND`; si sólo la diferencia no cabe en ese medio: `INSUFFICIENT_FOR_METHOD` con el máximo por medio.
 * Repartir así nunca rechaza algo que cabe: el crédito acepta cualquier cobro.
 */
export function allocateAcrossPayments(
  capacities: PaymentCapacity[],
  creditCents: number,
  payout: { method: PayoutMethod; cents: number } | null,
): AllocationResult {
  assertCents('creditCents', creditCents)
  if (payout) assertCents('payout.cents', payout.cents)
  const left = capacities.map(remainingOf)
  if (creditCents + (payout?.cents ?? 0) > left.reduce((sum, cents) => sum + cents, 0)) {
    return { ok: false, reason: 'NOTHING_LEFT_TO_REFUND', payoutOptions: payoutOptionsOf(capacities) }
  }
  const slices: AllocationSlice[] = []
  // Toma de un cobro hasta `cents` y devuelve cuánto tomó.
  const take = (i: number, cents: number, role: AllocationSlice['role'], mode: PayoutMode | null): number => {
    const taken = Math.min(left[i], cents)
    if (taken > 0) {
      left[i] -= taken
      slices.push({ paymentId: capacities[i].paymentId, cents: taken, role, mode })
    }
    return taken
  }
  if (payout) {
    let owed = payout.cents
    for (const mode of ['SAME', 'CHOSEN'] as const) {
      capacities.forEach((c, i) => {
        if (c.modes[payout.method] === mode) owed -= take(i, owed, 'PAYOUT', mode)
      })
    }
    if (owed > 0) return { ok: false, reason: 'INSUFFICIENT_FOR_METHOD', payoutOptions: payoutOptionsOf(capacities) }
  }
  let credit = creditCents
  capacities.forEach((_, i) => {
    credit -= take(i, credit, 'CREDIT', null)
  })
  const choseOther = slices.some(s => s.role === 'PAYOUT' && s.mode === 'CHOSEN')
  return { ok: true, slices, needsRefundToCash: payout?.method === 'CASH' && choseOther }
}
