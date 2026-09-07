import {
  computeOrderBalance,
  isRefundPayment,
  FULL_PAYMENT_TOLERANCE,
  type CompletedPaymentForBalance,
  type OrderAmountsForBalance,
} from './orderBalance'

/**
 * Un toque repetido en «Efectivo» sobre una orden que YA quedó cubierta.
 *
 * Nació de SN00396 (BAE MEZQUITAL, 2026-09-04): 5 cobros COMPLETED de $0 en 1.7 s desde la
 * misma PAX, referencias distintas y sin llave de idempotencia. La defensa por
 * `referenceNumber` no lo ve (la referencia se acuña por toque) y la de `idempotencyKey`
 * tampoco (llegó vacía). Esta regla mira el ESTADO de la orden, no las credenciales del cobro.
 *
 * 🔴 Sólo EFECTIVO. Una tarjeta que llega a registrarse YA se cobró en el banco: rechazarla o
 * deduplicarla deja «dinero movido sin registro», que es el peor desenlace. Eso lo vigila el
 * watchdog de sobrepago, no este candado.
 * 🔴 Sólo si ya existe un cobro previo. Una orden de $0 (cortesía, línea gratis de
 * PlayTelecom) está «saldada» desde antes del primer cobro; sin esta condición el PRIMER cobro
 * de cada línea gratis se perdería, y de ese cobro nace la SaleVerification que Walmart paga.
 * 🔴 Los reembolsos REABREN la puerta: tras devolver, volver a cobrar es legítimo.
 *
 * ── El saldo de ESTA regla no es `isFullyPaid` ─────────────────────────────────────────
 * `computeOrderBalance` implementa la decisión del founder (2026-08-18) de que **un reembolso
 * NO reabre saldo**: una venta de $100 cobrada y devuelta entera sigue diciendo `isFullyPaid`.
 * Para el corte y el CFDI eso es lo correcto; para este candado sería lo contrario de lo que
 * hace falta, porque convertiría un cobro legítimo posterior a la devolución en un «toque
 * repetido» y lo tiraría en silencio. Así que aquí se usa la fórmula del diagnóstico —
 * `total − cobrado + reembolsado ≤ 0.01`— reusando las piezas ya calculadas de
 * `computeOrderBalance` (nada de reimplementar la aritmética). Un reembolso PARCIAL también
 * abre la puerta: el lado seguro del dinero es no deduplicar de más.
 *
 * 🔑 Quien lea los pagos de la base DEBE seleccionar `type`: sin él un reembolso es
 * indistinguible de un cobro negativo.
 */
export interface CobroCandidato {
  method: string | null | undefined
  status: string | null | undefined
  hasAreaTicketLines: boolean
}

export interface PagoPrevio extends CompletedPaymentForBalance {
  id: string
  method?: string | null
  createdAt?: Date
}

/**
 * ¿Este cobro entrante puede llegar a ser un toque repetido? Es la MISMA condición que
 * `cobroEnEfectivoSobreOrdenSaldada` aplica primero, expuesta aparte para que quien la llama
 * pueda ahorrarse la consulta de los pagos previos cuando la respuesta ya es «no» — en un
 * camino de dinero que la TPV abandona a los 10 s, una consulta de más dentro de la
 * transacción es exactamente lo que produce el reintento que estamos evitando.
 *
 * 🔑 Vive AQUÍ y no en el llamador para que no existan dos definiciones del candado.
 */
export function aplicaCandadoDeEfectivo(candidato: CobroCandidato): boolean {
  if (candidato.method !== 'CASH') return false
  if (candidato.status !== 'COMPLETED') return false
  if (candidato.hasAreaTicketLines) return false
  return true
}

export function cobroEnEfectivoSobreOrdenSaldada(
  candidato: CobroCandidato,
  order: OrderAmountsForBalance,
  pagosCompletados: readonly PagoPrevio[],
): PagoPrevio | null {
  if (!aplicaCandadoDeEfectivo(candidato)) return null

  const cobros = pagosCompletados.filter(p => !isRefundPayment(p))
  if (cobros.length === 0) return null

  const saldo = computeOrderBalance(order, pagosCompletados)
  // `remainingBalance` viene clampado a 0 (un sobrepago no deja saldo negativo), así que el
  // faltante se recalcula desde `total` y `paidAmount` y se le SUMA lo devuelto.
  const restante = saldo.total.minus(saldo.paidAmount).plus(saldo.refundedAmount)
  if (restante.greaterThan(FULL_PAYMENT_TOLERANCE)) return null

  const masReciente = (a: PagoPrevio, b: PagoPrevio) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
  const enEfectivo = cobros.filter(p => p.method === 'CASH').sort(masReciente)
  return enEfectivo[0] ?? [...cobros].sort(masReciente)[0]
}
