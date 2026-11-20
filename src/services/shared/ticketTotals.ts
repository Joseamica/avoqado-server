import { Prisma, type PrismaClient } from '@prisma/client'
import { FULL_PAYMENT_TOLERANCE, impuestoQueSeCobraAparte } from './orderBalance'
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
  /**
   * D41 «C» (16-nov), aditivo: sólo existe (y es > 0) cuando el desglose sumó al subtotal y al descuento la cortesía que la venta guardó
   * en $0 (Mesas). Dice que los renglones de esa cortesía se pintan a su bruto para cuadrar con el subtotal; un recibo de antes no la
   * trae y sus renglones siguen como se congelaron.
   */
  cortesia?: number
  /**
   * D15 (28-oct), aditivo: sólo existe (y vale `true`) cuando este cobro es UNA PARTE de una venta dividida: un cobro de venta
   * (COMPLETED, > 0) de una orden que tiene más de un cobro de venta, o que paga menos de lo que la orden debe por más del centavo de
   * tolerancia. La reimpresión, el recibo digital y el correo pintan entonces un renglón «Pago parcial», como el papel del cobro.
   */
  parcial?: true
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
    /**
     * D41 «C»: Σ de lo regalado en los renglones de cortesía guardados en $0 ([cortesiaEnCeroDe]). No está en `subtotal` ni en
     * `discountAmount`. Ausente (llamador o recibo de antes) = 0, como hoy.
     */
    cortesiaEnCero?: Monto
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

/**
 * El papel de ANDROID guarda los importes en centavos `Int` (`ReceiptData`): $21,474,836.47 como mucho. Encargo 27fd34 (Codex r7 #2): la
 * cortesía en $0 sólo se suma al ticket si el subtotal y el descuento siguen cabiendo ahí.
 */
export const TOPE_DEL_PAPEL_CENTAVOS = 2_147_483_647

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
  // Sólo un cobro de VENTA (COMPLETED, > 0) puede desglosarse o ser una parte: un intento fallido o un registro de sólo propina no.
  // Encargo 27fd34 (Codex r6 #3 de D41): la excepción es la cuenta que no debe nada (toda de cortesía) cerrada con UN cobro de $0 y sin
  // otro cobro de venta: se desglosa como en Mostrador ($20 − $20 = $0). `cobrosDeVenta` no la cuenta (sólo importes > 0). Sin propina
  // (Codex r1 #1): un registro de $0 con propina es sólo propina y su comprobante no repite la venta, aunque ésta se haya cerrado en $0.
  const cierraEnCero = amount.isZero() && tip.isZero() && e.cobrosDeVenta === 0
  if (!o || e.payment.status !== 'COMPLETED' || !(amount.gt(0) || cierraEnCero)) return sinDesglose('COBRO', amount, tip)
  const bruto = aDecimal(o.subtotal)
  const mercanciaBruta = bruto.minus(aDecimal(o.discountAmount))
  const mercancia = mercanciaBruta.isNegative() ? CERO_DEC : mercanciaBruta
  const cargo = aDecimal(o.serviceChargeAmount)
  const impuesto = impuestoQueSeCobraAparte({ contratoDePrecio: o.contratoDePrecio, taxAmount: o.taxAmount, status: o.status })
  const loQueDebe = mercancia.plus(cargo).plus(impuesto)
  // D15: una PARTE de una venta dividida. Una cuenta de $2.01 saldada con $2.00 es venta completa (la tolerancia de `orderBalance`).
  if (e.cobrosDeVenta >= 1 && (e.cobrosDeVenta > 1 || loQueDebe.minus(amount).gt(FULL_PAYMENT_TOLERANCE))) {
    return { ...sinDesglose('COBRO', amount, tip), parcial: true }
  }
  // El cobro consultado tiene que SER el único cobro de venta que se contó (r2 R2-8).
  if (e.cobrosDeVenta !== (cierraEnCero ? 0 : 1) || cargo.isNegative() || !amount.eq(loQueDebe)) return sinDesglose('COBRO', amount, tip)
  // Ronda 1 (A7-R6): la MISMA definición que el papel del cobro (`TotalesDelTicket.desdeLoCobrado`, Android e iOS): el
  // descuento es lo que falta del bruto + cargo + IVA agregado para llegar a lo cobrado; si saliera negativo (subtotal guardado
  // negativo), el subtotal pasa a ser lo cobrado sin cargo ni IVA y no hay descuento. Aquí lo cobrado ES lo que la cuenta debe,
  // así que el descuento es `min(subtotal, descuento guardado)`: una cortesía mayor que el subtotal no descuenta de más.
  const descuento = bruto.plus(cargo).plus(impuesto).minus(amount)
  const subtotalBase = descuento.isNegative() ? amount.minus(cargo).minus(impuesto) : bruto
  const descuentoBase = descuento.isNegative() ? CERO_DEC : descuento
  // D41 «C» (founder, 16-nov; Codex r1 #1): la cortesía que Mesas guardó en $0 vuelve al bruto y al descuento, como la de Mostrador
  // (a precio lleno + su descuento) y como Square («Discounts & Comps» restan del bruto). Se suma DESPUÉS de decidir el desglose: lo
  // que la cuenta debe y el parcial salen de los importes guardados. Suma lo mismo a los dos lados: el total no cambia.
  const cortesiaGuardada = aDecimal(o.cortesiaEnCero)
  // Encargo 27fd34 (Codex r7 #2): si con la cortesía el subtotal o el descuento ya no caben en el papel de ANDROID (centavos en Int), no se
  // suma en ningún lado: el recibo digital y la reimpresión dicen lo mismo, como antes de D41. Caso de más de $21 millones.
  const cabeEnElPapel = (v: Prisma.Decimal) => v.mul(100).lte(TOPE_DEL_PAPEL_CENTAVOS)
  const cortesia =
    cortesiaGuardada.isNegative() ||
    !cabeEnElPapel(subtotalBase.plus(cortesiaGuardada)) ||
    !cabeEnElPapel(descuentoBase.plus(cortesiaGuardada))
      ? CERO_DEC
      : cortesiaGuardada
  const subtotal = subtotalBase.plus(cortesia)
  const discount = descuentoBase.plus(cortesia).toNumber()
  return {
    kind: 'COBRO',
    desglosado: true,
    subtotal: subtotal.toNumber(),
    ...(discount > 0 ? { discount } : {}),
    ...(cortesia.gt(0) ? { cortesia: cortesia.toNumber() } : {}),
    serviceCharge: cargo.toNumber(),
    addedTax: impuesto.toNumber(),
    tip: tip.toNumber(),
    total: amount.plus(tip).toNumber(),
  }
}

