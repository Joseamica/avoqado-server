/**
 * "Ya es hora": un pedido programado pasa a la cocina.
 *
 * 🔴 POR QUÉ ESTÁ SEPARADO DE LA INGESTA: un pedido programado entra como venta al recibirse
 * —para que exista, se vea y no se pierda— pero NO va a la cocina. El cliente lo pidió a las
 * 3pm para las 8pm; cocinarlo al llegar tira la comida y ocupa la pantalla toda la tarde con
 * algo que no toca. Este servicio es lo que corre cuando el proveedor avisa que ya toca
 * (`orders.release` en Uber).
 */
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

export type ReleaseOutcome = 'RELEASED' | 'ALREADY_IN_KITCHEN' | 'ORDER_NOT_FOUND'

export async function releaseScheduledOrder(externalId: string): Promise<{ outcome: ReleaseOutcome; orderId?: string }> {
  const order = await prisma.order.findFirst({
    where: { externalId },
    select: { id: true, venueId: true, orderNumber: true, scheduledFor: true },
  })
  if (!order) {
    logger.warn('[🕗 Release] llegó el aviso de hora de un pedido que no existe', { externalId })
    return { outcome: 'ORDER_NOT_FOUND' }
  }

  // Idempotente: los webhooks son at-least-once y una comanda duplicada hace que la cocina
  // prepare el pedido dos veces.
  if ((await prisma.kdsOrder.count({ where: { orderId: order.id } })) > 0) {
    return { outcome: 'ALREADY_IN_KITCHEN', orderId: order.id }
  }

  const items = await prisma.orderItem.findMany({
    where: { orderId: order.id },
    select: { productName: true, quantity: true },
  })

  await prisma.kdsOrder.create({
    data: {
      venueId: order.venueId,
      orderNumber: order.orderNumber,
      orderType: 'DELIVERY',
      orderId: order.id,
      items: { create: items.map(i => ({ productName: i.productName ?? 'Producto', quantity: i.quantity })) },
    },
  })

  logger.info('🕗 [Release] pedido programado enviado a la cocina', {
    orderId: order.id,
    orderNumber: order.orderNumber,
    eraPara: order.scheduledFor?.toISOString(),
  })
  return { outcome: 'RELEASED', orderId: order.id }
}
