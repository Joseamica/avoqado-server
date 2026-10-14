/**
 * IVA por producto · F6 (hallazgo #6 de la QA del IVA; decisión del founder del 12-oct): facturar desde Pedidos (STAFF_B) una venta que ya
 * tuvo devoluciones.
 *  1. Devolución TOTAL ⇒ no se factura («Esta venta se devolvió completa»): ni PAC ni reserva.
 *  2. Sólo devoluciones de ARTÍCULOS completos ⇒ la factura sale con lo que el cliente se quedó, por lo que pagó (los remanentes de C3).
 *  3. Por IMPORTE suelto, parte de un artículo, o la mezcla ⇒ la factura por el total y la nota de crédito de cada devolución, emitida sola,
 *     en ORDEN FISCAL (R1): reparto fijo primero (artículos, entregas), importes después.
 * La autofactura con devolución sigue detenida (A7-R10); la sustitución no decide (conserva o hereda lo de su original); lo que llega DESPUÉS
 * de facturar va como hoy (nota manual). Aquí: lo puro (Tarea 1), la decisión bajo el candado (Tarea 3), la nota cancelada y las notas
 * automáticas (Tarea 6), y las facturas con notas pendientes (Tarea 7).
 */
import { Prisma } from '@prisma/client'
import logger from '../../config/logger'
import AppError from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { utcTs } from '../../utils/sqlDates'
import {
  creditNoteIdempotencyKey,
  emitRefundCreditNote,
  esDevolucionPorImporte,
  EVIDENCIA_DE_DEVOLUCION,
  refundedItemsDe,
} from './cfdiCreditNote.service'
import { ORDER_SELECT, ticketParaGlobal } from './cfdiGlobal.service'
import { facturaDeRemanentes } from './cfdiExtraccion.service'
import { repartoCongeladoDeAjuste } from './deliveryFiscalDelta'
import { filasDeDescuentoCompletas } from './filasDeDescuentoTx'
import { TOPES_POR_ORDEN } from './librosDeOrdenes'
import { conceptosRemanentes } from './nominativaPorExtraccion'
import { MOTIVO_OCHO_SIN_REGLA } from './reglaDelPac'
import { REDONDEO_PERMITIDO_CENTS, TRATAMIENTOS_DE_NOTA, type TratamientoDeNota } from './saldoFiscal'
import { conceptoDeReal, montoComercialCents, type ConceptoReal, type OrdenGlobalV2 } from './globalPorTratamiento'
import type { EntradaDocumentalV1 } from './entradaDocumental'
import { folioDe, type IssueReceptor, type LoadedOrderBundle } from './cfdi.service'
import { textoDeTimbreEnDuda, timbreEnDuda } from './timbreEnDuda'
import { conLimiteDeTiempo } from './finalizadorCfdi'

/** Más devoluciones de las que una orden admite (`TOPES_POR_ORDEN.movimientos`): no se revisan a medias. */
export const MOTIVO_DEMASIADAS_DEVOLUCIONES =
  'Esta venta tiene más devoluciones de las que se pueden revisar desde aquí; factúrala con tu contador.'
/** R2: una devolución cuyos artículos (o reparto de entrega) no se leen: su nota nunca saldría. Se detiene ANTES de timbrar el ingreso. */
export const motivoDevolucionIlegible = (cents: number) =>
  `La devolución${Number.isFinite(cents) ? ` de $${(cents / 100).toFixed(2)}` : ''} de esta venta registra artículos que no se pueden leer o que no suman lo devuelto, así que su nota de crédito no podría salir. No se facturó: pide a soporte que corrija esa devolución.`

export type TipoDeDevolucion = 'ARTICULOS' | 'ENTREGA' | 'IMPORTE' | 'ILEGIBLE'
/**
 * Un reembolso COMPLETED de la venta en centavos POSITIVOS de venta (la propina nunca entra: nunca estuvo en la factura). `ARTICULOS` y
 * `ENTREGA` tienen reparto fijo; `IMPORTE` se reparte sobre lo que quede; `ILEGIBLE` detiene la venta. `articulos` sólo con `ARTICULOS`.
 */