/**
 * D41 «C»: un renglón de cortesía guardado en $0 (`isCortesia` y `total` 0: Mesas con «Dar de cortesía», la ronda de la terminal y el
 * `ADD_ITEMS` sin red). Su regalo vive sólo en su `discountAmount`. La cortesía de Mostrador/«Cobrar» queda a precio lleno con su fila
 * de descuento y ya está en `Order.subtotal`/`discountAmount`: no entra. El predicado del reporte de ventas
 * (`HIDDEN_COMP_LINE_WHERE`, `dashboard/salesGiveaways.ts`), sin las piezas de combo.
 */
export const RENGLON_DE_CORTESIA_EN_CERO = { isCortesia: true, total: 0, orderPromotionId: null } as const

type RenglonConCortesia = { isCortesia?: boolean | null; total: Monto; discountAmount: Monto; orderPromotionId?: string | null }

/**
 * Codex r4 #1: una pieza de COMBO dada de cortesía (`orderPromotionId`) no entra: las promociones quedan fuera de este arreglo y su
 * ticket sigue como hoy.
 */
export function esCortesiaEnCero(r: RenglonConCortesia): boolean {
  return r.isCortesia === true && aDecimal(r.total).isZero() && !r.orderPromotionId
}

/** Σ `discountAmount` (lo regalado, nunca negativo) de los renglones de cortesía guardados en $0. */
export function cortesiaEnCeroDe(renglones: readonly RenglonConCortesia[]): Prisma.Decimal {
  return renglones.filter(esCortesiaEnCero).reduce((s, r) => {
    const regalo = aDecimal(r.discountAmount)
    return regalo.isNegative() ? s : s.plus(regalo)
  }, CERO_DEC)
}

/**
 * Lo que pinta el renglón en un comprobante con estos totales: la cortesía en $0, a su bruto sólo si el desglose la sumó al subtotal
 * (`totales.cortesia`); todo lo demás, su `total`. Así los renglones cuadran con el subtotal, como en Mostrador. Sólo es lo que se
 * PINTA: `OrderItem.total` no cambia (lo leen las devoluciones).
 */
export function totalDelRenglonEnElTicket(r: RenglonConCortesia, totales: Pick<TicketTotals, 'cortesia'> | null | undefined): number {
  return totales?.cortesia && esCortesiaEnCero(r) ? Math.max(0, aDecimal(r.discountAmount).toNumber()) : aDecimal(r.total).toNumber()
}

