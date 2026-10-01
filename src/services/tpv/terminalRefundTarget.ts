/**
 * ¿Se puede mandar este cobro a la terminal para devolverlo?
 *
 * Decisión PURA — sin Prisma, sin red — para que la parte que decide sobre
 * dinero se pueda probar sola. Espeja el patrón de `fastPaymentTarget.ts`.
 *
 * 🔑 Esto es un PRE-VUELO, no la autorización. Quien valida de verdad —con
 * candado de fila y contra los reembolsos ya registrados— sigue siendo
 * `refund.tpv.service.ts` cuando la terminal registra la devolución. Aquí sólo
 * se evita abrirle al cajero una pantalla que no puede terminar: mandar a la
 * terminal un cobro en efectivo, uno que nunca se completó o uno ya devuelto
 * es hacerlo caminar hasta el aparato para nada.
 */

import { paymentCountsAsDrawerCash, paymentIsAvoqadoSettled } from '../shared/tenderSemantics'

/** Lo que la regla necesita del cobro original. */
export interface CobroParaDevolver {
  method: string
  source: string | null
  externalSource: string | null
  tenderSatFormaPago: string | null
  fundsFlow: string | null
  tenderTypeId: string | null
  tenderCountsAsCash: boolean | null
}

export type DevolverCon = 'CASH' | 'BANK_TRANSFER'

/** Lo único que la decisión necesita saber del cobro original. */
export interface RefundablePaymentSnapshot {
  id: string
  venueId: string
  /** TransactionStatus como string: sólo COMPLETED movió dinero. */
  status: string
  /** PaymentMethod como string. */
  method: string
  /** PaymentSource como string: `TPV` = lo cobró nuestra terminal. */
  source: string | null
  /** Monto de la venta, en PESOS (Decimal de Prisma ya convertido a número). */
  amount: number
  /** Propina, en PESOS. Es parte de lo que el cliente pagó. */
  tipAmount: number
  /** Lo ya devuelto de este cobro, en PESOS (`processorData.refundedAmount`). */
  refundedAmount: number
}

export type TerminalRefundTarget =
  | { eligible: true; remainingRefundableCents: number }
  | { eligible: false; reason: TerminalRefundRejection; message: string }

export type TerminalRefundRejection = 'NOT_FOUND' | 'WRONG_VENUE' | 'NOT_COMPLETED' | 'NOT_A_CARD_PAYMENT' | 'ALREADY_REFUNDED'

const CARD_METHODS = new Set(['CREDIT_CARD', 'DEBIT_CARD'])

/** Métodos que sólo existen por un procesador (o no son pesos): nunca se devuelven por otro medio. */
const METODOS_DE_PROCESADOR = new Set(['DIGITAL_WALLET', 'CRYPTOCURRENCY'])

/** Formas de pago SAT que son tarjeta: 04 crédito, 28 débito. */
const FORMAS_SAT_DE_TARJETA = new Set(['04', '28'])

/**
 * ¿Este cobro se devuelve en la terminal? Sólo si fue con tarjeta presente en NUESTRA terminal.
 *
 * 🔴 Regla del founder (30-sep-2026): todo lo demás —transferencia, tipos de pago que crea el
 * negocio, «Tarjeta (terminal externa)», una «Tarjeta de crédito» registrada a mano, historial
 * importado— se reembolsa como el efectivo: aquí se registra y el dinero se entrega por fuera.
 * El `method` solo no basta: en prod hay CREDIT_CARD con `source` APP/POS/OTHER que la terminal
 * nunca cobró. La app lee este mismo veredicto (`refundOnTerminal` del detalle del cobro).
 */
export function seDevuelveEnTerminal(payment: { method: string; source: string | null }): boolean {
  return CARD_METHODS.has(payment.method) && payment.source === 'TPV'
}

/**
 * Pesos → centavos sin arrastrar el error de punto flotante.
 * Redondear CADA monto antes de restar evita que `0.1 + 0.2` se convierta en
 * 30.000000000000004 centavos y viaje un centavo fantasma a la terminal.
 */
function toCents(pesos: number): number {
  return Math.round((Number.isFinite(pesos) ? pesos : 0) * 100)
}