export type DevolucionFiscal = {
  id: string
  salesRefundCents: number
  tipo: TipoDeDevolucion
  articulos: Array<{ orderItemId: string; amountCents: number }> | null
}
/** Lo que toma la factura del caso 2: los productos que quedan, las filas D16 del ticket y lo que se factura de cada tasa. */
export type BaseDeRemanentes = { remanentes: ConceptoReal[]; filasD16: string[][]; bruto: Partial<Record<TratamientoDeNota, number>> }
export type RutaConDevolucion =
  | { caso: 'SIN_DEVOLUCION' }
  | { caso: 'TOTAL' }
  | { caso: 'DETENIDA'; motivo: string }
  | { caso: 'CON_NOTA'; pagos: string[] }
  | { caso: 'PROBAR_REMANENTES'; pagos: string[] }

const centavos = (d: unknown) => Math.round(Number(d ?? 0) * 100)

/**
 * Un `Payment` REFUND como lo guardan la TPV, el dashboard y la conciliación de entregas (importe NEGATIVO). Clasificado con la MISMA lectura
 * que C2 usará para su nota: un ajuste de entrega con reparto legible es `ENTREGA` (y con reparto ilegible, `ILEGIBLE`); sin artículos,
 * `IMPORTE`; con artículos, `ARTICULOS` sólo si TODOS se leen (artículo y centavos enteros ≥ 0) y suman exactamente lo devuelto — si no,
 * `ILEGIBLE` (R2: C2 respondería `ARTICULOS_NO_CUADRAN`, y «por importe» no se permite para ese motivo).
 */
export function leerDevolucion(p: { id: string; amount: unknown; processorData: unknown }): DevolucionFiscal {
  const salesRefundCents = Math.abs(centavos(p.amount))
  const base = { id: p.id, salesRefundCents, articulos: null }
  if (!Number.isFinite(salesRefundCents)) return { ...base, tipo: 'ILEGIBLE' } // T1-2: un importe que no se lee falla cerrado (R2)
  const congelado = repartoCongeladoDeAjuste(p.processorData, salesRefundCents)
  if (congelado === 'INVALIDO') return { ...base, tipo: 'ILEGIBLE' }
  if (congelado) return { ...base, tipo: 'ENTREGA' }
  if (esDevolucionPorImporte(p.processorData, salesRefundCents)) return { ...base, tipo: 'IMPORTE' }
  const items = refundedItemsDe(p.processorData)
  const legibles =
    items.every(x => x.orderItemId.length > 0 && Number.isInteger(x.amountCents) && x.amountCents >= 0) &&
    items.reduce((s, x) => s + x.amountCents, 0) === salesRefundCents
  if (!legibles) return { ...base, tipo: 'ILEGIBLE' }
  return { ...base, tipo: 'ARTICULOS', articulos: items.map(x => ({ orderItemId: x.orderItemId, amountCents: x.amountCents })) }
}

/**
 * Decisión 1, LA regla de «devuelta completa»: lo devuelto (venta, sin propina) cubre lo cobrado. La usan la ruta de arriba y el panel del
 * reembolso de C2 (D1 del /full-testing: sin factura, decir que la venta ya no se factura). Sin devoluciones, nunca.
 */
export const devueltaCompleta = (paidCents: number, devoluciones: DevolucionFiscal[]): boolean =>
  devoluciones.length > 0 && devoluciones.reduce((s, d) => s + d.salesRefundCents, 0) >= paidCents

/**
 * El camino de la venta con lo que ya se sabe sin leer sus conceptos, en este orden: el tope; sin devoluciones, como hoy; lo devuelto cubre
 * lo cobrado ⇒ TOTAL (decisión 1: gana sobre todo lo demás); una ilegible ⇒ se detiene (R2); 8 % ⇒ se detiene; IVA aparte (Ruling T3-a),
 * motivos de la venta o alguna devolución que no es por artículos (decisión 3 y la mezcla) ⇒ por el total con su nota; sólo artículos ⇒ se
 * prueban los remanentes. 🔴 R1: los pagos salen en ORDEN FISCAL —reparto fijo primero, importes después, cada grupo en el orden en que
 * ocurrió (`devoluciones` llega por `createdAt`, `id`)—; ese orden se congela en la factura y lo respetan la emisión, el job y la guarda manual.
 */