/**
 * D41 «C» (Codex r2 #1): los totales como los leen las apps que no conocen la cortesía en $0 (iOS publicado, ANDROID viejo): sin ella
 * en subtotal ni en descuento, porque sus renglones la pintan en $0 (`total`). Devuelve aparte cuánto era, para la app nueva. Sin
 * `cortesia`, los mismos totales. Lo usa la reimpresión (`getTransactionDetail`); el recibo digital congela los totales con ella.
 */
export function totalesSinLaCortesia(t: TicketTotals | null): { totales: TicketTotals | null; cortesia: number } {
  if (!t?.cortesia || t.cortesia <= 0) return { totales: t, cortesia: 0 }
  const { cortesia, discount, ...resto } = t
  const c = new Prisma.Decimal(String(cortesia))
  const descuento = aDecimal(discount).minus(c)
  return {
    totales: {
      ...resto,
      subtotal: aDecimal(t.subtotal).minus(c).toNumber(),
      ...(descuento.gt(0) ? { discount: descuento.toNumber() } : {}),
    },
    cortesia,
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

/**
 * Una consulta acotada por id: el cobro, los importes de su orden y cuántos cobros de venta tiene. D41 «C»: más, si el cobro puede
 * desglosarse, la suma (en la base) de su cortesía en $0.
 */
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
      orderId: true,
    },
  })
  if (!p) return null
  const entrada: EntradaDelTicket = {
    payment: { amount: p.amount, tipAmount: p.tipAmount, type: p.type, status: p.status },
    order: p.order,
    cobrosDeVenta: p.order?._count.payments ?? 0,
  }
  const sinCortesia = ticketTotals(entrada)
  // D41 «C» (Codex r2 #3, r3 #2 y r4 #2): la cortesía en $0 de ESTA orden se suma en la base (nunca se cargan sus renglones) y SÓLO si
  // la MISMA regla ya desglosó este cobro; un parcial, una devolución o un intento fallido no consultan nada. `discountAmount > 0`, como
  // `cortesiaEnCeroDe`, que ignora negativos.
  if (!sinCortesia.desglosado || !p.order || !p.orderId) return sinCortesia
  const suma = await db.orderItem.aggregate({
    where: { orderId: p.orderId, ...RENGLON_DE_CORTESIA_EN_CERO, discountAmount: { gt: 0 } },
    _sum: { discountAmount: true },
  })
  const cortesiaEnCero = suma?._sum?.discountAmount
  return cortesiaEnCero && aDecimal(cortesiaEnCero).gt(0)
    ? ticketTotals({ ...entrada, order: { ...p.order, cortesiaEnCero } })
    : sinCortesia
}

/**
 * 🔴 La política ÚNICA para reimprimir un cobro (r2 R2-9): si ya se emitió su recibo digital, manda lo que ese recibo dice —el
 * mismo comprobante que vio el cliente, aunque la orden se haya movido después (una sincronización de SoftRestaurant puede
 * reescribir sus importes)—; si no tiene recibo, se calcula con la orden. Una consulta acotada por `paymentId` (el recibo canónico,
 * `reciboCanonicoDelPago`: el más viejo por (createdAt, id), como `generateDigitalReceipt`).
 */
export async function totalesDelComprobante(db: Prisma.TransactionClient | PrismaClient, paymentId: string): Promise<TicketTotals | null> {
  return (await comprobanteDelPago(db, paymentId)).totales
}

/**
 * Lo mismo que `totalesDelComprobante` y, si hay recibo, la orden para la que se emitió (`dataSnapshot.order.id`). La reimpresión lo
 * usa para no mezclar el recibo de una orden con los renglones de otra (un cobro que Soporte movió de orden; Codex r5 y r6 #1 de D41).
 */
export async function comprobanteDelPago(
  db: Prisma.TransactionClient | PrismaClient,
  paymentId: string,
): Promise<{ totales: TicketTotals | null; ordenDelRecibo: string | null | undefined; snapshotDelRecibo?: unknown }> {
  const recibo = await reciboCanonicoDelPago(db, paymentId, { select: { dataSnapshot: true } })
  if (!recibo) return { totales: await cargarTotalesDelTicket(db, paymentId), ordenDelRecibo: undefined }
  const orden = (recibo.dataSnapshot as { order?: { id?: unknown } } | null)?.order?.id
  return {
    totales: ticketTotalsDelSnapshot(recibo.dataSnapshot),
    ordenDelRecibo: typeof orden === 'string' ? orden : null,
    // Encargo 27fd34: la reimpresión de un cobro movido a otra cuenta pinta la fotocopia de este recibo (`fotocopiaDelRecibo`).
    snapshotDelRecibo: recibo.dataSnapshot,
  }
}
