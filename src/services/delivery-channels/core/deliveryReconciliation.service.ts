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
import { PaymentSource, Prisma, TransactionStatus } from '@prisma/client'

import logger from '@/config/logger'
import { fiscalByRateCents, type FiscalByRateCents } from '@/services/fiscal/deliveryFiscalDelta'
import { writeRefundInTx } from '@/services/shared/writeRefundInTx'

import { withDeliveryOrderLock } from './deliveryOrderLock'
import { applyLineRemoval } from './lineRemoval.service'
import { assertDeliveryMoneyInvariants } from './money'
import { contexto } from './respondToDeliveryOrder.service'
import type { NormalizedDeliveryOrder } from './types'

export type ResultadoReconciliacion = {
  outcome: 'REFUNDED' | 'NO_DELTA' | 'FISCAL_PENDING' | 'BLOCKED_INCREASE' | 'NO_ACTIONS' | 'READ_FAILED'
}

/** ponytail: el candado se sostiene durante UNA lectura acotada; el tx del candado vence a los 15 s. */
export const LECTURA_PROVEEDOR_MS = 8_000
/** Un pedido de reparto trae decenas de renglones, no cientos; pasar de aquí es un dato roto. */
const LIMITE_FILAS = 500

const TERMINALES = new Set(['REFUNDED', 'NO_DELTA', 'FISCAL_PENDING'])
const centavos = (v: Prisma.Decimal | string) => new Prisma.Decimal(v).times(100).round().toNumber()
const pesos = (c: number) => new Prisma.Decimal(c).div(100)

/** Lee con límite: aborta la señal Y deja de esperar, aunque el proveedor ignore la señal. */
async function leerConLimite<T>(leer: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const vencio = new Promise<never>((_, rechazar) => {
    timer = setTimeout(() => {
      ctl.abort()
      rechazar(new Error(`la lectura del proveedor venció a los ${LECTURA_PROVEEDOR_MS} ms`))
    }, LECTURA_PROVEEDOR_MS)
  })
  try {
    return await Promise.race([leer(ctl.signal), vencio])
  } finally {
    clearTimeout(timer)
  }
}

/** La línea tal como la lee la póliza de la venta (`grossByRateForOrder`): mismos campos, misma tasa. */
type Fila = {
  id: string
  externalLineId: string | null
  quantity: number
  total: Prisma.Decimal
  unitPrice: Prisma.Decimal
  discountAmount: Prisma.Decimal
  product: { taxRate: Prisma.Decimal | null } | null
}
const comoEnLaVenta = (f: Fila) => ({
  unitPrice: Number(f.unitPrice),
  quantity: f.quantity,
  discountAmount: Number(f.discountAmount),
  taxRate: f.product?.taxRate != null ? Number(f.product.taxRate) : null,
})

export async function reconcileDeliveryOrderFromProvider(
  orderId: string,
  opts: { trigger: 'ROUTE' | 'JOB' | 'WEBHOOK' },
): Promise<ResultadoReconciliacion> {
  return withDeliveryOrderLock(orderId, async tx => {
    const orden = await tx.order.findUnique({ where: { id: orderId }, select: { venueId: true, deliveryReconcileBlocked: true } })
    if (!orden) return { outcome: 'READ_FAILED' as const }
    const venueId = orden.venueId
    const ctx = await contexto(venueId, orderId, tx)
    if (!ctx || typeof ctx.adapter.fetchOrder !== 'function') {
      logger.warn('[Delivery] reconciliación sin canal o sin lectura del proveedor', { orderId, trigger: opts.trigger })
      return { outcome: 'READ_FAILED' as const }
    }

    // ── 1. Foto FRESCA, dentro del candado, acotada. Si no se puede confiar en ella, nada se escribe.
    let foto: NormalizedDeliveryOrder
    try {
      foto = ctx.adapter.normalizeOrder(await leerConLimite(signal => ctx.adapter.fetchOrder!(ctx.externalOrderId, signal)))
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

    const filas: Fila[] = await tx.orderItem.findMany({
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

    const acciones = await tx.deliveryLineAction.findMany({
      where: { orderId, venueId, action: 'REMOVE_ITEM' },
      select: { id: true, orderItemId: true, settlement: true },
      take: LIMITE_FILAS,
    })
    const liquidadas = new Set(acciones.filter(a => TERMINALES.has(a.settlement)).map(a => a.orderItemId))
    const acreditadas = acciones.filter(a => a.settlement === 'ACCREDITED')
    const idsAcreditados = new Set(acreditadas.map(a => a.orderItemId))

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

    // ── 4. IVA por tasa: composición cobrada hasta ahora (sin lo ya liquidado) − la superviviente.
    const cobrada = filas.filter(f => !liquidadas.has(f.id))
    const superviviente = cobrada.filter(f => !idsAcreditados.has(f.id))
    const fiscal = fiscalByRateCents(cobrada.map(comoEnLaVenta), superviviente.map(comoEnLaVenta), pagadoVenta, pagadoVenta - dVenta)
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
    const { refundPaymentId } = await writeRefundInTx(tx, {
      originalPaymentId: original.id,
      venueId,
      salesRefundCents: dVenta,
      tipRefundCents: dPropina,
      refundedItems: acreditadas.map(a => ({
        orderItemId: a.orderItemId,
        quantity: porId.get(a.orderItemId)!.quantity,
        amountCents: centavos(porId.get(a.orderItemId)!.total),
      })),
      fiscalByRateCents: fiscal as FiscalByRateCents,
      generation,
      reason: 'DELIVERY_ITEM_REMOVED',
      staffId: null,
      idempotencyKey: `dlr:${orderId}:${generation}`,
      tenderCommission: 'REVERSE_PROPORTIONAL',
      shift: 'INHERIT_ORIGINAL',
      provenance: 'PROVIDER_ADJUSTMENT',
    })
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