export function rutaConDevolucion(
  venta: { paidCents: number; tratamientos: readonly string[]; ivaAparte: boolean; conMotivos: boolean },
  devoluciones: DevolucionFiscal[] | null,
): RutaConDevolucion {
  if (devoluciones === null) return { caso: 'DETENIDA', motivo: MOTIVO_DEMASIADAS_DEVOLUCIONES }
  if (!devoluciones.length) return { caso: 'SIN_DEVOLUCION' }
  if (devueltaCompleta(venta.paidCents, devoluciones)) return { caso: 'TOTAL' }
  const ilegible = devoluciones.find(d => d.tipo === 'ILEGIBLE')
  if (ilegible) return { caso: 'DETENIDA', motivo: motivoDevolucionIlegible(ilegible.salesRefundCents) }
  if (venta.tratamientos.includes('IVA_8')) return { caso: 'DETENIDA', motivo: MOTIVO_OCHO_SIN_REGLA }
  const pagos = [...devoluciones.filter(d => d.tipo !== 'IMPORTE'), ...devoluciones.filter(d => d.tipo === 'IMPORTE')].map(d => d.id)
  if (venta.ivaAparte || venta.conMotivos || devoluciones.some(d => d.tipo !== 'ARTICULOS')) return { caso: 'CON_NOTA', pagos }
  return { caso: 'PROBAR_REMANENTES', pagos }
}

/**
 * Decisión 2 con la pieza de C3: lo que queda de la venta, artículo por artículo (`conceptosRemanentes`: un artículo sale sólo si se devolvió
 * COMPLETO en su tratamiento, con la tolerancia M7), sobre los conceptos reales que congelaría la global (C1) y lo cobrado de cada tasa.
 * `'TOTAL'` si ya no queda ningún producto (todos devueltos completos aunque lo devuelto quede centavos abajo); `null` si no se puede probar
 * (sin conceptos reales, una devolución que no es por artículos, un artículo ajeno a la venta, devuelto en parte, o una tasa negativa) ⇒ caso 3.
 * `bruto` (lo que se factura de cada tasa) = el monto comercial de los conceptos que quedan en ella; una tasa sin remanentes no aparece.
 */
export function remanentesDeLaVenta(
  ticket: Pick<OrdenGlobalV2, 'conceptosReales' | 'porTratamiento' | 'filasD16' | 'renglones'>,
  devoluciones: DevolucionFiscal[],
): BaseDeRemanentes | 'TOTAL' | null {
  if (!ticket.conceptosReales?.length) return null
  const tratamientoDe = new Map(ticket.renglones.map(r => [r.orderItemId, r.tratamiento as string]))
  const porRenglon = new Map<string, Partial<Record<TratamientoDeNota, number>>>()
  const devuelto: Partial<Record<TratamientoDeNota, number>> = {}
  for (const d of devoluciones) {
    if (d.tipo !== 'ARTICULOS' || !d.articulos) return null
    for (const a of d.articulos) {
      if (a.amountCents === 0) continue // una cortesía devuelta no acredita nada (C2, ronda 1 I-1)
      const t = tratamientoDe.get(a.orderItemId)
      if (!t || !(TRATAMIENTOS_DE_NOTA as readonly string[]).includes(t)) return null
      const tn = t as TratamientoDeNota
      const m = porRenglon.get(a.orderItemId) ?? {}
      m[tn] = (m[tn] ?? 0) + a.amountCents
      porRenglon.set(a.orderItemId, m)
      devuelto[tn] = (devuelto[tn] ?? 0) + a.amountCents
    }
  }
  const cobrado = ticket.porTratamiento as Partial<Record<TratamientoDeNota, number>>
  const rem = conceptosRemanentes(ticket.conceptosReales, { porRenglon, sinTrazaPorArticulo: false }, cobrado, ticket.filasD16)
  if ('motivo' in rem) return null
  if (!rem.reales.length) return 'TOTAL'
  // T1-a: lo que se factura de cada tasa es lo comercial de los conceptos que DE VERDAD quedan en ella (la barrera N3 de la factura exige
  // eso), no `cobrado − devuelto`: con la tolerancia M7 esa resta deja 1 ¢ «fantasma» en una tasa que ya no tiene ningún concepto.
  const bruto: Partial<Record<TratamientoDeNota, number>> = {}
  for (const t of TRATAMIENTOS_DE_NOTA) {
    if ((cobrado[t] ?? 0) - (devuelto[t] ?? 0) < 0) return null
    const queda = montoComercialCents(rem.reales.filter(r => r.tratamiento === t).map(conceptoDeReal))
    if (queda > 0) bruto[t] = queda
  }
  return { remanentes: rem.reales, filasD16: ticket.filasD16, bruto }
}

