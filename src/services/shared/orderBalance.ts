import { Prisma } from '@prisma/client'

/**
 * Aritmética canónica del saldo de una cuenta — PURA, sin DB y sin efectos.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 * Varios caminos de cobro (efectivo móvil, TPV, cripto) resuelven la MISMA
 * pregunta —"¿cuánto se lleva pagado y cuánto falta?"— y cada uno la escribía a
 * su manera. El de cripto ni siquiera sumaba: pisaba `paidAmount` con el último
 * abono y ponía `remainingBalance: 0` incondicionalmente, así que un abono de
 * $50 sobre una cuenta de $200 la cerraba PAGADA y BORRABA los $150 por cobrar.
 *
 * Esta función es la aritmética de `payCashOrder`
 * (`src/services/mobile/order.mobile.service.ts`) extraída tal cual, para que
 * quien la necesite la reuse en vez de reinventarla. `payCashOrder` sigue con su
 * copia inline —no se toca en este trabajo— pero es el siguiente candidato
 * natural a llamar aquí.
 *
 * ── Las reglas ──────────────────────────────────────────────────────────────
 *   mercancía  = max(0, subtotal − descuento)    ← el clamp va ANTES de sumar
 *   total      = mercancía + cargo por servicio + propinas
 *   pagado     = Σ (amount + tipAmount) de los COMPLETED que NO son REFUND
 *   restante   = total − pagado
 *   pagada     ⟺ restante <= 0.01
 *   reembolsado = Σ |amount| + |tipAmount| de los COMPLETED type REFUND
 *
 * 🔴 UN REEMBOLSO NO REABRE SALDO (founder, 2026-08-18). El reembolso vive en su
 * PROPIO carril y la venta original no se toca. Antes esta suma incluía el
 * `Payment` NEGATIVO `type: REFUND` que los tres caminos de reembolso cuelgan de
 * la MISMA orden, así que cualquier recálculo posterior hacía 200 + (−200) = 0
 * pagados y la venta devuelta reaparecía debiendo $200, en el estado
 * contradictorio `status COMPLETED` + `paymentStatus PARTIAL`.
 *
 * Es el modelo de los referentes, no una invención nuestra: Toast documenta
 * "`totalAmount` is not affected by refunds" y lleva el estado en
 * `Payment.refundStatus` = NONE/PARTIAL/FULL (de ahí `refundState`); Square crea
 * una orden de devolución aparte con `source_order_id` y acumula en
 * `refunded_money`; Clip emite el reembolso como una transacción nueva y el pago
 * original conserva su COMPLETED. En México además es requisito fiscal: la
 * devolución se ampara con un CFDI de Egreso (nota de crédito, relación 01, uso
 * G02) y el CFDI de ingreso original NO se modifica ni se cancela — una cuenta
 * que vuelve a decir "debe $X" es incompatible con lo ya timbrado.
 *
 * 🔴 El clamp es sobre la MERCANCÍA, no sobre el total: un `discountAmount`
 * mayor que el subtotal existe de verdad en la base (cortesía de cuenta completa
 * encima de un descuento previo), y sin clamp la venta escribe un total NEGATIVO
 * que RESTA del corte del día. Pero la propina y el cargo por servicio son
 * dinero aparte de la mercancía: un descuento excedente no debe comérselos.
 *
 * 🔴 Todo en `Prisma.Decimal`. En float, 0.10 + 0.20 deja un residuo que
 * convierte una cuenta saldada en una con "$0.0000000001 por cobrar".
 */

/** Tolerancia de cierre: hasta un centavo de faltante se considera saldada. */
export const FULL_PAYMENT_TOLERANCE = new Prisma.Decimal('0.01')

type DecimalLike = Prisma.Decimal | number | string | null | undefined

/** Los importes de la orden que definen el total canónico. */
export interface OrderAmountsForBalance {
  subtotal: DecimalLike
  discountAmount?: DecimalLike
  serviceChargeAmount?: DecimalLike
}

/**
 * Un `Payment` en estado COMPLETED. La propina cuenta como dinero recibido.
 *
 * 🔑 `type` es OPCIONAL para no romper a quien ya llamaba sin él, pero quien lee
 * pagos de la base **debe** seleccionarlo: sin `type` un reembolso es
 * indistinguible de un cobro negativo y vuelve a restar del saldo.
 */
export interface CompletedPaymentForBalance {
  amount: DecimalLike
  tipAmount?: DecimalLike
  /** `PaymentType` del pago. Sólo `'REFUND'` cambia el comportamiento. */
  type?: string | null
}

