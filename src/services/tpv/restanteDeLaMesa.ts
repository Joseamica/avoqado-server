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
 * - Por eso la columna manda, y la propina cobrada sólo se descuenta cuando es SEGURO que la columna la trae: el total coincide
 *   al centavo con la regla común CON las propinas cobradas y `Order.tipAmount` es exactamente esas propinas (así escriben los
 *   cobros y D19), y la cuenta nació en Avoqado. Si no, se calcula como antes (sin restar propina): la garantía es «arreglado cuando es seguro, igual que
 *   antes cuando no». Una cuenta con un abono cripto (B4Bit no reescribe `total` ni `tipAmount`) queda como antes, y también
 *   una venta cancelada y cerrada con IVA aparte que recibe una propina sola (Codex r3 #1).
 *   Los arregla que todos los escritores de `Order.total` lo guarden igual (anotado en el pizarrón).
 *
 * Lo cobrado es la regla común (`summarizeRefunds` de los COMPLETED): un reembolso no reabre la venta (founder, 18-ago) salvo lo
 * que D19 marcó como reabierto. Un intento todavía en curso (PENDING/PROCESSING, p. ej. un QR de cripto vigente) sigue apartando
 * su importe, como antes: si no, otra terminal ofrecería cobrarlo otra vez (Codex r2 #2). Uno FAILED ya no aparta nada.
 * Nunca negativo: la TPV lee ≤ 0 como «no falta nada».
 */
export type PagoParaElRestante = CompletedPaymentForBalance & {
  status: string | null
  /** Para reconocer un abono cripto (B4Bit), que guarda su propina sin reescribir el total. */
  method?: string | null
  processor?: string | null
}

export function restanteDeLaMesa(
  orden: Omit<StoredOrderTotalAmounts, 'tipAmount'> & {
    total: Prisma.Decimal | number | string | null | undefined
    /** La propina que la orden dice traer en su total (la columna `Order.tipAmount`). */
    tipAmount: Prisma.Decimal | number | string | null | undefined
    /** De dónde nació la cuenta (`Order.originSystem`): el arreglo sólo aplica a las de Avoqado. */
    originSystem: string | null | undefined
  },
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
  // Dos señales a la vez, las dos que escriben juntos los cobros (`recordOrderPayment`, `payCashOrder`) y la devolución que
  // reabre (D19): el total coincide con la regla común CON las propinas cobradas, Y la columna `tipAmount` de la orden es
  // exactamente esas propinas. Deliverect guarda en `tipAmount` la propina del canal (no la cobrada) y un cobro cripto deja
  // `total` y `tipAmount` como estaban: con una sola señal, un envío igual a la propina se leía como propina (Codex r3 #2).
  const centavos = (v: Prisma.Decimal) => v.toDecimalPlaces(2)
  // Y sólo en una cuenta nacida en Avoqado (Codex r4): sus escritores calculan el total desde sus propias columnas, así que
  // coincidir CON propinas exige que las traiga. Una de canal de entrega (Deliverect), SoftRestaurant o Shopify guarda en
  // `total` cosas que ninguna columna explica (el envío del canal) y en `tipAmount` la propina del canal: un envío igual a la
  // propina pasaba las dos señales. Esas quedan como antes.
  // Y sin abonos cripto (Codex r5 y la pasada exhaustiva del 13-nov): de los escritores de un cobro con propina sobre una cuenta
  // existente, sólo B4Bit la deja COMPLETED sin reescribir `total` ni `tipAmount` (a propósito, `b4bit.service.ts`). Todos los
  // empates que encontró Codex (r3 #2, r4, r5) tomaban su propina de ahí. Con uno, la cuenta queda como antes.
  const hayAbonoCripto = completados.some(
    p => p.type !== 'REFUND' && (p.method === 'CRYPTOCURRENCY' || (p.processor ?? '').toUpperCase() === 'B4BIT'),
  )
  const elTotalTraeLasPropinas =
    orden.originSystem === 'AVOQADO' &&
    !hayAbonoCripto &&
    centavos(totalGuardado).equals(centavos(totalConPropinas)) &&
    centavos(new Prisma.Decimal(orden.tipAmount ?? 0)).equals(centavos(cobrado.netTipAmount))

  // Lo cobrado SIN propina se resta siempre; la propina, sólo si el total la trae.
  const cobradoQueResta = elTotalTraeLasPropinas ? cobrado.netPaidAmount : cobrado.netPaidAmount.minus(cobrado.netTipAmount)

  const enCurso = pagos
    .filter(p => (p.status === 'PENDING' || p.status === 'PROCESSING') && p.type !== 'REFUND')
    .reduce((suma, p) => suma.plus(Prisma.Decimal.max(0, new Prisma.Decimal(p.amount ?? 0))), new Prisma.Decimal(0))

  const restante = totalGuardado.minus(cobradoQueResta).minus(enCurso)
  return restante.isNegative() ? 0 : restante.toDecimalPlaces(2).toNumber()
}
