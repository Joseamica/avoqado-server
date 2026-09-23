/**
 * El dinero de un pedido de reparto, reconciliado contra la foto FRESCA del proveedor (spec KDS
 * Uber §3.1, [N-8][N-9][N-11][N-13][N-21][N-25][N-26]).
 *
 * 🔴 El dinero sólo se mueve cuando una lectura del proveedor, hecha DENTRO del candado del
 * pedido, ya no trae el renglón. Nunca con el 2xx del retiro, nunca con una foto que traiga
 * el llamador: por eso esta función no recibe foto. Entonces se escribe un REEMBOLSO PARCIAL
 * compensatorio (fila REFUND `PROVIDER_ADJUSTMENT`) con los deltas EXACTOS del bloque `payment`
 * —nunca sumando renglones— y el IVA por tasa como diferencia de composiciones, con los MISMOS
 * helpers que la póliza de la venta. Todo en UNA transacción: retiro, reembolso, reprecio.
 *
 * Lo que NO hace, a propósito: cobrar de más cuando el proveedor SUBE venta o propina, ni
 * reclasificar IVA sin movimiento de dinero. Esos casos quedan bloqueados y visibles
 * (`Order.deliveryReconcileBlocked`) hasta que una persona decida.
 */
import { OrderStatus, PaymentSource, Prisma, TransactionStatus } from '@prisma/client'

