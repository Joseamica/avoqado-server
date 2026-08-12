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

/** Lo único que la decisión necesita saber del cobro original. */
export interface RefundablePaymentSnapshot {
  id: string
  venueId: string
  /** TransactionStatus como string: sólo COMPLETED movió dinero. */
  status: string
  /** PaymentMethod como string. */
  method: string
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

/** Los únicos métodos que una terminal sabe devolver: los que cobró con tarjeta. */
const CARD_METHODS = new Set(['CREDIT_CARD', 'DEBIT_CARD'])

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

  if (!CARD_METHODS.has(payment.method)) {
    return { eligible: false, reason: 'NOT_A_CARD_PAYMENT', message: 'La terminal sólo puede devolver cobros con tarjeta.' }
  }

  // La propina es parte de lo que el cliente pagó: si se devuelve la venta, se
  // devuelve el total que aceptó en la pantalla de la terminal.
  const remainingRefundableCents = toCents(payment.amount) + toCents(payment.tipAmount) - toCents(payment.refundedAmount)

  if (remainingRefundableCents <= 0) {
    return { eligible: false, reason: 'ALREADY_REFUNDED', message: 'Ese cobro ya se devolvió completo.' }
  }

  return { eligible: true, remainingRefundableCents }
}
