import { Prisma } from '@prisma/client'
import {
  computeStoredOrderTotal,
  summarizeRefunds,
  type CompletedPaymentForBalance,
  type StoredOrderTotalAmounts,
} from '../shared/orderBalance'

/**
 * 🔴 D4 (hz:72be07e6:D4, 13-nov): cuánto le falta cobrar a la TERMINAL en una mesa — el `amount_left` de
 * `GET /tpv/venues/:venueId/orders/:orderId`, que la TPV (también las versiones viejas) usa como restante de «Cobrar».
 *
 * Antes era `order.total − Σ payment.amount`. Medido en la PAX el 12-nov: mesa de $50, parte 1 = $25 + $10 de propina →
 * «Restante $35», porque los cobros guardan `Order.total` CON la propina cobrada y `amount` no la trae.
 *
 * Por qué no basta con restar la propina, ni con recalcular el total con la regla común (Codex r1 y r2):
 * - `Order.total` no tiene un solo escritor. Los cobros (`recordOrderPayment`, `payCashOrder`, la devolución que reabre de D19)
 *   lo guardan CON las propinas cobradas (`computeStoredOrderTotal`); agregar o quitar productos lo reescribe SIN propina; la
 *   ingesta de Deliverect lo guarda sin propina y CON comisiones del canal que no viven en ninguna otra columna. Restar la
 *   propina siempre cobraba de menos tras agregar una ronda; recalcular el total perdía el envío de Deliverect.
 * - Por eso la columna manda, y la propina cobrada sólo se descuenta si la columna la trae: es decir, si coincide al centavo con
 *   el total de la regla común CON esas propinas. Si no coincide, la columna no la trae y no se le resta.
 *
 * Lo cobrado es la regla común (`summarizeRefunds` de los COMPLETED): un reembolso no reabre la venta (founder, 18-ago) salvo lo
 * que D19 marcó como reabierto. Un intento todavía en curso (PENDING/PROCESSING, p. ej. un QR de cripto vigente) sigue apartando
 * su importe, como antes: si no, otra terminal ofrecería cobrarlo otra vez (Codex r2 #2). Uno FAILED ya no aparta nada.
 * Nunca negativo: la TPV lee ≤ 0 como «no falta nada».
 */
export type PagoParaElRestante = CompletedPaymentForBalance & { status: string | null }

export function restanteDeLaMesa(
  orden: Omit<StoredOrderTotalAmounts, 'tipAmount'> & { total: Prisma.Decimal | number | string | null | undefined },
  pagos: readonly PagoParaElRestante[],
): number {
  const completados = pagos.filter(p => p.status === 'COMPLETED')
  const cobrado = summarizeRefunds(completados)

  const totalGuardado = new Prisma.Decimal(orden.total ?? 0)
  const totalConPropinas = computeStoredOrderTotal({
    subtotal: orden.subtotal,
    discountAmount: orden.discountAmount,
    serviceChargeAmount: orden.serviceChargeAmount,
    contratoDePrecio: orden.contratoDePrecio,
    taxAmount: orden.taxAmount,
    status: orden.status,
    tipAmount: cobrado.netTipAmount,
  })
  const elTotalTraeLasPropinas = totalGuardado.toDecimalPlaces(2).equals(totalConPropinas.toDecimalPlaces(2))

  // Lo cobrado SIN propina se resta siempre; la propina, sólo si el total la trae.
  const cobradoQueResta = elTotalTraeLasPropinas ? cobrado.netPaidAmount : cobrado.netPaidAmount.minus(cobrado.netTipAmount)

  const enCurso = pagos
    .filter(p => (p.status === 'PENDING' || p.status === 'PROCESSING') && p.type !== 'REFUND')
    .reduce((suma, p) => suma.plus(Prisma.Decimal.max(0, new Prisma.Decimal(p.amount ?? 0))), new Prisma.Decimal(0))

  const restante = totalGuardado.minus(cobradoQueResta).minus(enCurso)
  return restante.isNegative() ? 0 : restante.toDecimalPlaces(2).toNumber()
}
