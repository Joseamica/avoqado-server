import { Prisma } from '@prisma/client'
import { saldoPorCobrar, type CompletedPaymentForBalance } from '../shared/orderBalance'

/**
 * 🔴 D4 (hz:72be07e6:D4): cuánto le falta cobrar a la TERMINAL en una mesa — el `amount_left` de
 * `GET /tpv/venues/:venueId/orders/:orderId`, que la TPV (todas sus versiones, desde la 2.11.1 por lo menos) usa como restante
 * de «Cobrar» (`detail.amountLeft ?: detail.total`).
 *
 * Antes era `order.total − Σ payment.amount`. Medido en la PAX el 12-nov: mesa de $50, parte 1 = $25 + $10 de propina →
 * «Restante $35», porque el cobro guarda `Order.total` CON la propina y `amount` no la trae. El cliente que paga «Cuenta
 * completa» pagaba la propina dos veces.
 *
 * Ahora es `saldoPorCobrar` (`shared/orderBalance.ts`): la MISMA respuesta que el POS (`preBillBalance`) y la misma aritmética con
 * la que el cobro cierra la cuenta. No depende de si la columna `total` trae o no la propina (cada escritor la guarda distinto:
 * tabla en `docs/audit/2026-11-13-mesa-dividida-propina/promesa.md` del workspace). Sobre eso, dos reglas de la terminal:
 *
 * - Un cobro todavía en curso (PENDING/PROCESSING, p. ej. un QR de cripto vigente) sigue apartando su importe, como antes: si
 *   no, otra terminal ofrecería cobrarlo otra vez. Uno FAILED ya no aparta nada (antes sí: la terminal pedía de menos).
 * - Una cuenta de SoftRestaurant (integrada) queda EXACTAMENTE como antes: su total y su cierre son de SoftRestaurant, no de
 *   Avoqado, y el saldo común no sabe qué trae su total.
 *
 * La forma no cambia: un número en pesos, nunca negativo (la TPV lee ≤ 0 como «no falta nada»).
 */
export type PagoParaElRestante = CompletedPaymentForBalance & {
  status: string | null
  thirdPartyCashAmount?: Prisma.Decimal | number | string | null
}

type CuentaParaElRestante = Parameters<typeof saldoPorCobrar>[0] & {
  total: Prisma.Decimal | number | string | null | undefined
  originSystem: string | null | undefined
  source: string | null | undefined
  externalId: string | null | undefined
}

/** ¿Su dinero lo lleva otro sistema? SoftRestaurant, o cualquier cuenta del POS con id externo (el criterio de «integrada» de
 * `cierreDelCobroSaldaLaCuenta`). */
export function esCuentaDeSoftRestaurant(orden: Pick<CuentaParaElRestante, 'originSystem' | 'source' | 'externalId'>): boolean {
  return orden.originSystem === 'POS_SOFTRESTAURANT' || (orden.source === 'POS' && !!orden.externalId?.trim())
}

export function restanteDeLaMesa(orden: CuentaParaElRestante, pagos: readonly PagoParaElRestante[]): number {
  if (esCuentaDeSoftRestaurant(orden)) {
    // Exactamente la fórmula de antes (también sin el piso en 0): no cambia nada para quien no es de Avoqado.
    return Number(orden.total || 0) - pagos.reduce((suma, p) => suma + Number(p.amount || 0), 0)
  }

  const completados = pagos.filter(p => p.status === 'COMPLETED')
  const saldo = saldoPorCobrar(orden, completados)

  const enCurso = pagos
    .filter(p => (p.status === 'PENDING' || p.status === 'PROCESSING') && p.type !== 'REFUND')
    .reduce((suma, p) => suma.plus(Prisma.Decimal.max(0, new Prisma.Decimal(p.amount ?? 0))), new Prisma.Decimal(0))

  const restante = saldo.minus(enCurso)
  return restante.isNegative() ? 0 : restante.toDecimalPlaces(2).toNumber()
}