export function resolveTerminalRefundTarget(payment: RefundablePaymentSnapshot | null, venueId: string): TerminalRefundTarget {
  if (!payment) {
    return { eligible: false, reason: 'NOT_FOUND', message: 'No se encontró el cobro que quieres reembolsar.' }
  }

  // Aislamiento por tenant antes que nada: nunca se abre en una terminal el
  // cobro de otro negocio, aunque quien pregunta tenga el id.
  if (payment.venueId !== venueId) {
    return { eligible: false, reason: 'WRONG_VENUE', message: 'Ese cobro no pertenece a este establecimiento.' }
  }

  if (payment.status !== 'COMPLETED') {
    return {
      eligible: false,
      reason: 'NOT_COMPLETED',
      message: 'Ese cobro no está completado, así que no hay nada que devolver por la terminal.',
    }
  }

  if (!seDevuelveEnTerminal(payment)) {
    return {
      eligible: false,
      reason: 'NOT_A_CARD_PAYMENT',
      message: 'La terminal sólo puede devolver cobros con tarjeta hechos en la terminal.',
    }
  }

  // La propina es parte de lo que el cliente pagó: si se devuelve la venta, se
  // devuelve el total que aceptó en la pantalla de la terminal.
  const remainingRefundableCents = toCents(payment.amount) + toCents(payment.tipAmount) - toCents(payment.refundedAmount)

  if (remainingRefundableCents <= 0) {
    return { eligible: false, reason: 'ALREADY_REFUNDED', message: 'Ese cobro ya se devolvió completo.' }
  }

  return { eligible: true, remainingRefundableCents }
}

/**
 * ¿El cajero puede escoger con qué devuelve el dinero (efectivo de la caja o transferencia)?
 *
 * 🔴 Regla del founder (30-sep-2026): sí en todo lo que no fue tarjeta. Nunca en una tarjeta —de nuestra
 * terminal, de otra o registrada a mano—: el mercado entero la devuelve sólo a la tarjeta y Clip lo prohíbe
 * por contrato. Tampoco en lo que liquida un procesador por nosotros (`paymentIsAvoqadoSettled`): devolverlo en
 * efectivo registraría una devolución de comisión que el procesador nunca hizo. Ni en un pedido de plataforma
 * de reparto: ese dinero nunca estuvo en el local.
 *
 * Fila SIN `fundsFlow` (anterior al sello, o del cobro rápido, que no lo estampa sin tipo del catálogo): el fallback
 * de `paymentIsAvoqadoSettled` la cuenta como de Avoqado sólo porque no es efectivo, y eso es falso en el mostrador
 * (QA en la CPad, 1-oct: la «Transferencia» de fábrica quedaba sin «Devolver con»). Aquí sólo es de procesador lo que
 * entró EN LÍNEA. No cambia el saldo: el reembolso escribe su `VenueTransaction` y su costo igual con cualquier método.
 */
const CANALES_EN_LINEA = new Set(['WEB', 'QR', 'SDK', 'DASHBOARD_TEST'])

export function sePuedeEscogerComoDevolver(payment: CobroParaDevolver): boolean {
  if (CARD_METHODS.has(payment.method) || METODOS_DE_PROCESADOR.has(payment.method)) return false
  if (payment.tenderSatFormaPago && FORMAS_SAT_DE_TARJETA.has(payment.tenderSatFormaPago)) return false
  if (/^tarjeta/i.test(payment.externalSource ?? '')) return false
  if (payment.source === 'DELIVERY_PLATFORM') return false
  if (payment.fundsFlow == null) return !CANALES_EN_LINEA.has(payment.source ?? '')
  return !paymentIsAvoqadoSettled(payment)
}

/**
 * Lo escogido, normalizado: `undefined` = «por el mismo medio» (el reembolso hereda todo, como siempre).
 * Igual al método del cobro, o efectivo sobre algo que YA entra al cajón (un vale), es el mismo medio.
 * NO valida si se puede escoger: eso lo hace quien llama con `sePuedeEscogerComoDevolver`.
 */
export function devolverConEfectivo(original: CobroParaDevolver, refundMethod: DevolverCon | undefined): DevolverCon | undefined {
  if (!refundMethod || refundMethod === original.method) return undefined
  if (refundMethod === 'CASH' && paymentCountsAsDrawerCash(original)) return undefined
  return refundMethod
}