import logger from '@/config/logger'
import { grossByRateForOrder } from '@/services/fiscal/autoPosting.service'
import { ivaEnLibrosPorTasa } from '@/services/fiscal/deliveryFiscalDelta'
import { splitPaymentIvaByOrderRates } from '@/services/fiscal/ivaMath'
import { lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { writeRefundInTx } from '@/services/shared/writeRefundInTx'

import { CANDADO_TX_TIMEOUT_MS, withDeliveryOrderLock } from './deliveryOrderLock'
import { applyLineRemoval } from './lineRemoval.service'
import { assertDeliveryMoneyInvariants } from './money'
import { contexto } from './respondToDeliveryOrder.service'
import type { NormalizedDeliveryOrder } from './types'

export type ResultadoReconciliacion = {
  outcome: 'REFUNDED' | 'NO_DELTA' | 'FISCAL_PENDING' | 'BLOCKED_INCREASE' | 'NO_ACTIONS' | 'READ_FAILED' | 'ORDER_CANCELLED'
}

/** ponytail: el candado se sostiene durante UNA lectura acotada; el tx del candado vence a los 15 s. */
export const LECTURA_PROVEEDOR_MS = 8_000
/** Lo que el tx necesita DESPUÉS de la lectura (escrituras), y la lectura más corta que vale la pena intentar. */
const MARGEN_ESCRITURA_MS = 3_000
const LECTURA_MINIMA_MS = 1_000
/** Un pedido de reparto trae decenas de renglones, no cientos; pasar de aquí es un dato roto. */
const LIMITE_FILAS = 500

const centavos = (v: Prisma.Decimal | string) => new Prisma.Decimal(v).times(100).round().toNumber()
const pesos = (c: number) => new Prisma.Decimal(c).div(100)

/** Lee con límite: aborta la señal Y deja de esperar, aunque el proveedor ignore la señal. */
async function leerConLimite<T>(leer: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctl = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const vencio = new Promise<never>((_, rechazar) => {
    timer = setTimeout(() => {
      ctl.abort()
      rechazar(new Error(`la lectura del proveedor venció a los ${ms} ms`))
    }, ms)
  })
  try {
    return await Promise.race([leer(ctl.signal), vencio])
  } finally {
    clearTimeout(timer)
  }
}

export async function reconcileDeliveryOrderFromProvider(
  orderId: string,
  opts: { trigger: 'ROUTE' | 'JOB' | 'WEBHOOK' },
): Promise<ResultadoReconciliacion> {
  // ponytail: se mide ANTES de pedir el tx, así la espera de conexión cuenta como gastada (conservador).
  const inicio = Date.now()
  return withDeliveryOrderLock(orderId, async tx => {
    const orden = await tx.order.findUnique({
      where: { id: orderId },
      select: { venueId: true, deliveryReconcileBlocked: true, status: true },
    })
    if (!orden) return { outcome: 'READ_FAILED' as const }
    // Una venta cancelada ya no existe como venta: compensarla escribiría un REFUND sobre dinero que
    // no se cuenta. No se toca nada — ni retiros ni acciones (se revalida con la fila bloqueada abajo).
    if (orden.status === OrderStatus.CANCELLED) return { outcome: 'ORDER_CANCELLED' as const }
    const venueId = orden.venueId
    const ctx = await contexto(venueId, orderId, tx)
    if (!ctx || typeof ctx.adapter.fetchOrder !== 'function') {
      logger.warn('[Delivery] reconciliación sin canal o sin lectura del proveedor', { orderId, trigger: opts.trigger })
      return { outcome: 'READ_FAILED' as const }
    }

    // ── 1. Foto FRESCA, dentro del candado, acotada. Si no se puede confiar en ella, nada se escribe.
    // El plazo sale de lo que le queda al tx: quien esperó el candado detrás de otra lectura lenta
    // lee menos, y si ya no alcanza, no lee — un tx vencido lanza en vez de contestar READ_FAILED.
    const plazo = Math.min(LECTURA_PROVEEDOR_MS, CANDADO_TX_TIMEOUT_MS - (Date.now() - inicio) - MARGEN_ESCRITURA_MS)
    if (plazo < LECTURA_MINIMA_MS) {
      logger.warn('[Delivery] reconciliación sin tiempo para leer al proveedor: no se escribe nada', {
        orderId,
        trigger: opts.trigger,
        plazo,
      })
      return { outcome: 'READ_FAILED' as const }
    }
    let foto: NormalizedDeliveryOrder
    try {
      foto = ctx.adapter.normalizeOrder(await leerConLimite(signal => ctx.adapter.fetchOrder!(ctx.externalOrderId, signal), plazo))
      assertDeliveryMoneyInvariants(foto.payment, foto.items)
      if (foto.externalId !== ctx.externalOrderId) throw new Error(`la foto es del pedido ${foto.externalId}`)
      if (foto.items.some(i => !i.lineId)) throw new Error('la foto trae renglones sin id de línea: no prueba ausencias')
    } catch (e) {
      logger.warn('[Delivery] reconciliación sin foto confiable del proveedor: no se escribe nada', {
        orderId,
        trigger: opts.trigger,
        error: String(e),
      })
      return { outcome: 'READ_FAILED' as const }
    }

    // Serializa con un reembolso del dashboard en vuelo: ése toma `Order FOR UPDATE` sin el candado de
    // reparto. Sin esto, Δ se calcula sin él y el MISMO renglón se compensa dos veces. Orden de
    // candados: reparto → Order → Payment, el mismo de `writeRefundInTx`.
    if (!(await lockExistingOrderForPayment(tx, { venueId, orderId }))) return { outcome: 'READ_FAILED' as const }
    // Con la fila bloqueada: una cancelación que entró durante la lectura también frena el dinero.
    const vigente = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } })
    if (vigente?.status === OrderStatus.CANCELLED) return { outcome: 'ORDER_CANCELLED' as const }

    const filas = await tx.orderItem.findMany({
      where: { orderId },
      select: {
        id: true,
        externalLineId: true,
        quantity: true,
        total: true,
        unitPrice: true,
        discountAmount: true,
        product: { select: { taxRate: true } },
      },
      take: LIMITE_FILAS + 1,
    })
    if (filas.length > LIMITE_FILAS || filas.some(f => !f.externalLineId)) {
      logger.error('🚨 [Delivery] reconciliación imposible: renglones sin id de línea o fuera de límite', { orderId, n: filas.length })
      return { outcome: 'READ_FAILED' as const }
    }

    if (foto.providerAccepted && !ctx.order.providerAcceptedAt) {
      await tx.order.updateMany({
        where: { id: orderId, providerAcceptedAt: null },
        data: { providerAcceptedAt: new Date(), providerAcceptedEvidence: 'PROVIDER_STATE' },
      })
    }

    // ── 2. Toda línea ausente se retira (reparadora); la ausencia acredita la acción que esperaba.
    const presentes = new Set(foto.items.map(i => i.lineId))
    const ausentes = filas.filter(f => !presentes.has(f.externalLineId!))
    for (const f of ausentes) await applyLineRemoval(tx, { orderId, orderItemId: f.id, origin: 'PROVIDER' })
    if (ausentes.length > 0) {
      await tx.deliveryLineAction.updateMany({
        where: {
          orderId,
          venueId,
          action: 'REMOVE_ITEM',
          status: 'CONFIRMED',
          settlement: 'PENDING',
          lineId: { in: ausentes.map(f => f.externalLineId!) },
        },
        data: { settlement: 'ACCREDITED' },
      })
    }

    if (orden.deliveryReconcileBlocked) {
      // «Queda pendiente hasta que una persona decida»: bloqueado, ninguna pasada mueve dinero.
      logger.warn('[Delivery] reconciliación bloqueada: espera a una persona', { orderId, bloqueo: orden.deliveryReconcileBlocked })
      return {
        outcome: orden.deliveryReconcileBlocked === 'INCREASE_UNSUPPORTED' ? ('BLOCKED_INCREASE' as const) : ('FISCAL_PENDING' as const),
      }
    }

    const acreditadas = await tx.deliveryLineAction.findMany({
      where: { orderId, venueId, action: 'REMOVE_ITEM', settlement: 'ACCREDITED' },
      select: { id: true, orderItemId: true },
      take: LIMITE_FILAS,
    })

    // ── 3. Deltas del bloque `payment` contra lo registrado del proveedor (original + REFUND previos).
    const cobros = await tx.payment.findMany({
      where: { orderId, venueId, source: PaymentSource.DELIVERY_PLATFORM, status: TransactionStatus.COMPLETED },
      select: { id: true, type: true, amount: true, tipAmount: true, processorData: true },
      orderBy: { createdAt: 'asc' },
      take: LIMITE_FILAS,
    })
    const pagadoVenta = cobros.reduce((s, c) => s + centavos(c.amount), 0)
    const pagadoPropina = cobros.reduce((s, c) => s + centavos(c.tipAmount), 0)
    const dVenta = pagadoVenta - centavos(foto.payment.externallyPaidSale)
    const dPropina = pagadoPropina - centavos(foto.payment.externallyPaidTip)

    if (dVenta < 0 || dPropina < 0) {
      await tx.order.update({ where: { id: orderId }, data: { deliveryReconcileBlocked: 'INCREASE_UNSUPPORTED' } })
      logger.error('🚨 [Delivery] el proveedor SUBIÓ venta o propina: no se escribe dinero, espera a una persona', {
        orderId,
        venueId,
        dVentaCents: dVenta,
        dPropinaCents: dPropina,
      })
      return { outcome: 'BLOCKED_INCREASE' as const }
    }

    // ── 4. IVA por tasa: lo que HOY está en libros (venta − cada devolución, manual o del proveedor,
    // como la póliza las postea) − el IVA de la composición superviviente. Restar composiciones
    // cobradas dejaba IVA residual en cuanto un reembolso manual entraba entre dos retiros (P1-1).
    // Sobrevive lo que la foto fresca TRAE, con el MISMO mapeo de campos que la póliza de la venta.
    const superviviente = filas.filter(f => presentes.has(f.externalLineId!))
    const enLibros = ivaEnLibrosPorTasa(
      cobros.map(c => ({ id: c.id, type: c.type, amountCents: centavos(c.amount), processorData: c.processorData })),
      grossByRateForOrder(filas),
    )
    const ivaSuperviviente = splitPaymentIvaByOrderRates(pagadoVenta - dVenta, grossByRateForOrder(superviviente)).taxByRate
    const fiscal: Record<string, number> = {}
    for (const tasa of new Set([...Object.keys(enLibros), ...Object.keys(ivaSuperviviente)])) {
      const d = (enLibros[tasa] ?? 0) - (ivaSuperviviente[tasa] ?? 0)
      if (d !== 0) fiscal[tasa] = d
    }
    const ivaDevuelto = Object.values(fiscal).reduce((s, v) => s + v, 0)

    const aFiscalPendiente = async (motivo: string) => {
      await tx.deliveryLineAction.updateMany({
        where: { id: { in: acreditadas.map(a => a.id) }, settlement: 'ACCREDITED' },
        data: { settlement: 'FISCAL_PENDING' },
      })
      await tx.order.update({ where: { id: orderId }, data: { deliveryReconcileBlocked: 'FISCAL_RECLASS_UNSUPPORTED' } })
      logger.error(`🚨 [Delivery] ${motivo}: no se declara liquidado, espera a una persona`, {
        orderId,
        venueId,
        fiscal,
        dVentaCents: dVenta,
      })
      return { outcome: 'FISCAL_PENDING' as const }
    }

    if (dVenta === 0 && dPropina === 0) {
      if (acreditadas.length === 0) return { outcome: 'NO_ACTIONS' as const }
      if (Object.values(fiscal).some(v => v !== 0)) return aFiscalPendiente('retiro sin movimiento de dinero pero con IVA reclasificado')
      await tx.deliveryLineAction.updateMany({
        where: { id: { in: acreditadas.map(a => a.id) }, settlement: 'ACCREDITED' },
        data: { settlement: 'NO_DELTA' },
      })
      await reprecio(tx, { orderId, venueId, foto, pagadoCents: pagadoVenta + pagadoPropina, trigger: opts.trigger })
      return { outcome: 'NO_DELTA' as const }
    }

    // Q1bis: un IVA devuelto negativo por tasa, o fuera de [0, Δventa], no existe como REFUND.
    if (Object.values(fiscal).some(v => v < 0) || ivaDevuelto < 0 || ivaDevuelto > dVenta) {
      return aFiscalPendiente('el reparto de IVA del retiro no cabe en un reembolso')
    }

    const original = cobros.find(c => c.type !== 'REFUND')
    if (!original) throw new Error(`reconciliación: el pedido ${orderId} no tiene cobro del proveedor que compensar`)
    const generation =
      1 +
      cobros.filter(c => c.type === 'REFUND' && (c.processorData as { provenance?: unknown } | null)?.provenance === 'PROVIDER_ADJUSTMENT')
        .length
    const porId = new Map(filas.map(f => [f.id, f]))
    const { refundPaymentId, replay } = await writeRefundInTx(tx, {
      originalPaymentId: original.id,
      venueId,
      salesRefundCents: dVenta,
      tipRefundCents: dPropina,
      refundedItems: acreditadas.map(a => ({
        orderItemId: a.orderItemId,
        quantity: porId.get(a.orderItemId)!.quantity,
        amountCents: centavos(porId.get(a.orderItemId)!.total),
      })),
      fiscalByRateCents: fiscal,
      generation,
      reason: 'DELIVERY_ITEM_REMOVED',
      staffId: null,
      idempotencyKey: `dlr:${orderId}:${generation}`,
      tenderCommission: 'REVERSE_PROPORTIONAL',
      shift: 'INHERIT_ORIGINAL',
      provenance: 'PROVIDER_ADJUSTMENT',
    })
    if (replay) {
      // Un Δ fresco no puede ser la réplica de otro movimiento: estampar ese id liquidaría estas
      // acciones con dinero que nunca se movió.
      logger.error('🚨 [Delivery] la llave del ajuste ya existía con un Δ nuevo: no se liquida nada', {
        orderId,
        venueId,
        generation,
        refundPaymentId,
        dVentaCents: dVenta,
        dPropinaCents: dPropina,
      })
      throw new Error(`reconciliación: la llave dlr:${orderId}:${generation} es un replay con Δ nuevo`)
    }
    await tx.deliveryLineAction.updateMany({
      where: { id: { in: acreditadas.map(a => a.id) }, settlement: 'ACCREDITED' },
      data: { settlement: 'REFUNDED', refundPaymentId },
    })
    await reprecio(tx, {
      orderId,
      venueId,
      foto,
      pagadoCents: pagadoVenta - dVenta + pagadoPropina - dPropina,
      trigger: opts.trigger,
      refundPaymentId,
    })
    return { outcome: 'REFUNDED' as const }
  })
}

