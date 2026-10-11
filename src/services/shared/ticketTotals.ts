import { Prisma, type PrismaClient } from '@prisma/client'
import { impuestoQueSeCobraAparte } from './orderBalance'
import { reciboCanonicoDelPago } from './reciboCanonico'

/** Un importe en PESOS como llega de Prisma (Decimal), de un JSON congelado (number) o de un texto. */
type Monto = Prisma.Decimal | number | string | null | undefined

const CERO_DEC = new Prisma.Decimal(0)
const aDecimal = (v: Monto): Prisma.Decimal =>
  v === null || v === undefined || v === '' ? CERO_DEC : v instanceof Prisma.Decimal ? v : new Prisma.Decimal(String(v))

/**
 * Lo que muestra el comprobante de UN cobro, en pesos y en magnitud. Siempre:
 * subtotal − descuento + cargo + IVA agregado + propina = total.
 */
export interface TicketTotals {
  /**
   * COBRO o DEVOLUCION: una devolución se pinta en positivo y marcada como tal («DEVOLUCIÓN» en el papel, «Total reembolsado»
   * en visor, HTML, correo y AirPrint).
   */
  kind: 'COBRO' | 'DEVOLUCION'
  /** true ⇒ subtotal, cargo e IVA agregado son los de la venta entera (este cobro la pagó completa). false ⇒ sólo total. */
  desglosado: boolean
  /**
   * Desglosado: la mercancía BRUTA (antes del descuento), como el papel del cobro de las apps (ronda 1, A7-R6). Sin desglose: lo
   * cobrado sin propina.
   */
  subtotal: number
  /**
   * Ronda 1 (A7-R6), aditivo: el descuento en pesos, sólo desglosado y > 0 (si no, la llave no existe). Misma definición que el
   * papel del cobro (Android `TotalesDelTicket.desdeLoCobrado`, iOS su espejo): lo que falta del bruto + cargo + IVA agregado
   * para llegar a lo cobrado. Así el comprobante emitido y su reimpresión dicen las mismas cifras que el papel del cobro.
   */
  discount?: number
  /** Cargo por servicio (ingreso del negocio, no propina). 0 sin desglose. */
  serviceCharge: number
  /** El IVA que la venta cobró APARTE, encima del precio. 0 = el precio ya lo traía (la norma) o no hay desglose. */
  addedTax: number
  tip: number
  total: number
}

export interface EntradaDelTicket {
  /** `status` del cobro CONSULTADO: sólo un COMPLETED puede ser el «único cobro de venta» que cuenta `cobrosDeVenta` (r2 R2-8). */
  payment: { amount: Monto; tipAmount: Monto; type?: string | null; status?: string | null }
  /** null = cobro sin orden (cobro rápido). */
  order: {
    subtotal: Monto
    discountAmount: Monto
    serviceChargeAmount: Monto
    taxAmount: Monto
    contratoDePrecio: string | null | undefined
    status: string | null | undefined
  } | null
  /** Cuántos cobros de VENTA tiene la orden (`COBROS_DE_VENTA`), incluido éste. */
  cobrosDeVenta: number
}

/**
 * Los cobros que cuentan como venta: la versión Prisma de `COBRO_QUE_CUBRE` (`pagadaPeroAbierta.ts`) con importe > 0.
 * 🔴 `Payment.type` es NULL en filas viejas: `{ type: { not: 'REFUND' } }` solo se traduce a `type <> 'REFUND'` y en SQL eso
 * EXCLUYE los NULL (memoria `predicado-not-en-sql-con-columnas-null-excluye-en-silencio`). Por eso el OR explícito.
 */
export const COBROS_DE_VENTA: Prisma.PaymentWhereInput = {
  status: 'COMPLETED',
  amount: { gt: 0 },
  OR: [{ type: null }, { type: { not: 'REFUND' } }],
}

const sinDesglose = (kind: TicketTotals['kind'], amount: Prisma.Decimal, tip: Prisma.Decimal): TicketTotals => ({
  kind,
  desglosado: false,
  subtotal: amount.toNumber(),
  serviceCharge: 0,
  addedTax: 0,
  tip: tip.toNumber(),
  total: amount.plus(tip).toNumber(),
})

/**
 * IVA por producto, plan 7 (D3, regla de cuadre; plan 7 r1 #1 y #2). El comprobante NO calcula IVA: sólo pinta el que la venta
 * cobró APARTE (`impuestoQueSeCobraAparte`: nunca con contrato IVA_INCLUIDO ni en una cancelada; un negativo no cuenta), y sólo
 * cuando ESTE cobro es el único cobro de venta y paga EXACTAMENTE lo que la cuenta debe sin propina —la misma suma que
 * `computeStoredOrderTotal` y `COBRO_QUE_CUBRE`—. Cualquier otra cosa (parcial, varios cobros, una propina que «completa» el
 * total, sin orden) va sin desglose: nunca se prorratea ni se estima. No se lee `Order.total`: trae o no la propina según quién
 * tocó la orden al final (memoria `order-total-propina-semantica-doble`). Una devolución (`type` REFUND, importe negativo, o
 * importe 0 con propina negativa: devolución de sólo propina) va en magnitudes y sin desglose: qué parte del impuesto se
 * devolvió lo dice la nota de crédito, no el ticket.
 */