/** Cuánto de la venta se ha devuelto. Espejo de `Payment.refundStatus` de Toast. */
export type RefundState = 'NONE' | 'PARTIAL' | 'FULL'

export interface OrderBalance {
  /** Total canónico de la cuenta, propinas incluidas. */
  total: Prisma.Decimal
  /** Suma de las propinas COBRADAS (los REFUND no restan). */
  tipAmount: Prisma.Decimal
  /** Lo efectivamente recibido (importe + propina) de los COMPLETED que no son REFUND. */
  paidAmount: Prisma.Decimal
  /** Lo que falta por cobrar. Nunca negativo: un sobrepago deja 0. */
  remainingBalance: Prisma.Decimal
  /** `true` sólo si el faltante cabe en la tolerancia de un centavo. */
  isFullyPaid: boolean
  /** Lo devuelto, en PESOS y en POSITIVO (los `Payment` REFUND se guardan negativos). */
  refundedAmount: Prisma.Decimal
  /**
   * Lo mismo en centavos enteros. Es la representación que pide el contrato del
   * carril de reembolso (comparaciones exactas, sin residuo); la de PESOS
   * (`refundedAmount`) es la que sale en cualquier respuesta de API — regla de
   * `.claude/rules/critical-warnings.md`: la plataforma trabaja en pesos 1:1.
   */
  refundedCents: number
  /** NONE si no hay devoluciones · FULL cuando lo devuelto ≥ lo pagado neto. */
  refundState: RefundState
}

const ZERO = new Prisma.Decimal(0)

const dec = (value: DecimalLike): Prisma.Decimal => (value == null ? ZERO : new Prisma.Decimal(value.toString()))

/** El `PaymentType` que marca un `Payment` como devolución de dinero. */
export const REFUND_PAYMENT_TYPE = 'REFUND'

/** ¿Este `Payment` es una devolución? La ÚNICA definición — no la redeclares. */
export function isRefundPayment(payment: CompletedPaymentForBalance): boolean {
  return payment.type === REFUND_PAYMENT_TYPE
}

/** Lo que sale de separar cobros y devoluciones dentro de una MISMA orden. */
export interface RefundSummary {
  /** Σ (amount + tipAmount) de los pagos que NO son REFUND. */
  netPaidAmount: Prisma.Decimal
  /** Σ tipAmount de los pagos que NO son REFUND. */
  netTipAmount: Prisma.Decimal
  refundedAmount: Prisma.Decimal
  refundedCents: number
  refundState: RefundState
}

/**
 * Separa los `Payment` COMPLETED de una orden en dinero COBRADO y dinero
 * DEVUELTO. Es el único lugar del backend que decide qué cuenta como pagado, y
 * por eso los cuatro caminos de cobro (efectivo móvil, TPV, vales por área,
 * cripto) leen sus pagos previos SIN filtrar por `type` y los pasan por aquí:
 * un filtro en la consulta escondería los REFUND y con ellos el `refundState`
 * que las apps y el dashboard tienen que pintar.
 */
export function summarizeRefunds(completedPayments: readonly CompletedPaymentForBalance[]): RefundSummary {
  let netPaidAmount = ZERO
  let netTipAmount = ZERO
  let refundedAmount = ZERO

  for (const payment of completedPayments) {
    const amount = dec(payment.amount)
    const tip = dec(payment.tipAmount)
    if (isRefundPayment(payment)) {
      // Los REFUND se guardan NEGATIVOS (importe y propina). Se acumulan en
      // valor absoluto: "cuánto se devolvió", no "cuánto restan".
      refundedAmount = refundedAmount.plus(amount.abs()).plus(tip.abs())
      continue
    }
    netTipAmount = netTipAmount.plus(tip)
    netPaidAmount = netPaidAmount.plus(amount).plus(tip)
  }

  // FULL cuando lo devuelto alcanza lo pagado neto. Con `netPaidAmount` en 0
  // (la orden placeholder de un reembolso NO asociado, que nace sin cobro) un
  // reembolso > 0 también es FULL, que es la lectura correcta: no queda nada
  // por devolver.
  const refundState: RefundState = refundedAmount.lessThanOrEqualTo(ZERO)
    ? 'NONE'
    : refundedAmount.greaterThanOrEqualTo(netPaidAmount)
      ? 'FULL'
      : 'PARTIAL'

  return {
    netPaidAmount,
    netTipAmount,
    refundedAmount,
    refundedCents: refundedAmount.mul(100).round().toNumber(),
    refundState,
  }
}

