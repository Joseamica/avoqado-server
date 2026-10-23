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
 *   total      = mercancía + IVA que va aparte (P12) + cargo por servicio + propinas
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
  /**
   * P12 (Codex r2, r5): las tres OBLIGATORIAS. El IVA entra al saldo SÓLO por `impuestoQueSeCobraAparte`, que necesita el
   * contrato, el impuesto y el estado (una cancelada no debe IVA). Olvidar una no compila.
   */
  contratoDePrecio: string | null | undefined
  taxAmount: DecimalLike
  status: string | null | undefined
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
   * P12 (Codex r2, r6 #3): el IVA entra al total guardado SÓLO por `impuestoQueSeCobraAparte`, con la MISMA regla que el
   * saldo (`computeOrderBalance`): con IVA incluido nunca suma; aparte (o desconocido con IVA > 0) sí; una cancelada no debe
   * IVA. Las tres llaves son OBLIGATORIAS y siempre explícitas, nunca por herencia del objeto `Order`: el compilador enumera
   * a cada llamador.
   */
  contratoDePrecio: string | null | undefined
  taxAmount: DecimalLike
  status: string | null | undefined
  serviceChargeAmount?: DecimalLike
  tipAmount?: DecimalLike
}

/**
 * Codex r7 #1/#2: la ÚNICA clasificación del estado de una orden para el dinero. Una CANCELADA o borrada no debe IVA (P12) y
 * ningún cobro automático la cierra; los estados vivos (PENDING, CONFIRMED, PREPARING, READY, COMPLETED…) aportan lo mismo, así
 * que cambiar entre ellos no es un cambio de dinero.
 */
export function claseDeEstado(status: string | null | undefined): 'VIVA' | 'CANCELADA' {
  return status === 'CANCELLED' || status === 'DELETED' ? 'CANCELADA' : 'VIVA'
}

/**
 * Founder, 3-oct-2026 («¿Avoqado debe dejar cobrar una cuenta que ya está cancelada?» → «No, como Square y Toast»). Una
 * cancelada o borrada no admite un cobro NUEVO (`rechazarCobroNuevoSobreCancelada`), pero el dinero YA capturado nunca se
 * rechaza: reabre la cuenta. Ésta es la regla del estado con el que esa cuenta RECIBE el dinero: cancelada con dinero > 0 ⇒
 * PENDING (el mismo estado al que la reabre la reasignación); viva, o cancelada sin dinero, ⇒ la misma. Quien guarda totales
 * calcula con ESTE estado y lo persiste en la misma transacción (Codex r9 #2); el IVA no se toca (Codex r9 #3).
 */
export function estadoAlRecibirDinero<S extends string>(status: S, cobrado: Prisma.Decimal | number): S | 'PENDING' {
  return claseDeEstado(status) === 'CANCELADA' && dec(cobrado).greaterThan(0) ? 'PENDING' : status
}

/**
 * ¿La venta está CERRADA? PAID o REFUNDED: una venta cobrada queda cerrada (founder 16-oct, «como Square»; precedente del 18-ago: el
 * reembolso no reabre el saldo y la cuenta queda sin botón de cobrar). La ÚNICA definición: `esVentaYaCobrada` (decisión «A», la
 * liga de un cliente) y `estadoDeCobroAlRecibirDinero` la leen de aquí.
 */
export function esVentaCerrada(paymentStatus: string | null | undefined): boolean {
  return paymentStatus === 'PAID' || paymentStatus === 'REFUNDED'
}

/**
 * 🔴 R4-2 (Codex r3): el estado con el que se CALCULAN los importes, separado del estado operativo que se GUARDA. Una venta CERRADA
 * (PAID/REFUNDED) que recibe dinero conserva su estado operativo —puede seguir cancelada: R2-2/R3-2—, pero su aritmética es la de
 * cuando se cobró: base e IVA aparte, como una viva (la de una cancelada reabierta, `estadoAlRecibirDinero`). Con la de cancelada el
 * IVA desaparecía del total: $100 + $16 devuelta y cancelada + $50 de propina guardaba $150 contra $166 cobrados. Lo guardado y el
 * aviso de sobrepago salen de ESTE estado. Cualquier otro caso, el estado que quien llama ya decidió.
 */