export type FacturaConDevolucion =
  | { caso: 'SIN_DEVOLUCION' }
  | { caso: 'TOTAL' }
  | { caso: 'DETENIDA'; motivo: string }
  | { caso: 'CON_NOTA'; pagos: string[] }
  | { caso: 'DESCONTADAS'; entrada: EntradaDocumentalV1; reasons: string[] }

/**
 * Las devoluciones de la venta que tocan la factura (REFUND COMPLETED con venta > 0: una sólo de propina nunca estuvo en ella), en el orden en
 * que ocurrieron, con la transacción que ya tiene la orden `FOR UPDATE`. R9: del JSON sólo la evidencia que leen F6 y C2
 * (`EVIDENCIA_DE_DEVOLUCION`). Acotada al tope de movimientos de una orden; `null` si lo pasa (no se revisa a medias).
 */
export async function devolucionesFiscales(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  venueId: string,
  orderId: string,
): Promise<DevolucionFiscal[] | null> {
  const filas = await db.$queryRaw<Array<{ id: string; amount: unknown; processorData: unknown }>>`
    SELECT id, amount, ${EVIDENCIA_DE_DEVOLUCION} AS "processorData"
    FROM "Payment"
    WHERE "venueId" = ${venueId} AND "orderId" = ${orderId} AND type = 'REFUND' AND status = 'COMPLETED'
    ORDER BY "createdAt" ASC, id ASC
    LIMIT ${TOPES_POR_ORDEN.movimientos + 1}`
  if (filas.length > TOPES_POR_ORDEN.movimientos) return null
  // T1-2: `!(… <= 0)` y no `> 0`: una de importe ilegible (NaN) se queda y detiene la venta; sólo se descartan las de venta 0 (propina).
  return filas.map(leerDevolucion).filter(d => !(d.salesRefundCents <= 0))
}

/**
 * F6: qué factura sale de una venta con devoluciones, decidido DENTRO de la transacción de la admisión, después de su `FOR UPDATE` de la
 * orden (el mismo candado que toma toda devolución): una devolución que llega antes se ve; una que llega después de la reserva es de una
 * venta ya facturada (nota manual, como hoy). Caso 2: los conceptos reales con la MISMA foto que congelaría la global (C1 → C3) y la factura de
 * los remanentes; si no se pueden probar o facturar, caso 3 (nunca se adivina). Sólo lo llama la rama ordinaria de `capture()` en una emisión
 * nueva del personal (ni la autofactura, ni la sustitución, ni un ticket en una global viva).
 * Los motivos de C3 que hablan de «la factura global» (remanentes no trazables, sin conceptos reales, no concuerda) nunca llegan al dueño
 * desde aquí: sin remanentes probados la venta va por el total con su nota (sólo al log); en `DESCONTADAS` los motivos son de validación.
 */
