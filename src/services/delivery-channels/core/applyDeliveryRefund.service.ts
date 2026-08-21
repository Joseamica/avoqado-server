/**
 * Un reembolso que hizo el marketplace, reflejado en los libros del comercio.
 *
 * 🔴 POR QUÉ IMPORTA: si Uber le devuelve dinero a un cliente, ese monto se descuenta del
 * depósito del comercio — pero por la API de pedidos NUNCA nos enteramos ("Refunds/chargebacks
 * appear only in Reporting", guía de Uber). Sin esto, sus cortes y su contabilidad muestran
 * un ingreso que nunca llegó al banco, y lo descubre cuando el depósito no cuadra.
 *
 * 🔴 UN REEMBOLSO NO ES UNA CANCELACIÓN, y por eso NO reusa `cancelDeliveryOrder`:
 *   · Cancelación: la comida nunca se hizo. La venta no debió existir, el inventario vuelve.
 *   · Reembolso: la comida SÍ se hizo y se entregó; el cliente se quejó después. La venta
 *     ocurrió —tuvo su costo, su inventario, su comisión— y lo que cambia es que el dinero
 *     se devolvió. Borrarla escondería una venta que de verdad pasó.
 *
 * Se registra como un `Payment` de tipo REFUND con importe NEGATIVO, igual que el reembolso
 * del TPV: es la forma que el resto de la plataforma ya sabe leer (`computeOrderBalance`
 * excluye los REFUND, y los reportes los netean).
 */
import { Prisma, TransactionStatus } from '@prisma/client'

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'

export type RefundOutcome = 'APPLIED' | 'ALREADY_APPLIED' | 'ORDER_NOT_FOUND' | 'NOTHING_TO_APPLY'

export interface ApplyRefundResult {
  outcome: RefundOutcome
  orderId?: string
}

/**
 * @param externalOrderId  El id del pedido EN EL PROVEEDOR (sin el prefijo del namespace).
 * @param montoDevuelto    Lo que el comercio termina pagando, en PESOS y POSITIVO.
 */
export async function applyDeliveryRefund(params: {
  externalOrderId: string
  provider: 'UBER_EATS'
  montoDevuelto: string
  motivo: string
}): Promise<ApplyRefundResult> {
  const externalId = `${params.provider}:${params.externalOrderId}`
  const monto = new Prisma.Decimal(params.montoDevuelto)

  if (monto.lessThanOrEqualTo(0)) return { outcome: 'NOTHING_TO_APPLY' }

  const order = await prisma.order.findFirst({
    where: { externalId },
    select: { id: true, venueId: true, orderNumber: true },
  })
  if (!order) {
    // Puede pasar de verdad: el reporte cubre un rango de fechas y puede incluir pedidos de
    // antes de conectar la integración. No es un error, es información.
    logger.warn('[💸 DeliveryRefund] el reporte trae un reembolso de un pedido que no tenemos', { externalId })
    return { outcome: 'ORDER_NOT_FOUND' }
  }

  // 🔴 IDEMPOTENCIA. El reporte se pide a diario y los rangos se traslapan: el MISMO
  // reembolso va a llegar muchas veces. Sin esta llave, cada corrida restaría otra vez y el
  // ingreso del comercio se hundiría solo, un poco cada día, sin que nada fallara.
  const idempotencyKey = `uber-refund:${params.externalOrderId}`
  const yaAplicado = await prisma.payment.findFirst({ where: { orderId: order.id, idempotencyKey }, select: { id: true } })
  if (yaAplicado) return { outcome: 'ALREADY_APPLIED', orderId: order.id }

  const original = await prisma.payment.findFirst({
    where: { orderId: order.id, type: 'REGULAR' },
    select: { method: true, source: true, tenderTypeId: true, fundsFlow: true },
  })

  await prisma.payment.create({
    data: {
      venueId: order.venueId,
      orderId: order.id,
      // Negativo, como el reembolso del TPV: es la forma que los reportes ya netean.
      amount: monto.neg(),
      tipAmount: new Prisma.Decimal(0),
      type: 'REFUND',
      status: TransactionStatus.COMPLETED,
      method: original?.method ?? 'OTHER',
      source: original?.source ?? 'DELIVERY_PLATFORM',
      // Hereda la SEMÁNTICA del cobro original: este dinero tampoco sale del cajón, lo
      // descuenta el proveedor de su depósito. Sin heredarlo, el arqueo pediría un efectivo
      // que nunca estuvo ahí.
      ...(original?.tenderTypeId ? { tenderTypeId: original.tenderTypeId } : {}),
      ...(original?.fundsFlow ? { fundsFlow: original.fundsFlow } : {}),
      // 🔴 La COMISIÓN no se hereda, a propósito: que el proveedor devuelva el dinero al
      // cliente NO significa que devuelva su porcentaje al comercio. Copiarla aquí le
      // acreditaría al negocio una comisión que nadie le regresó.
      idempotencyKey,
    },
  })

  void logAction({
    action: 'DELIVERY_REFUND_APPLIED',
    entity: 'Order',
    entityId: order.id,
    venueId: order.venueId,
    data: { externalId, monto: monto.toString(), motivo: params.motivo },
  })

  logger.info('💸 [DeliveryRefund] reembolso del proveedor aplicado', {
    orderId: order.id,
    orderNumber: order.orderNumber,
    monto: monto.toString(),
    motivo: params.motivo,
  })
  return { outcome: 'APPLIED', orderId: order.id }
}