/** Los importes de una orden que definen su `Order.total` GUARDADO. */
export interface StoredOrderTotalAmounts {
  subtotal: DecimalLike
  discountAmount?: DecimalLike
  /**
   * 🔴 SÓLO para los caminos de descuento, que históricamente lo suman al total
   * guardado. La aritmética canónica del SALDO (`computeOrderBalance`) NO lo pasa
   * —y no debe—: en México el precio en pantalla ya trae el IVA, así que sumarlo
   * otra vez lo cobraría dos veces. Se deja explícito, nunca por herencia del
   * objeto `Order`.
   */
  taxAmount?: DecimalLike
  serviceChargeAmount?: DecimalLike
  tipAmount?: DecimalLike
}

/**
 * El `Order.total` que se GUARDA, a partir de los importes de la cuenta. PURA.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 * Es la MISMA regla escrita en varios sitios, y esa duplicación ya costó dinero
 * dos veces sobre el mismo campo. `Order.serviceChargeAmount` —cargo por
 * servicio: propina automática por grupo, descorche, entrega— es, dicho por el
 * schema, «INGRESO GRAVABLE del negocio: SUMA al total y entra al corte y al
 * CFDI», a diferencia de la propina, que pasa al mesero. Quitar un descuento lo
 * tiraba del total (reproducido en hardware, NEXGO 2026-08-06: $35 → $55
 * aterrizaba en $35) y se arregló ahí; los tres caminos que APLICAN un descuento
 * conservaron la fórmula vieja hasta el 2026-09-03.
 *
 * ── La regla ────────────────────────────────────────────────────────────────
 *   mercancía = max(0, subtotal − descuento)   ← el clamp cubre SÓLO la mercancía
 *   total     = mercancía + impuesto + cargo por servicio + propina
 *
 * 🔴 El clamp NO envuelve al resto. Un `discountAmount` mayor que el subtotal es
 * un estado que sí existe en la base (cortesía de cuenta completa encima de un
 * descuento previo) y sin clamp el total sale NEGATIVO y RESTA del corte del día
 * (caso M13: subtotal 253.00 − descuento 278.30 = −25.30). Pero la propina y el
 * cargo por servicio no son mercancía: meterlos dentro del `max` deja que un
 * descuento excedente se los coma.
 *
 * 🔴 Todo en `Prisma.Decimal`. En float, 0.10 + 0.20 deja un residuo que
 * convierte una cuenta saldada en una con «$0.0000000001 por cobrar».
 */
export function computeStoredOrderTotal(amounts: StoredOrderTotalAmounts): Prisma.Decimal {
  const merchandiseRaw = dec(amounts.subtotal).minus(dec(amounts.discountAmount))
  const merchandise = merchandiseRaw.isNegative() ? ZERO : merchandiseRaw

  return merchandise.plus(dec(amounts.taxAmount)).plus(dec(amounts.serviceChargeAmount)).plus(dec(amounts.tipAmount))
}

/**
 * Dado el total canónico de una orden y sus pagos COMPLETED, devuelve cuánto se
 * lleva pagado, cuánto falta y si la cuenta puede darse por saldada.
 *
 * 🔑 Recibe los pagos COMPLETED **completos**, no "los previos + este": quien la
 * llama debe releer los pagos durables de la orden después de completar el suyo.
 * Así un webhook o un reintento repetido recalcula el MISMO resultado en vez de
 * acumular (`paidAmount += amount` duplicaría el abono).
 */
export function computeOrderBalance(order: OrderAmountsForBalance, completedPayments: readonly CompletedPaymentForBalance[]): OrderBalance {
  const refunds = summarizeRefunds(completedPayments)
  const tipAmount = refunds.netTipAmount
  const paidAmount = refunds.netPaidAmount

  // 🔴 Campo por campo, NUNCA `...order`: pasar el objeto entero le colaría
  // `taxAmount` al total del saldo y el cobro empezaría a cobrar el IVA dos veces.
  const total = computeStoredOrderTotal({
    subtotal: order.subtotal,
    discountAmount: order.discountAmount,
    serviceChargeAmount: order.serviceChargeAmount,
    tipAmount,
  })
  const remaining = total.minus(paidAmount)

  return {
    total,
    tipAmount,
    paidAmount,
    remainingBalance: remaining.isNegative() ? ZERO : remaining,
    isFullyPaid: remaining.lessThanOrEqualTo(FULL_PAYMENT_TOLERANCE),
    refundedAmount: refunds.refundedAmount,
    refundedCents: refunds.refundedCents,
    refundState: refunds.refundState,
  }
}
