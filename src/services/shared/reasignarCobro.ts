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
 * `aplicarReasignacion` recibe su escritor por parámetro (mock-first) y hace TODO en UNA transacción,
 * con un orden fijo (Codex r10 #6: un fallo a medias ya no deja el cobro movido sin totales ni sin rastro):
 *   1. el candado de las dos órdenes (en orden de id) y releerlas con el cobro: la validación que MANDA
 *      corre otra vez sobre lo releído (Codex r11 #7); la de afuera sólo es vista previa.
 *   2. mover el `Payment` (con `updateMany` condicionado a que siga en el origen y COMPLETED — 0 filas =
 *      carrera, y se aborta) y preparar el destino: una cancelada se reabre a PENDING con la regla de la
 *      Tarea 6a (`estadoAlRecibirDinero`, la MISMA con que la validación la midió), y el turno del cobro
 *      si la orden no tenía.
 *   3. guardar los totales de las dos con `settleStandalonePaymentInTx`, el cierre transaccional del cobro
 *      de la terminal: el destino con sus efectos de saldar (vale de inventario, lealtad) cuando el cierre
 *      del cobro es su dueño (`cierreDelCobroSaldaLaCuenta`, el criterio de `recordOrderPayment`; una
 *      integrada o con vales por área sólo guarda totales y el script avisa que el inventario va aparte);
 *      el origen, que ya los tuvo cuando se saldó, sólo sus totales. No se duplica esa regla aquí.
 *   4. 🔴 devolver las fechas: el cierre estampa `completedAt` con la hora de la corrida. El destino se
 *      fecha cuando el cliente PAGÓ (`Payment.createdAt`) y el origen recupera la fecha de cierre que ya
 *      tenía — si no, dos ventas del 2-sep aparecerían cerradas el día del script.
 *   5. bitácora `PAYMENT_REASSIGNED` en las DOS órdenes, con el antes y el después, con el mismo `tx`.
 * Después del commit, la mesa del destino se libera si ya no tiene cuentas vivas (`releaseTableIfSettled`).
 */
import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import {
  cierreDelCobroSaldaLaCuenta,
  computeOrderBalance,
  estadoAlRecibirDinero,
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
  /** Quién salda la cuenta (`cierreDelCobroSaldaLaCuenta`): integrada (POS con `externalId`) o con vales por área. */
  source: string
  externalId: string | null
  items: Array<{ areaTicketLineId: string | null }>
  /** La mesa que se libera al saldar (Tarea 6d, M-1). */
  tableId: string | null
  /** Cobros COMPLETED de la orden (reembolsos incluidos: el saldo los distingue por `type`). */
  cobros: CobroDeOrdenFoto[]
}

export interface ResumenReasignacion {
  /** Cuenta canónica del destino sin propina (subtotal − descuento + IVA que va aparte (P12) + cargo por servicio). */
  baseDestino: string
  /** Lo que trae el cobro: importe + propina. */
  pagoMasPropina: string
  /** Saldo que le quedaría al origen sin este cobro. */
  saldoOrigenDespues: string
  /** true si el destino está CANCELLED y habrá que reabrirla a PENDING para poder cerrarla. */
  destinoCambiaEstado: boolean
  /**
   * Tarea 6d, I-1: false ⇒ el destino es una integrada o una cuenta con vales por área: sólo se guardan sus totales, sin vale de
   * inventario ni lealtad (su dueño del cierre es otro), y el operador tiene que ajustar el inventario aparte.
   */
  destinoConEfectosDeCierre: boolean
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
  // Codex r6 #1 / founder 3-oct: una cancelada no debe IVA (P12); medir el destino CANCELADO aceptaba $100 sobre una cuenta de
  // $100 + $16 aparte —que reabierta quedaba debiendo $16— y rechazaba los $116 correctos. Se mide como se va a reconciliar: el
  // cobro que se mueve ya está capturado y reabre la cancelada (`estadoAlRecibirDinero`, la misma regla de la Tarea 6a). La
  // regla de estados permitidos sigue leyendo el estado de HOY. Revisión 6d M-2: lo que reabre es importe + propina, lo mismo
  // que suma el cierre (`settleStandalonePaymentInTx` → `reabrirSiRecibeDinero`).
  const destinoAlReconciliar = {
    ...destino,
    status: estadoAlRecibirDinero(destino.status, dec(pagoComoCobro.amount).plus(dec(pagoComoCobro.tipAmount))),
  }
  const saldoDestino = computeOrderBalance(destinoAlReconciliar, [pagoComoCobro])
  const sobra = saldoDestino.paidAmount.minus(saldoDestino.total)
  if (!saldoDestino.isFullyPaid) {
    motivos.push(`el cobro no cubre la cuenta del destino: faltan $${saldoDestino.remainingBalance.toFixed(2)}`)
  } else if (sobra.greaterThan(FULL_PAYMENT_TOLERANCE)) {
    motivos.push(`el cobro sobra en el destino por $${sobra.toFixed(2)}: no es su cuenta`)
  }

  const cobrosOrigenSinEste = origen.cobros.filter(c => c.id !== cobro.id)
  // Revisión 6d M-4: el origen también se mide con el estado con que el cierre lo guardará. Uno CANCELADO que conserva otros
  // cobros se reabre al guardar sus totales y vuelve a deber su IVA aparte; medido cancelado se daba por cubierto y quedaba PARCIAL.
  const origenConserva = cobrosOrigenSinEste
    .filter(esCobroQueCuenta)
    .reduce((total, c) => total.plus(dec(c.amount)).plus(dec(c.tipAmount)), new Prisma.Decimal(0))
  const saldoOrigen = computeOrderBalance({ ...origen, status: estadoAlRecibirDinero(origen.status, origenConserva) }, cobrosOrigenSinEste)
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
      // M-5: la misma cantidad y la misma regla que la reapertura de `aplicarReasignacion`, que lee ESTE campo.
      destinoCambiaEstado: destinoAlReconciliar.status !== destino.status,
      // I-1: el mismo dueño del cierre que en `recordOrderPayment`.
      destinoConEfectosDeCierre: cierreDelCobroSaldaLaCuenta(destino),
    },
  }
}

