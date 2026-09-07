/**
 * Reasignar un cobro a la orden que de verdad pagó (corrección de datos).
 *
 * ── Qué corrige ─────────────────────────────────────────────────────────────────────────────
 * Entre el 2 y el 5 de septiembre de 2026, cinco cobros con tarjeta hechos desde la terminal
 * quedaron registrados sobre una orden VECINA que ya tenía su propio cobro, mientras la orden
 * del cliente real quedaba CANCELLED o PENDING minutos antes. Nadie pagó dos veces: el dinero
 * entró una vez. Lo que quedó mal son los papeles — una orden «sobrepagada» (y el vigilante de
 * dinero gritando cada hora) y una venta que los reportes muestran como cancelada.
 *
 * Caso semilla (Testarudo, 2-sep 13:40): `ORD-1788377979686` cancelada a las 13:39 por $53.76
 * ($46.75 + $7.01 de propina) y su cobro DEBIT de $46.75 + $7.01 aterrizado a las 13:40:19 en
 * `ORD-1788378009269`, que ya traía su propio cobro por lo mismo.
 *
 * ── Cómo decide ─────────────────────────────────────────────────────────────────────────────
 * `validarReasignacion` es PURA y acumula todos los motivos de rechazo. Usa la MISMA aritmética
 * del saldo que cobran efectivo, tarjeta y vales (`computeOrderBalance`): la cuenta del destino
 * se calcula desde subtotal/descuento/cargo por servicio y la propina la aporta el cobro. Nunca
 * se lee `Order.total` guardado, que en el destino puede traer una propina que el cobro no trajo.
 *
 * ── Cómo aplica ─────────────────────────────────────────────────────────────────────────────
 * `aplicarReasignacion` recibe sus escritores por parámetro (mock-first) y sigue un orden fijo:
 *   1. dentro de UNA transacción: mover el `Payment` (con `updateMany` condicionado a que siga
 *      en el origen y COMPLETED — 0 filas = carrera, y se aborta antes de tocar nada más) y
 *      preparar el destino (CANCELLED → PENDING para que el reconciliador pueda cerrarla; y el
 *      turno del cobro si la orden no tenía).
 *   2. reconciliar el destino y el origen por `reconcileOrderFromPayments`, el MISMO camino del
 *      cobro: él reescribe `tipAmount`/`total`/`paymentStatus`/`status` desde los cobros. No se
 *      duplica esa regla aquí.
 *   3. 🔴 devolver las fechas: reconciliar estampa `completedAt` con la hora de la corrida. El
 *      destino se fecha cuando el cliente PAGÓ (`Payment.createdAt`) y el origen recupera la fecha
 *      de cierre que ya tenía — si no, dos ventas del 2-sep aparecerían cerradas el día del script.
 *   4. bitácora `PAYMENT_REASSIGNED` en las DOS órdenes, con el antes y el después.
 *
 * Lo que NO hace, declarado: no descuenta inventario del destino (reconciliar con un cobro que
 * ya cubre la cuenta no dispara la deducción, a propósito) — si el negocio lleva inventario de
 * esos productos, el ajuste es aparte y el script lo avisa.
 */
import { Prisma } from '@prisma/client'
import {
  computeOrderBalance,
  FULL_PAYMENT_TOLERANCE,
  REFUND_PAYMENT_TYPE,
  type CompletedPaymentForBalance,
  type OrderAmountsForBalance,
} from './orderBalance'

type DecimalLike = Prisma.Decimal | number | string | null | undefined

export interface CasoReasignacion {
  /** `Payment.id` que hoy está en la orden equivocada. */
  paymentId: string
  /** `Order.orderNumber` donde está hoy (candado: si ya no está ahí, no se mueve). */
  deOrden: string
  /** `Order.orderNumber` de la orden que de verdad pagó. */
  aOrden: string
  /** Por qué se cree que es así; va a la bitácora tal cual. */
  motivo: string
}

export interface CobroFoto {
  id: string
  venueId: string
  orderId: string
  status: string
  type: string | null
  amount: DecimalLike
  tipAmount: DecimalLike
  shiftId: string | null
  createdAt: Date
}