/**
 * ── 5. La orden refleja el bloque `payment` del proveedor, no la suma de renglones:
 * `total = venta + cargos − descuento` y `paidAmount = Σ Payment del proveedor` [N-8].
 */
async function reprecio(
  tx: Prisma.TransactionClient,
  p: { orderId: string; venueId: string; foto: NormalizedDeliveryOrder; pagadoCents: number; trigger: string; refundPaymentId?: string },
) {
  const d = (v: string | undefined) => new Prisma.Decimal(v ?? '0')
  const pay = p.foto.payment
  const data = {
    subtotal: d(pay.saleAmount),
    discountAmount: d(pay.discountAmount),
    tipAmount: d(pay.tipAmount),
    total: d(pay.saleAmount).plus(d(pay.merchantFees)).minus(d(pay.discountAmount)),
    paidAmount: pesos(p.pagadoCents),
    remainingBalance: d(pay.cashDueSale).plus(d(pay.cashDueTip)),
  }
  await tx.order.update({ where: { id: p.orderId }, data })
  await tx.activityLog.create({
    data: {
      venueId: p.venueId,
      staffId: null,
      action: 'DELIVERY_ORDER_REPRICED',
      entity: 'Order',
      entityId: p.orderId,
      data: {
        trigger: p.trigger,
        refundPaymentId: p.refundPaymentId ?? null,
        ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.toFixed(2)])),
      },
    },
  })
}