export function ticketTotals(e: EntradaDelTicket): TicketTotals {
  const amount = aDecimal(e.payment.amount)
  const tip = aDecimal(e.payment.tipAmount)
  // Devolución: por su tipo, por importe negativo, o por propina negativa con importe 0 (devolución de sólo propina, r2 R2-6).
  const esDevolucion = e.payment.type === 'REFUND' || amount.isNegative() || (amount.isZero() && tip.isNegative())
  if (esDevolucion) return sinDesglose('DEVOLUCION', amount.abs(), tip.abs())
  const o = e.order
  // El cobro consultado tiene que SER el único cobro de venta que se contó (r2 R2-8): un intento fallido no lo es.
  if (!o || e.cobrosDeVenta !== 1 || e.payment.status !== 'COMPLETED' || !amount.gt(0)) return sinDesglose('COBRO', amount, tip)
  const bruto = aDecimal(o.subtotal)
  const mercanciaBruta = bruto.minus(aDecimal(o.discountAmount))
  const mercancia = mercanciaBruta.isNegative() ? CERO_DEC : mercanciaBruta
  const cargo = aDecimal(o.serviceChargeAmount)
  const impuesto = impuestoQueSeCobraAparte({ contratoDePrecio: o.contratoDePrecio, taxAmount: o.taxAmount, status: o.status })
  const loQueDebe = mercancia.plus(cargo).plus(impuesto)
  if (cargo.isNegative() || !amount.eq(loQueDebe)) return sinDesglose('COBRO', amount, tip)
  // Ronda 1 (A7-R6): la MISMA definición que el papel del cobro (`TotalesDelTicket.desdeLoCobrado`, Android e iOS): el
  // descuento es lo que falta del bruto + cargo + IVA agregado para llegar a lo cobrado; si saliera negativo (subtotal guardado
  // negativo), el subtotal pasa a ser lo cobrado sin cargo ni IVA y no hay descuento. Aquí lo cobrado ES lo que la cuenta debe,
  // así que el descuento es `min(subtotal, descuento guardado)`: una cortesía mayor que el subtotal no descuenta de más.
  const descuento = bruto.plus(cargo).plus(impuesto).minus(amount)
  const subtotal = descuento.isNegative() ? amount.minus(cargo).minus(impuesto) : bruto
  const discount = descuento.isNegative() ? 0 : descuento.toNumber()
  return {
    kind: 'COBRO',
    desglosado: true,
    subtotal: subtotal.toNumber(),
    ...(discount > 0 ? { discount } : {}),
    serviceCharge: cargo.toNumber(),
    addedTax: impuesto.toNumber(),
    tip: tip.toNumber(),
    total: amount.plus(tip).toNumber(),
  }
}

/** Sólo el total de un cobro (o devolución), sin desglose: la salida segura cuando no se sabe más. */
export function ticketTotalsSinDesglose(p: EntradaDelTicket['payment']): TicketTotals {
  return ticketTotals({ payment: p, order: null, cobrosDeVenta: 0 })
}

/**
 * Los totales de un `DigitalReceipt.dataSnapshot`: los congelados al crear el recibo (Tarea 3) o, en un recibo de antes de este
 * plan, el total del cobro sin desglose. 🔴 Nunca se reconstruyen desde `snapshot.order`: un cobro parcial mostraría el total de
 * toda la orden (Codex r1 #4 y #8). `null` si el snapshot no trae el cobro.
 */
export function ticketTotalsDelSnapshot(snapshot: unknown): TicketTotals | null {
  const s = snapshot as { ticketTotals?: TicketTotals | null; payment?: { amount?: Monto; tipAmount?: Monto; type?: string | null } } | null
  if (s?.ticketTotals && typeof s.ticketTotals.total === 'number') return s.ticketTotals
  if (!s?.payment || s.payment.amount === undefined || s.payment.amount === null) return null
  return ticketTotalsSinDesglose({ amount: s.payment.amount, tipAmount: s.payment.tipAmount, type: s.payment.type })
}

/** Cuántos cobros de venta tiene una orden, con el MISMO predicado del desglose. Sin orden: 0. */
export async function contarCobrosDeVenta(db: Prisma.TransactionClient | PrismaClient, orderId: string | null): Promise<number> {
  return orderId ? db.payment.count({ where: { orderId, ...COBROS_DE_VENTA } }) : 0
}

/** Una consulta acotada por id: el cobro, los importes de su orden y cuántos cobros de venta tiene. */
export async function cargarTotalesDelTicket(db: Prisma.TransactionClient | PrismaClient, paymentId: string): Promise<TicketTotals | null> {
  const p = await db.payment.findUnique({
    where: { id: paymentId },
    select: {
      amount: true,
      tipAmount: true,
      type: true,
      status: true,
      order: {
        select: {
          subtotal: true,
          discountAmount: true,
          serviceChargeAmount: true,
          taxAmount: true,
          contratoDePrecio: true,
          status: true,
          _count: { select: { payments: { where: COBROS_DE_VENTA } } },
        },
      },
    },
  })
  if (!p) return null
  return ticketTotals({
    payment: { amount: p.amount, tipAmount: p.tipAmount, type: p.type, status: p.status },
    order: p.order,
    cobrosDeVenta: p.order?._count.payments ?? 0,
  })
}

/**
 * 🔴 La política ÚNICA para reimprimir un cobro (r2 R2-9): si ya se emitió su recibo digital, manda lo que ese recibo dice —el
 * mismo comprobante que vio el cliente, aunque la orden se haya movido después (una sincronización de SoftRestaurant puede
 * reescribir sus importes)—; si no tiene recibo, se calcula con la orden. Una consulta acotada por `paymentId` (el recibo canónico,
 * `reciboCanonicoDelPago`: el más viejo por (createdAt, id), como `generateDigitalReceipt`).
 */
export async function totalesDelComprobante(db: Prisma.TransactionClient | PrismaClient, paymentId: string): Promise<TicketTotals | null> {
  const recibo = await reciboCanonicoDelPago(db, paymentId, { select: { dataSnapshot: true } })
  return recibo ? ticketTotalsDelSnapshot(recibo.dataSnapshot) : cargarTotalesDelTicket(db, paymentId)
}