export async function facturaConDevolucion(
  tx: Prisma.TransactionClient,
  params: { orderId: string; receptor: IssueReceptor },
  bundle: LoadedOrderBundle,
): Promise<FacturaConDevolucion> {
  if (typeof bundle.paidCents !== 'number') return { caso: 'SIN_DEVOLUCION' } // `capturarEntrada` falla cerrado sin él
  const devoluciones = await devolucionesFiscales(tx, bundle.venueId, params.orderId)
  const ruta = rutaConDevolucion(
    {
      paidCents: bundle.paidCents,
      tratamientos: (bundle.order.renglonesOrigen ?? []).map(r => r.tratamiento),
      ivaAparte: bundle.order.contratoDePrecio === 'IVA_APARTE' || bundle.order.pricesIncludeIva !== true,
      conMotivos: !!bundle.unsupportedReasons?.length,
    },
    devoluciones,
  )
  if (ruta.caso !== 'PROBAR_REMANENTES') return ruta
  const o = await tx.order.findUnique({ where: { id: params.orderId }, select: ORDER_SELECT })
  const ticket = o ? ticketParaGlobal({ ...o, orderDiscounts: await filasDeDescuentoCompletas(tx, o.id, o.orderDiscounts) }) : null
  const base = ticket?.ok ? remanentesDeLaVenta(ticket.orden, devoluciones!) : null
  if (base === 'TOTAL') return { caso: 'TOTAL' }
  const f = base ? facturaDeRemanentes(params, bundle, base) : null
  if (!f?.entrada) {
    logger.info('[cfdi-f6] los productos que quedan no se pueden probar; la venta va por el total con su nota', {
      orderId: params.orderId,
      porQue: f?.reasons ?? (ticket && !ticket.ok ? ticket.motivo : (ticket?.motivoReales ?? 'remanentes no trazables')),
    })
    return { caso: 'CON_NOTA', pagos: ruta.pagos }
  }
  // Ruling M7 (controlador): la factura sale por lo comercial de lo que quedó; lo que difiera de lo cobrado menos lo devuelto (el ajuste del
  // PAC que, en el documento completo, caía en un producto que queda) se REGISTRA como redondeo, sin repartirlo en ningún concepto.
  const devuelto = devoluciones!.reduce((s, d) => s + d.salesRefundCents, 0)
  const redondeoCents = bundle.paidCents - devuelto - f.entrada.montos.totalCents
  // I-1 (revisión final): aquí no hay barrera B3a ni concordancia (sin extracción); lo único que acota es este tope. Una factura ARRIBA de lo
  // que el cliente se quedó (redondeo < 0: el ajuste del PAC cayó en el artículo devuelto) o un redondeo mayor al del PAC ⇒ por el total con
  // su nota (B3a aplica y C2 acredita exacto).
  if (redondeoCents < 0 || redondeoCents > REDONDEO_PERMITIDO_CENTS) {
    logger.warn('[cfdi-f6] la factura neta no cuadra con lo que el cliente se quedó; la venta va por el total con su nota', {
      orderId: params.orderId,
      redondeoCents,
    })
    return { caso: 'CON_NOTA', pagos: ruta.pagos }
  }
  const marca = { modo: 'DESCONTADAS' as const, pagos: ruta.pagos, ...(redondeoCents ? { redondeoCents } : {}) }
  return { caso: 'DESCONTADAS', entrada: { ...f.entrada, devoluciones: marca }, reasons: f.reasons }
}

/** F6 (R3): una devolución sólo admite una nota (`cfdi-refund-<pago>`); si la que tuvo se canceló, la factura nueva no podría acreditarla. */
export const motivoNotaCancelada = (folio: string) =>
  `La nota de crédito ${folio} de una devolución de esta venta se canceló, y una devolución sólo admite una nota: la factura nueva quedaría por el total sin poder acreditarla. No se facturó; pide a soporte que facture esta venta.`

/** F6 (R3): ¿alguna devolución de la marca ya tuvo su nota y se CANCELÓ? Una sola consulta (`findFirst`), por las llaves de la marca. */
export async function motivoDeNotaCancelada(db: Pick<Prisma.TransactionClient, 'cfdi'>, pagos: string[]): Promise<string | null> {
  const n = await db.cfdi.findFirst({
    where: {
      idempotencyKey: { in: pagos.map(creditNoteIdempotencyKey) },
      OR: [{ status: 'CANCELLED' }, { cancelStatus: { in: ['ACCEPTED', 'CANCELLED'] } }],
    },
    select: { serie: true, folio: true, uuid: true },
  })
  return n ? motivoNotaCancelada(folioDe(n)) : null
}