/** Las fotos que la reasignación lee: afuera (vista previa) y otra vez bajo el candado (Codex r11 #7). */
export interface FotosReasignacion {
  cobro: CobroFoto
  origen: OrdenFoto
  destino: OrdenFoto
}

export interface BitacoraReasignacion {
  venueId: string
  action: 'PAYMENT_REASSIGNED'
  entity: 'Order'
  entityId: string
  data: Record<string, unknown>
}

/** Todo lo que escribe la reasignación, sobre el `tx` de UNA transacción (Codex r10 #6). */
export interface EscritorReasignacion {
  /** El candado de las órdenes, en el orden recibido (lanza si alguna ya no es del negocio). */
  bloquear(ordenIds: string[]): Promise<void>
  /** Relee cobro, origen y destino con el `tx`; las fotos de afuera sólo dicen qué ids releer. */
  releer(antes: FotosReasignacion): Promise<FotosReasignacion>
  /** `updateMany` condicionado: devuelve cuántas filas cambió (1 = bien, 0 = carrera). */
  moverCobro(paymentId: string, deOrdenId: string, aOrdenId: string): Promise<number>
  prepararDestino(ordenId: string, data: { status?: 'PENDING'; shiftId?: string }): Promise<void>
  /**
   * Los totales finales de la cuenta desde sus cobros (`settleStandalonePaymentInTx`). Con `cobro`: el que la salda, con sus
   * efectos de saldar. Con `null`: sólo los totales (el origen ya los tuvo cuando se saldó).
   */
  guardarTotales(
    ordenId: string,
    cobro: { id: string; amount: DecimalLike; tipAmount: DecimalLike } | null,
    /** Con los efectos de saldar (`settleStandalonePaymentInTx(…, efectosDeCierre)`). */
    conEfectos: boolean,
  ): Promise<void>
  fijarCompletadoEn(ordenId: string, cuando: Date): Promise<void>
  bitacora(params: BitacoraReasignacion): Promise<void>
}

export interface DepsAplicar {
  enTransaccion<T>(fn: (escritor: EscritorReasignacion) => Promise<T>): Promise<T>
  /** `releaseTableIfSettled` tras el commit (M-1): bookkeeping del plano, nunca tumba la reasignación. */
  liberarMesa(venueId: string, tableId: string): Promise<unknown>
}

export type ResultadoAplicar = { ok: true; resumen: ResumenReasignacion } | { ok: false; motivos: string[] }

