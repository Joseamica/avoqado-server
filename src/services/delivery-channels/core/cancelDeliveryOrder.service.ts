/**
 * El proveedor canceló un pedido. Deja de contar como venta y deja de cocinarse.
 *
 * 🔴 POR QUÉ EXISTE: Uber manda `orders.cancel`, y hasta el 2026-08-20 lo marcábamos
 * "procesado" y lo IGNORÁBAMOS. La venta se quedaba CONFIRMED/PAID, la cocina seguía
 * cocinando comida que nadie iba a recoger, y ese dinero jamás llegaba — pero en los
 * reportes seguía contado. El síntoma era invisible: nada fallaba, todo mentía.
 */
import { DeliveryProvider, OrderStatus, Prisma } from '@prisma/client'

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { reverseSalePosting } from '@/services/inventory/reverseSalePosting.service'

export interface CancelResult {
  outcome: 'CANCELLED' | 'ORDER_NOT_FOUND' | 'ALREADY_CANCELLED'
  orderId?: string
}

/**
 * @param externalOrderId  El id del pedido EN EL PROVEEDOR (sin el prefijo del namespace).
 * @param provider         Con qué prefijo buscarlo: dos marketplaces pueden repetir folio.
 */
export async function cancelDeliveryOrder(externalOrderId: string, provider: DeliveryProvider, motivo?: string): Promise<CancelResult> {
  const externalId = `${provider}:${externalOrderId}`
  const order = await prisma.order.findFirst({
    where: { externalId },
    select: { id: true, venueId: true, orderNumber: true, status: true, total: true },
  })

  // El cancel puede llegar ANTES que la notificación del pedido (Uber no ordena sus
  // webhooks). No es un error: no hay nada que cancelar todavía, y el evento queda
  // persistido para que se vea. Inventar una orden cancelada sería peor.
  if (!order) {
    logger.warn('[🛵 DeliveryCancel] cancelación de un pedido que aún no existe — se ignora', { externalId, motivo })
    return { outcome: 'ORDER_NOT_FOUND' }
  }

  // Idempotente: los webhooks son at-least-once y un reintento no puede volver a auditar
  // ni a repetir la alerta.
  if (order.status === OrderStatus.CANCELLED) {
    return { outcome: 'ALREADY_CANCELLED', orderId: order.id }
  }

  await prisma.$transaction(async tx => {
    // `OrderStatus.CANCELLED` es la señal CANÓNICA de "esto no fue una venta": la
    // contabilidad ya la honra (`autoPosting.service.ts` — "orden cancelada → sin ingreso"),
    // así que con esto sale de los libros sin tocar el Payment, que se conserva como
    // evidencia de lo que el proveedor llegó a reportar.
    await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } })

    // Quitar la comanda de la pantalla de cocina: es lo único que de verdad detiene el
    // desperdicio. `KdsOrderStatus` no tiene un estado "cancelado" (sólo NEW/PREPARING/
    // READY/COMPLETED), y marcarla COMPLETED sería mentir — "completada" y "cancelada" no
    // son lo mismo para nadie que lea ese tablero. Se borra; la verdad auditable vive en la
    // Order, en el ActivityLog y en el payload crudo del evento.
    await tx.kdsOrderItem.deleteMany({ where: { kdsOrder: { orderId: order.id } } })
    await tx.kdsOrder.deleteMany({ where: { orderId: order.id } })
  })

  // Devolver el stock va DESPUÉS y fuera de la transacción de arriba, y el orden es
  // deliberado: lo urgente es sacar la comanda de la cocina —eso detiene el desperdicio en
  // segundos—, y `reverseSalePosting` abre su propia transacción (Prisma no anida
  // interactivas). Si la reversa falla, la cancelación YA quedó firme: se grita, y como la
  // reversa es idempotente se puede reintentar sin devolver el stock dos veces.
  try {
    const rev = await reverseSalePosting({
      venueId: order.venueId,
      orderId: order.id,
      reason: `cancelación de delivery: ${motivo ?? 'sin motivo'}`,
    })
    if (rev.outcome === 'REVERSED') {
      logger.info('♻️ [DeliveryCancel] stock devuelto', { orderId: order.id, movimientos: rev.movements })
    }
  } catch (error) {
    // 🔴 `error` y no `warn`: un faltante de inventario que nadie ve aparece semanas después
    // en un conteo físico, ya sin forma de rastrear de dónde salió.
    logger.error('🚨 [DeliveryCancel] el pedido se canceló pero el STOCK NO SE DEVOLVIÓ — reconciliar a mano', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      externalId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  void logAction({
    action: 'DELIVERY_ORDER_CANCELLED',
    entity: 'Order',
    entityId: order.id,
    venueId: order.venueId,
    data: { externalId, provider, motivo: motivo ?? null, total: (order.total as Prisma.Decimal).toString() },
  })

  logger.info('🛵 [DeliveryCancel] pedido cancelado por el proveedor', {
    orderId: order.id,
    orderNumber: order.orderNumber,
    externalId,
    motivo,
  })
  return { outcome: 'CANCELLED', orderId: order.id }
}