/** F6: lo que pasó con la nota automática de un reembolso. */
export type NotaDeDevolucion = { refundPaymentId: string; status: 'STAMPED' | 'PENDIENTE'; folio?: string; motivo?: string }
export const MOTIVO_NOTA_PENDIENTE = 'La nota de crédito de esta devolución no salió.'
/** Sin presupuesto para empezarla; la conciliación la intenta en su siguiente pasada. */
export const MOTIVO_NOTA_SIN_INTENTAR = 'Todavía no se intentó: la conciliación la intenta en unos minutos.'
/** N4: no contestó a tiempo. Sigue su curso con su identidad; la conciliación la consulta por ella (nunca la reenvía). */
export const MOTIVO_NOTA_SIN_RESPUESTA =
  'No hubo respuesta a tiempo; la conciliación la consulta por su identidad (nunca la vuelve a enviar).'
/** R3: una nota timbrada que no es de esta factura no la cumple. */
export const motivoNotaDeOtraFactura = (folio: string) =>
  `La nota ${folio} de esta devolución está relacionada con otra factura; revísala con soporte.`

/**
 * F6 (decisión 3): la nota de crédito de cada reembolso, EN EL ORDEN RECIBIDO (el fiscal: R1), con `emitRefundCreditNote` —idempotente por
 * `cfdi-refund-<pago>`: una timbrada se devuelve, una enviada y en duda se consulta al PAC, nunca se reenvía—; el orden lo hace valer también el
 * servicio (`ESPERA_NOTA_DE_ARTICULOS`). N4: CADA nota va con `conLimiteDeTiempo` y el tiempo que quede: si vence, queda pendiente, el bucle
 * PARA (las demás quedan sin intentar) y la que no contestó sigue sola con su identidad —su envío, si salió, lo recupera la conciliación—. R3:
 * una nota cuenta como hecha sólo si está timbrada contra ESTA factura. Nunca lanza: la factura ya está timbrada.
 */
export async function emitirNotasDeDevolucion(
  factura: { id: string; venueId: string },
  pagos: string[],
  p: { sandbox: boolean; staffId: string | null; presupuestoMs: number },
  emitir: typeof emitRefundCreditNote = emitRefundCreditNote,
): Promise<NotaDeDevolucion[]> {
  const inicio = Date.now()
  const out: NotaDeDevolucion[] = []
  let detenido = false
  for (const refundPaymentId of pagos) {
    const restante = p.presupuestoMs - (Date.now() - inicio)
    if (detenido || restante <= 0) {
      out.push({ refundPaymentId, status: 'PENDIENTE', motivo: MOTIVO_NOTA_SIN_INTENTAR })
      continue
    }
    type Intento = { r: Awaited<ReturnType<typeof emitir>> } | { err: unknown } | { vencida: true }
    const intento = await conLimiteDeTiempo<Intento>(
      emitir({ venueId: factura.venueId, refundPaymentId, sandbox: p.sandbox, requestedByStaffId: p.staffId }).then(
        r => ({ r }),
        (err: unknown) => ({ err }),
      ),
      restante,
      () => ({ vencida: true }),
    )
    let nota: NotaDeDevolucion
    let error: string | undefined // Ruling T6-d: el texto crudo de un error interno, sólo para el log
    if ('vencida' in intento) {
      nota = { refundPaymentId, status: 'PENDIENTE', motivo: MOTIVO_NOTA_SIN_RESPUESTA }
      detenido = true
    } else if ('err' in intento) {
      const err = intento.err
      // Ruling T6-d: a la pantalla sólo llega el texto de un error de NEGOCIO (AppError 4xx, ya en español: ConflictError, BadRequestError…);
      // uno interno (Prisma, red, «Transaction already closed», en inglés) dice el texto de siempre y su crudo va al log.
      const deNegocio = err instanceof AppError && err.statusCode < 500 && err.message
      if (!deNegocio) error = err instanceof Error ? err.message : String(err)
      nota = { refundPaymentId, status: 'PENDIENTE', motivo: deNegocio || MOTIVO_NOTA_PENDIENTE }
    } else {
      const r = intento.r
      const deEstaFactura = (r.cfdi?.entrada as { originalCfdiId?: string } | null | undefined)?.originalCfdiId === factura.id
      nota =
        r.status === 'STAMPED'
          ? deEstaFactura
            ? { refundPaymentId, status: 'STAMPED', folio: folioDe(r.cfdi) }
            : { refundPaymentId, status: 'PENDIENTE', motivo: motivoNotaDeOtraFactura(folioDe(r.cfdi)) }
          : {
              refundPaymentId,
              status: 'PENDIENTE',
              motivo: timbreEnDuda(r.cfdi)
                ? textoDeTimbreEnDuda('la nota de crédito')
                : r.reasons?.join(' ') || r.cfdi?.lastError || MOTIVO_NOTA_PENDIENTE,
            }
    }
    if (nota.status === 'PENDIENTE')
      logger.warn('[cfdi-f6] nota de crédito automática pendiente', { cfdiId: factura.id, ...nota, ...(error ? { error } : {}) })
    out.push(nota)
  }
  return out
}