export function estadoParaCalcular<S extends string>(
  estado: S,
  paymentStatus: string | null | undefined,
  entraDinero: boolean,
): S | 'PENDING' {
  return entraDinero && esVentaCerrada(paymentStatus) && claseDeEstado(estado) === 'CANCELADA' ? 'PENDING' : estado
}

/**
 * 🔴 R4-4 (Codex r3): ¿el importe y la propina, en CENTAVOS, son dinero que se GUARDA? `Payment.amount`/`tipAmount` son pesos con dos
 * decimales, así que cada uno vale lo que queda al redondearlo a centavos enteros: 0.001 ¢ se guarda $0.00 y cuenta como $0. Decide
 * sólo si hay dinero de por medio (el pase de mesa ajena, la propina sola); no cambia lo que se registra. Entradas ya validadas ≥ 0.
 */
export function hayDineroQueSeGuarda(importeCentavos: number, propinaCentavos: number): boolean {
  return Math.round(importeCentavos) + Math.round(propinaCentavos) > 0
}

/**
 * 🔴 R8-1 (ronda 8 post-QA de sellos tardíos; Codex recheck-12 P2): recibir dinero NUNCA reabre una venta cerrada.
 *
 * La cadena de Codex: venta $100 PAID → el panel corrige su cobro a $80 (`updatePayment` no recalcula: sigue PAID) → llega un cobro
 * de la terminal de $10 (la TPV acepta cobros sobre ventas PAID a propósito: el banco ya cobró) → el recálculo sumaba $90 < $100 y
 * escribía PARTIAL. Con eso la venta dejaba de contar como cobrada y el pago manual y el PUT del panel (COCINA, sin `payments:create`)
 * volvían a ligar un cliente con su lealtad.
 *
 * Quien escribe el estado de cobro de una venta por la que ENTRA dinero (un cobro nuevo o tardío, por cualquier canal) pasa el
 * `paymentStatus` que leyó BAJO su candado ANTES de la operación y lo que calculó su aritmética:
 *   - venta abierta (PENDING/PARTIAL), o no entra dinero (el origen de una reasignación: el cobro no era suyo y vuelve a deber) ⇒
 *     lo calculado, tal cual (el mismo objeto);
 *   - venta cerrada + dinero que entra ⇒ conserva su estado, el saldo queda en 0 (una venta cerrada no debe nada) y `cerrada: true`:
 *     quien llama NO mueve `status` ni `completedAt` y NO repite los efectos de saldar (lealtad, vale de inventario, marca de cocina).
 * El dinero se registra como hoy: el `Payment`, `paidAmount` y la propina reales, la alerta de sobrepago, la bitácora y el vigilante.
 * 🔴 No es «cualquier reembolso implica venta cobrada» (la marca de la ronda 6, que bloqueaba cuentas que nunca se saldaron).
 */
export function estadoDeCobroAlRecibirDinero<S extends string, R>(
  previo: string | null | undefined,
  entraDinero: boolean,
  calculado: { paymentStatus: S; remainingBalance: R },
): { paymentStatus: S | 'PAID' | 'REFUNDED'; remainingBalance: R | 0; cerrada: boolean } {
  if (!entraDinero || !esVentaCerrada(previo)) return { ...calculado, cerrada: false }
  return { paymentStatus: previo as 'PAID' | 'REFUNDED', remainingBalance: 0, cerrada: true }
}

/**
 * ¿Es el cierre transaccional del cobro (`settleStandalonePaymentInTx`) el dueño de los efectos de saldar esta cuenta (vale de
 * inventario, lealtad, marca de cocina)? No en una integrada (POS con `externalId`: la salda SoftRestaurant) ni en una con renglones
 * de vale por área (sus reservas ya consumieron el stock y la finaliza otro camino). Un criterio, un lugar: lo usan
 * `recordOrderPayment` y la reasignación de cobros (Tarea 6d, I-1).
 */
export function cierreDelCobroSaldaLaCuenta(o: {
  source: string
  externalId: string | null
  items: ReadonlyArray<{ areaTicketLineId: string | null }>
}): boolean {
  const integrada = o.source === 'POS' && !!o.externalId?.trim()
  return !integrada && !o.items.some(i => i.areaTicketLineId != null)
}