export interface CobroDeOrdenFoto extends CompletedPaymentForBalance {
  id: string
  status: string
}

export interface OrdenFoto extends OrderAmountsForBalance {
  id: string
  venueId: string
  orderNumber: string
  status: string
  paymentStatus: string
  shiftId: string | null
  completedAt: Date | null
  /** Cobros COMPLETED de la orden (reembolsos incluidos: el saldo los distingue por `type`). */
  cobros: CobroDeOrdenFoto[]
}

export interface ResumenReasignacion {
  /** Cuenta canónica del destino sin propina (subtotal − descuento + cargo por servicio). */
  baseDestino: string
  /** Lo que trae el cobro: importe + propina. */
  pagoMasPropina: string
  /** Saldo que le quedaría al origen sin este cobro. */
  saldoOrigenDespues: string
  /** true si el destino está CANCELLED y habrá que reabrirla a PENDING para poder cerrarla. */
  destinoCambiaEstado: boolean
}

export type Veredicto = { ok: true; resumen: ResumenReasignacion } | { ok: false; motivos: string[] }

const dec = (v: DecimalLike): Prisma.Decimal => (v == null ? new Prisma.Decimal(0) : new Prisma.Decimal(v.toString()))

const esCobroQueCuenta = (c: CobroDeOrdenFoto): boolean => c.status === 'COMPLETED' && c.type !== REFUND_PAYMENT_TYPE

/** Estados desde los que una orden puede recibir el cobro: nada que ya esté cerrado o pagado. */
const ESTADOS_DESTINO_PERMITIDOS = new Set(['CANCELLED', 'PENDING', 'CONFIRMED'])

export function validarReasignacion(caso: CasoReasignacion, cobro: CobroFoto, origen: OrdenFoto, destino: OrdenFoto): Veredicto {
  const motivos: string[] = []

  if (cobro.status !== 'COMPLETED') motivos.push(`el cobro ${cobro.id} no está COMPLETED (está ${cobro.status})`)
  if (cobro.type === REFUND_PAYMENT_TYPE) motivos.push(`el cobro ${cobro.id} es un reembolso, no un cobro`)
  if (cobro.orderId !== origen.id || origen.orderNumber !== caso.deOrden) {
    motivos.push(`el cobro ya no está en la orden de origen declarada (${caso.deOrden})`)
  }
  if (destino.orderNumber !== caso.aOrden) motivos.push(`el destino cargado (${destino.orderNumber}) no es el del plan (${caso.aOrden})`)
  if (destino.id === origen.id) motivos.push('origen y destino son la misma orden')
  if (cobro.venueId !== origen.venueId || cobro.venueId !== destino.venueId) {
    motivos.push('cobro, origen y destino no son del mismo negocio')
  }

  const cobrosDestino = destino.cobros.filter(esCobroQueCuenta)
  if (cobrosDestino.length > 0) motivos.push(`el destino ya tiene ${cobrosDestino.length} cobro(s) completado(s)`)
  if (destino.paymentStatus === 'PAID' || !ESTADOS_DESTINO_PERMITIDOS.has(destino.status)) {
    motivos.push(`el destino está ${destino.status}/${destino.paymentStatus}: ya está pagada o cerrada`)
  }

  const pagoComoCobro: CompletedPaymentForBalance = { amount: cobro.amount, tipAmount: cobro.tipAmount, type: cobro.type }
  const saldoDestino = computeOrderBalance(destino, [pagoComoCobro])
  const sobra = saldoDestino.paidAmount.minus(saldoDestino.total)
  if (!saldoDestino.isFullyPaid) {
    motivos.push(`el cobro no cubre la cuenta del destino: faltan $${saldoDestino.remainingBalance.toFixed(2)}`)
  } else if (sobra.greaterThan(FULL_PAYMENT_TOLERANCE)) {
    motivos.push(`el cobro sobra en el destino por $${sobra.toFixed(2)}: no es su cuenta`)
  }

  const cobrosOrigenSinEste = origen.cobros.filter(c => c.id !== cobro.id)
  const saldoOrigen = computeOrderBalance(origen, cobrosOrigenSinEste)
  if (!saldoOrigen.isFullyPaid) {
    motivos.push(`el origen quedaría con saldo de $${saldoOrigen.remainingBalance.toFixed(2)} sin este cobro`)
  }

  if (motivos.length > 0) return { ok: false, motivos }

  const baseDestino = saldoDestino.total.minus(saldoDestino.tipAmount)
  return {
    ok: true,
    resumen: {
      baseDestino: baseDestino.toFixed(2),
      pagoMasPropina: dec(cobro.amount).plus(dec(cobro.tipAmount)).toFixed(2),
      saldoOrigenDespues: saldoOrigen.remainingBalance.toFixed(2),
      destinoCambiaEstado: destino.status === 'CANCELLED',
    },
  }
}