/**
 * Ruling CX-1 (Codex código r1, P2-1): una nota que el PAC rechazó en definitiva (`STAMP_FAILED` + `falloDefinitivo`, o `VALIDATION_FAILED`) no
 * se vuelve a intentar hasta que su `updatedAt` cumpla esta espera: así sus reintentos no se comen el presupuesto de cada pasada y las notas
 * independientes de la misma factura avanzan. Se sigue reintentando sola (decisión A), ~24 veces al día en vez de ~288.
 */
export const ESPERA_TRAS_RECHAZO_DEFINITIVO_MS = 60 * 60_000

/** F6: una factura por el total con notas automáticas que faltan, y cuáles (en orden fiscal). */
export type FacturaConNotasPendientes = { cfdiId: string; venueId: string; orderId: string | null; pendientes: string[] }
export type FiltroDeNotasPendientes = {
  venueIds?: string[]
  cfdiIds?: string[]
  timbradaAntesDe?: Date
  despuesDe?: string | null
  /**
   * El job (N5, H2): sólo lo que su pasada puede intentar — sin las de nota CANCELADA (requieren a una persona; ninguna pasada las rehace), ni
   * las ENVIADAS y en duda (las consulta por su identidad la conciliación de siempre, `reconcileStuckCfdi`), ni (Ruling CX-1) las rechazadas en
   * definitiva hace menos de `ESPERA_TRAS_RECHAZO_DEFINITIVO_MS`. La lista y el MCP muestran todas.
   */
  paraEmitir?: boolean
  /** Sin él, sin `LIMIT` (sólo el conteo). Con 0, ninguna fila (nunca «sin tope»). Quien lo recibe de fuera lo acota antes (MCP: 1..20). */
  limite?: number
}

/**
 * F6 (R5, R7, R9, N5): las facturas por el total (`entrada.devoluciones.modo = 'CON_NOTA'`), timbradas y vigentes, a las que les falta la nota
 * TIMBRADA de algún reembolso de su marca contra ELLAS (`n.entrada->>'originalCfdiId'`; R3: una nota de otra factura no la cumple), con SÓLO
 * esos reembolsos en `pendientes`, en el orden fiscal congelado. Proyecta sólo la marca; sin vencimiento. Se exporta el SQL para su `EXPLAIN`.
 * No importa QUIÉN confirmó el timbre de la factura (el gancho de «Facturar» o la conciliación de un envío en duda): basta la marca.
 * ponytail: recorre todas las facturas CON_NOTA, también las ya resueltas (~24 µs c/u medido el 13-oct; 10k ⇒ ~240 ms por pasada; el conteo
 * del MCP envuelve esta misma consulta). Revisar si pasan de ~5k: marcar «notas completas» al salir la última y un índice parcial que las excluya.
 */