/**
 * P12 (Codex r2; founder 2-oct): el IVA que SUMA al total y al saldo. IVA_INCLUIDO ⇒ nunca (el precio ya lo trae). IVA_APARTE
 * ⇒ el declarado. DESCONOCIDO ⇒ la convención vigente del vigilante y de la factura (founder, 3-sep: «si el dueño puso IVA
 * entonces se suma»): un IVA escrito > 0 va aparte — así nacieron las de SoftRestaurant de antes del contrato; las nativas
 * nacen con 0. Siempre clampado: un impuesto negativo nunca baja lo que se debe. Y una cuenta CANCELADA o borrada no debe IVA
 * (Codex r5): el origen de una fusión de antes del bloque quedó cancelado con su `taxAmount`. Los cobros SÍ leen `status` (Tarea
 * 6a): un cobro nuevo sobre una cancelada se rechaza y el dinero ya capturado la reabre ANTES de calcular
 * (`shared/cuentaCancelada.ts`), así que esta regla sólo ve canceladas que no recibieron dinero.
 */
export function impuestoQueSeCobraAparte(o: {
  contratoDePrecio: string | null | undefined
  taxAmount: DecimalLike | null | undefined
  /** Obligatoria (Codex r6 #3): lo que se guarda y lo que se cobra siguen la MISMA regla; olvidarla no compila. */
  status: string | null | undefined
}): Prisma.Decimal {
  if (claseDeEstado(o.status) === 'CANCELADA') return ZERO
  if (o.contratoDePrecio === 'IVA_INCLUIDO') return ZERO
  const impuesto = dec(o.taxAmount)
  return impuesto.isNegative() ? ZERO : impuesto
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
 *   mercancía = max(0, subtotal − descuento)   ← se clampa
 *   impuesto  = impuestoQueSeCobraAparte(…)    ← P12: 0 con IVA incluido o cancelada; si no, max(0, impuesto)
 *   total     = mercancía + impuesto + cargo por servicio + propina
 *
 * 🔴 Los dos conceptos que pueden llegar en negativo se clampan por separado, y
 * el clamp NO envuelve al resto.
 *
 * - **Mercancía.** Un `discountAmount` mayor que el subtotal es un estado que sí
 *   existe en la base (cortesía de cuenta completa encima de un descuento previo)
 *   y sin clamp el total sale NEGATIVO y RESTA del corte del día (caso M13:
 *   subtotal 253.00 − descuento 278.30 = −25.30).
 * - **Impuesto.** Hasta D16 (IVA por producto, B2b) el motor de descuentos restaba
 *   `monto × 0.16` FIJO (`estimateAverageTaxRate`, que no miraba la orden, con
 *   `applyBeforeTax` en `true` por default): una cortesía de $253 sobre una cuenta con
 *   poco o ningún impuesto dejaba el impuesto en −40.48, y ese valor se PERSISTÍA.
 *   Desde D16 el motor ya no resta un 16 % fijo (sólo con IVA aparte, el impuesto
 *   realmente cobrado en lo que tocó, topado a la cabecera), pero las órdenes viejas
 *   siguen guardadas en negativo y los otros caminos lo leen de la orden. Por ellas el
 *   clamp se queda: un impuesto negativo nunca puede RESTAR de lo que se debe.
 *   ⚠️ Se clampa aquí la CONTRIBUCIÓN al total, no el `taxAmount` guardado:
 *   `removeDiscountFromOrder` devuelve `+ taxReduction` sin tope, así que clampar
 *   lo persistido haría que quitar el descuento inventara un impuesto que el
 *   cliente nunca pagó. Qué debe guardarse ahí es una raíz PREEXISTENTE, con su
 *   propia tarea.
 *
 * Se clampan POR SEPARADO y no sobre la suma: con mercancía 100 e impuesto −30, lo
 * correcto es 100 (el impuesto no aporta), no 70.
 *
 * 🔴 La propina y el cargo por servicio NO se clampan ni se envuelven: no son
 * mercancía, y meterlos dentro del `max` deja que un descuento excedente se los coma.
 *
 * ⚠️ El `Prisma.Decimal` protege ESTA suma, no el camino entero: los tres sitios de
 * descuento ya entran con floats (`Number(order.subtotal)`, un `remainingDiscountable`
 * redondeado a centavos) y salen con `.toNumber()`. Aquí no hay garantía de punta a
 * punta — sólo deja de acumularse residuo en la suma final.
 */
export function computeStoredOrderTotal(amounts: StoredOrderTotalAmounts): Prisma.Decimal {
  const merchandiseRaw = dec(amounts.subtotal).minus(dec(amounts.discountAmount))
  const merchandise = merchandiseRaw.isNegative() ? ZERO : merchandiseRaw

  // P12: la MISMA regla que el saldo (clamp incluido); con IVA incluido un impuesto escrito ya no suma.
  const tax = impuestoQueSeCobraAparte(amounts)

  return merchandise.plus(tax).plus(dec(amounts.serviceChargeAmount)).plus(dec(amounts.tipAmount))
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

  // 🔴 Campo por campo, NUNCA `...order`: el IVA entra SÓLO por la regla de P12 (`impuestoQueSeCobraAparte`: con IVA
  // incluido nunca, y una cancelada no debe IVA), con las tres llaves que la regla lee y nada más del objeto `Order`.
  const total = computeStoredOrderTotal({
    subtotal: order.subtotal,
    discountAmount: order.discountAmount,
    serviceChargeAmount: order.serviceChargeAmount,
    contratoDePrecio: order.contratoDePrecio,
    taxAmount: order.taxAmount,
    status: order.status,
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

/** Lo que falta cobrar de un pedido de reparto en efectivo, por partes (Rappi 2b). Todo en pesos. */
export interface SaldoDeCobroDeReparto {
  /** Venta (productos + envío − descuento) que falta: el saldo común. */
  ventaPendiente: Prisma.Decimal
  /** Propina contractual que falta (`Order.cashTipDue` − propinas cobradas). */
  propinaPendiente: Prisma.Decimal
  /** Dinero por cuenta de la plataforma que falta (`Order.thirdPartyCashDue` − Σ `Payment.thirdPartyCashAmount`). */
  tercerosPendiente: Prisma.Decimal
  /** Lo que la caja tiene que cobrar: las tres partes. */
  totalACobrar: Prisma.Decimal
}

/**
 * 🔴 Rappi 2b (diseño 2026-10-23, T6): cuánto falta de un pedido con repartidor propio en efectivo. `null` si la orden no es de
 * ese carril (sin `thirdPartyCashDue`): el resto del sistema sigue con `computeOrderBalance`, que no cambia.
 *
 * La propina pendiente sale de `cashTipDue`, NUNCA de `Order.tipAmount`: cada cobro reescribe esa columna con lo cobrado. Las
 * devoluciones se tratan como en el saldo común (`summarizeRefunds`): no reabren propina ni terceros ya cobrados.
 */
export function saldoDeCobroDeReparto(
  order: OrderAmountsForBalance & { thirdPartyCashDue: DecimalLike | null; cashTipDue: DecimalLike | null },
  completedPayments: readonly (CompletedPaymentForBalance & { thirdPartyCashAmount?: DecimalLike | null })[],
): SaldoDeCobroDeReparto | null {
  if (order.thirdPartyCashDue == null) return null
  const cobrados = completedPayments.filter(p => !isRefundPayment(p))
  const tercerosCobrados = cobrados.reduce((s, p) => s.plus(dec(p.thirdPartyCashAmount)), ZERO)
  const noNegativo = (v: Prisma.Decimal) => (v.isNegative() ? ZERO : v)

  const ventaPendiente = computeOrderBalance(order, completedPayments).remainingBalance
  const propinaPendiente = noNegativo(dec(order.cashTipDue).minus(summarizeRefunds(completedPayments).netTipAmount))
  const tercerosPendiente = noNegativo(dec(order.thirdPartyCashDue).minus(tercerosCobrados))
  return {
    ventaPendiente,
    propinaPendiente,
    tercerosPendiente,
    totalACobrar: ventaPendiente.plus(propinaPendiente).plus(tercerosPendiente),
  }
}
