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
import { contactoParaComanda } from './deliveryOrderIngestion.service'
import { withDeliveryOrderLock } from './deliveryOrderLock'
import { marcarRetirosEnComandas } from './lineRemoval.service'

export type ReleaseOutcome = 'RELEASED' | 'ALREADY_IN_KITCHEN' | 'ORDER_NOT_FOUND'

export async function releaseScheduledOrder(externalId: string): Promise<{ outcome: ReleaseOutcome; orderId?: string }> {
  const order = await prisma.order.findFirst({
    where: { externalId },
    select: {
      id: true,
      venueId: true,
      orderNumber: true,
      scheduledFor: true,
      customerName: true,
      customerPhone: true,
      customerPhonePin: true,
    },
  })
  if (!order) {
    logger.warn('[🕗 Release] llegó el aviso de hora de un pedido que no existe', { externalId })
    return { outcome: 'ORDER_NOT_FOUND' }
  }

  // 🔴 Lectura→creación bajo el candado del pedido [N-21]: un retiro concurrente espera a que
  // la comanda exista y la marca, o ya está en los `OrderItem` que se leen aquí y la comanda
  // nace con el renglón RETIRADO.
  const creada = await withDeliveryOrderLock(order.id, async tx => {
    // Idempotente: los webhooks son at-least-once y una comanda duplicada hace que la cocina
    // prepare el pedido dos veces.
    if ((await tx.kdsOrder.count({ where: { orderId: order.id } })) > 0) return false

    const items = await tx.orderItem.findMany({
      where: { orderId: order.id },
      select: { id: true, productName: true, quantity: true, externalLineId: true },
    })

    await tx.kdsOrder.create({
      data: {
        venueId: order.venueId,
        orderNumber: order.orderNumber,
        orderType: 'DELIVERY',
        orderId: order.id,
        customerName: order.customerName ?? null,
        customerContact: contactoParaComanda(order.customerPhone, order.customerPhonePin),
        items: {
          create: items.map(i => ({
            productName: i.productName ?? 'Producto',
            quantity: i.quantity,
            // La misma liga que pone la ingesta: sin ella no hay renglón que retirar.
            orderItemId: i.id,
            externalLineId: i.externalLineId,
          })),
        },
      },
    })
    await marcarRetirosEnComandas(tx, order.id, order.venueId)
    return true
  })
  if (!creada) return { outcome: 'ALREADY_IN_KITCHEN', orderId: order.id }

  logger.info('🕗 [Release] pedido programado enviado a la cocina', {
    orderId: order.id,
    orderNumber: order.orderNumber,
    eraPara: order.scheduledFor?.toISOString(),
  })
  return { outcome: 'RELEASED', orderId: order.id }
}