export async function aplicarReasignacion(
  deps: DepsAplicar,
  caso: CasoReasignacion,
  cobro: CobroFoto,
  origen: OrdenFoto,
  destino: OrdenFoto,
): Promise<ResultadoAplicar> {
  // La validación de afuera queda como vista previa: falla rápido sin abrir una transacción.
  const previa = validarReasignacion(caso, cobro, origen, destino)
  if (!previa.ok) return previa

  // Codex r10 #6: mover, reabrir, guardar los totales de las dos cuentas, fechas y bitácoras en UNA transacción, bajo el candado de
  // las dos órdenes (en orden de id: sin interbloqueo). Un fallo en cualquier paso no deja el cobro movido sin totales ni sin rastro.
  const hecho = await deps.enTransaccion(async escritor => {
    await escritor.bloquear([origen.id, destino.id].sort())
    // Codex r11 #7: la validación que MANDA es ésta, con lo releído bajo el candado. La foto de afuera pudo envejecer: otro caso del
    // mismo plan movió un cobro del mismo origen (el script carga todos los casos antes de aplicar), o alguien cobró el destino.
    const ahora = await escritor.releer({ cobro, origen, destino })
    const veredicto = validarReasignacion(caso, ahora.cobro, ahora.origen, ahora.destino)
    if (!veredicto.ok) return { veredicto, mesa: null }
    // De aquí en adelante, lo releído: estado, turno y `completedAt` frescos.
    const { cobro: c, origen: o, destino: d } = ahora

    const movidos = await escritor.moverCobro(c.id, o.id, d.id)
    if (movidos !== 1) {
      throw new Error(`carrera: el cobro ${c.id} ya no estaba en ${o.orderNumber} al escribir (${movidos} filas)`)
    }
    const data: { status?: 'PENDING'; shiftId?: string } = {}
    // La misma regla de la Tarea 6a: el cobro que se mueve ya está recibido y reabre la cancelada (de cualquier origen: es una
    // decisión explícita de una persona sobre un cobro concreto, no dinero que llega solo). Se lee de la validación (M-5): la
    // misma cantidad —importe + propina— con que midió el destino, así que no pueden divergir.
    if (veredicto.resumen.destinoCambiaEstado) data.status = 'PENDING'
    if (!d.shiftId && c.shiftId) data.shiftId = c.shiftId
    if (Object.keys(data).length > 0) await escritor.prepararDestino(d.id, data)

    // El destino se cierra con sus efectos de saldar (vale de inventario, lealtad) SÓLO si es su dueño del cierre (revisión 6d
    // I-1: una integrada o con vales por área, no — su vale lo haría otro camino o ya consumió el stock); el origen ya estaba
    // saldado: sólo sus totales.
    await escritor.guardarTotales(d.id, { id: c.id, amount: c.amount, tipAmount: c.tipAmount }, veredicto.resumen.destinoConEfectosDeCierre)
    await escritor.guardarTotales(o.id, null, false)

    // 🔴 Las fechas: el cierre estampa `completedAt` con la hora de la corrida. El destino se fecha cuando el cliente PAGÓ y el
    // origen recupera la fecha de cierre que ya tenía.
    await escritor.fijarCompletadoEn(d.id, c.createdAt)
    if (o.completedAt) await escritor.fijarCompletadoEn(o.id, o.completedAt)

    const comun = {
      paymentId: c.id,
      amount: dec(c.amount).toFixed(2),
      tipAmount: dec(c.tipAmount).toFixed(2),
      deOrden: o.orderNumber,
      aOrden: d.orderNumber,
      motivo: caso.motivo,
      destinoEstadoAntes: `${d.status}/${d.paymentStatus}`,
      origenEstadoAntes: `${o.status}/${o.paymentStatus}`,
    }
    await escritor.bitacora({
      venueId: d.venueId,
      action: 'PAYMENT_REASSIGNED',
      entity: 'Order',
      entityId: d.id,
      data: { ...comun, papel: 'destino' },
    })
    await escritor.bitacora({
      venueId: o.venueId,
      action: 'PAYMENT_REASSIGNED',
      entity: 'Order',
      entityId: o.id,
      data: { ...comun, papel: 'origen' },
    })
    return { veredicto, mesa: d.tableId }
  })

  // Revisión 6d M-1: la mesa del destino se libera DESPUÉS del commit, como al saldar un cobro (`releaseTableIfSettled`). Es
  // bookkeeping del plano: si falla, la reasignación ya está hecha y no se revierte.
  if (hecho.veredicto.ok && hecho.mesa) {
    try {
      await deps.liberarMesa(destino.venueId, hecho.mesa)
    } catch (error) {
      logger.error('⚠️ [Reasignación] No se pudo liberar la mesa del destino (la reasignación NO se ve afectada)', {
        venueId: destino.venueId,
        orderId: destino.id,
        tableId: hecho.mesa,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return hecho.veredicto
}
