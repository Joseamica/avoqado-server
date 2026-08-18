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
 *   mercancía = max(0, subtotal − descuento)     ← el clamp va ANTES de sumar
 *   total     = mercancía + cargo por servicio + propinas
 *   pagado    = Σ (amount + tipAmount) de los pagos COMPLETED
 *   restante  = total − pagado
 *   pagada    ⟺ restante <= 0.01
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

/** Un `Payment` en estado COMPLETED. La propina cuenta como dinero recibido. */
export interface CompletedPaymentForBalance {
  amount: DecimalLike
  tipAmount?: DecimalLike
}

export interface OrderBalance {
  /** Total canónico de la cuenta, propinas incluidas. */
  total: Prisma.Decimal
  /** Suma de las propinas de los pagos COMPLETED. */
  tipAmount: Prisma.Decimal
  /** Lo efectivamente recibido (importe + propina) de los pagos COMPLETED. */
  paidAmount: Prisma.Decimal
  /** Lo que falta por cobrar. Nunca negativo: un sobrepago deja 0. */
  remainingBalance: Prisma.Decimal
  /** `true` sólo si el faltante cabe en la tolerancia de un centavo. */
  isFullyPaid: boolean
}

const ZERO = new Prisma.Decimal(0)

const dec = (value: DecimalLike): Prisma.Decimal => (value == null ? ZERO : new Prisma.Decimal(value.toString()))

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
  const merchandiseRaw = dec(order.subtotal).minus(dec(order.discountAmount))
  const merchandise = merchandiseRaw.isNegative() ? ZERO : merchandiseRaw

  let tipAmount = ZERO
  let paidAmount = ZERO
  for (const payment of completedPayments) {
    const tip = dec(payment.tipAmount)
    tipAmount = tipAmount.plus(tip)
    paidAmount = paidAmount.plus(dec(payment.amount)).plus(tip)
  }

  const total = merchandise.plus(dec(order.serviceChargeAmount)).plus(tipAmount)
  const remaining = total.minus(paidAmount)

  return {
    total,
    tipAmount,
    paidAmount,
    remainingBalance: remaining.isNegative() ? ZERO : remaining,
    isFullyPaid: remaining.lessThanOrEqualTo(FULL_PAYMENT_TOLERANCE),
  }
}