export interface EscritorReasignacion {
  /** `updateMany` condicionado: devuelve cuántas filas cambió (1 = bien, 0 = carrera). */
  moverCobro(paymentId: string, deOrdenId: string, aOrdenId: string): Promise<number>
  prepararDestino(ordenId: string, data: { status?: 'PENDING'; shiftId?: string }): Promise<void>
}

export interface BitacoraReasignacion {
  venueId: string
  action: 'PAYMENT_REASSIGNED'
  entity: 'Order'
  entityId: string
  data: Record<string, unknown>
}

export interface DepsAplicar {
  enTransaccion<T>(fn: (escritor: EscritorReasignacion) => Promise<T>): Promise<T>
  /** `reconcileOrderFromPayments`: el mismo cerrador del camino del cobro. */
  reconciliar(orderId: string): Promise<unknown>
  fijarCompletadoEn(orderId: string, cuando: Date): Promise<void>
  bitacora(params: BitacoraReasignacion): Promise<void>
}

export type ResultadoAplicar = { ok: true; resumen: ResumenReasignacion } | { ok: false; motivos: string[] }

export async function aplicarReasignacion(
  deps: DepsAplicar,
  caso: CasoReasignacion,
  cobro: CobroFoto,
  origen: OrdenFoto,
  destino: OrdenFoto,
): Promise<ResultadoAplicar> {
  const veredicto = validarReasignacion(caso, cobro, origen, destino)
  if (!veredicto.ok) return veredicto

  await deps.enTransaccion(async escritor => {
    const movidos = await escritor.moverCobro(cobro.id, origen.id, destino.id)
    if (movidos !== 1) {
      throw new Error(`carrera: el cobro ${cobro.id} ya no estaba en ${origen.orderNumber} al escribir (${movidos} filas)`)
    }
    const data: { status?: 'PENDING'; shiftId?: string } = {}
    if (destino.status === 'CANCELLED') data.status = 'PENDING'
    if (!destino.shiftId && cobro.shiftId) data.shiftId = cobro.shiftId
    if (Object.keys(data).length > 0) await escritor.prepararDestino(destino.id, data)
  })

  await deps.reconciliar(destino.id)
  await deps.reconciliar(origen.id)

  await deps.fijarCompletadoEn(destino.id, cobro.createdAt)
  if (origen.completedAt) await deps.fijarCompletadoEn(origen.id, origen.completedAt)

  const comun = {
    paymentId: cobro.id,
    amount: dec(cobro.amount).toFixed(2),
    tipAmount: dec(cobro.tipAmount).toFixed(2),
    deOrden: origen.orderNumber,
    aOrden: destino.orderNumber,
    motivo: caso.motivo,
    destinoEstadoAntes: `${destino.status}/${destino.paymentStatus}`,
    origenEstadoAntes: `${origen.status}/${origen.paymentStatus}`,
  }
  await deps.bitacora({
    venueId: destino.venueId,
    action: 'PAYMENT_REASSIGNED',
    entity: 'Order',
    entityId: destino.id,
    data: { ...comun, papel: 'destino' },
  })
  await deps.bitacora({
    venueId: origen.venueId,
    action: 'PAYMENT_REASSIGNED',
    entity: 'Order',
    entityId: origen.id,
    data: { ...comun, papel: 'origen' },
  })

  return veredicto
}