export function sqlDeNotasPendientes(p: FiltroDeNotasPendientes): Prisma.Sql {
  const marca = Prisma.sql`jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.entrada->'devoluciones'->'pagos') = 'array'
    THEN c.entrada->'devoluciones'->'pagos' ELSE '[]'::jsonb END) WITH ORDINALITY AS r(id, i)`
  const sinNota = Prisma.sql`NOT EXISTS (SELECT 1 FROM "Cfdi" n WHERE n."idempotencyKey" = 'cfdi-refund-' || r.id
    AND n.status = 'STAMPED' AND n.entrada->>'originalCfdiId' = c.id)`
  // Ruling CX-1: un rechazo DEFINITIVO de hace menos de `ESPERA_TRAS_RECHAZO_DEFINITIVO_MS` se pospone (sigue a la vista, sin `paraEmitir`).
  // El corte va con `utcTs` EN LÍNEA: la guarda `rawSqlDateBindGuard` sólo reconoce el ayudante escrito junto a la columna.
  const pospuestaDesde = new Date(Date.now() - ESPERA_TRAS_RECHAZO_DEFINITIVO_MS)
  const intentable = Prisma.sql`NOT EXISTS (SELECT 1 FROM "Cfdi" k WHERE k."idempotencyKey" = 'cfdi-refund-' || r.id
    AND (k.status = 'CANCELLED' OR k."cancelStatus" IN ('ACCEPTED', 'CANCELLED')
         OR (k.status IN ('STAMPING', 'STAMP_FAILED') AND k."enviadoAt" IS NOT NULL AND k."falloDefinitivo" = false)
         OR ((k.status = 'VALIDATION_FAILED' OR (k.status = 'STAMP_FAILED' AND k."falloDefinitivo" = true))
             AND k."updatedAt" > ${utcTs(pospuestaDesde)})))`
  const y = (cond: unknown, sql: Prisma.Sql) => (cond ? Prisma.sql`AND ${sql}` : Prisma.empty)
  const pendiente = Prisma.sql`${sinNota} ${y(p.paraEmitir, intentable)}`
  return Prisma.sql`
    SELECT c.id AS "cfdiId", c."venueId", c."orderId",
      ARRAY(SELECT r.id FROM ${marca} WHERE ${pendiente} ORDER BY r.i) AS pendientes
    FROM "Cfdi" c
    WHERE c.type = 'INGRESO' AND c."isGlobal" = false AND c.status = 'STAMPED'
      AND (c."cancelStatus" IS NULL OR c."cancelStatus" = 'REJECTED')
      AND c.entrada->'devoluciones'->>'modo' = 'CON_NOTA'
      ${y(p.venueIds, Prisma.sql`c."venueId" = ANY(${p.venueIds ?? []})`)}
      ${y(p.cfdiIds, Prisma.sql`c.id = ANY(${p.cfdiIds ?? []})`)}
      ${y(p.timbradaAntesDe, Prisma.sql`c."stampedAt" < ${utcTs(p.timbradaAntesDe ?? new Date(0))}`)}
      ${y(p.despuesDe, Prisma.sql`c.id > ${p.despuesDe ?? ''}`)}
      AND EXISTS (SELECT 1 FROM ${marca} WHERE ${pendiente})
    ORDER BY c.id
    ${p.limite !== undefined ? Prisma.sql`LIMIT ${p.limite}` : Prisma.empty}`
}
export function facturasConNotasPendientes(p: FiltroDeNotasPendientes): Promise<FacturaConNotasPendientes[]> {
  return prisma.$queryRaw<FacturaConNotasPendientes[]>(sqlDeNotasPendientes(p))
}
/** N7: el total exacto (el MCP lo dice como el de extracciones pendientes). Se exporta el SQL para su `EXPLAIN` (H5). */
export const sqlDelConteoDeNotasPendientes = (p: Omit<FiltroDeNotasPendientes, 'limite' | 'despuesDe'>) =>
  Prisma.sql`SELECT count(*)::int AS n FROM (${sqlDeNotasPendientes(p)}) AS pendientes`
export async function contarFacturasConNotasPendientes(p: Omit<FiltroDeNotasPendientes, 'limite' | 'despuesDe'>): Promise<number> {
  const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>(sqlDelConteoDeNotasPendientes(p))
  return n
}
