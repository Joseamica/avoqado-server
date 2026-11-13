/**
 * "Ya es hora": un pedido programado pasa a la cocina.
 *
 * 🔴 POR QUÉ ESTÁ SEPARADO DE LA INGESTA: un pedido programado entra como venta al recibirse
 * —para que exista, se vea y no se pierda— pero NO va a la cocina. El cliente lo pidió a las
 * 3pm para las 8pm; cocinarlo al llegar tira la comida y ocupa la pantalla toda la tarde con
 * algo que no toca. Este servicio es lo que corre cuando el proveedor avisa que ya toca
 * (`orders.release` en Uber).
 */
import { OrderStatus } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { estacionDePantallaParaReparto } from '@/services/kds/kitchenDisplayStations'
import { toKdsModifierLabels } from '@/services/kds/kdsModifierLabels'
import { lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { contactoParaComanda } from './deliveryOrderIngestion.service'
import { withDeliveryOrderLock } from './deliveryOrderLock'
import { marcarRetirosEnComandas } from './lineRemoval.service'

/** `ORDER_CANCELLED`: el pedido ya se canceló (o ya no es de ese negocio): no se cocina y reintentar daría lo mismo. */
export type ReleaseOutcome = 'RELEASED' | 'ALREADY_IN_KITCHEN' | 'ORDER_NOT_FOUND' | 'ORDER_CANCELLED'

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

  // Etapa 3 del KDS: la estación se elige ANTES de tomar el candado; nunca lanza.
  const estacionReparto = await estacionDePantallaParaReparto(order.venueId)

  // 🔴 Lectura→creación bajo el candado del pedido [N-21]: un retiro concurrente espera a que
  // la comanda exista y la marca, o ya está en los `OrderItem` que se leen aquí y la comanda
  // nace con el renglón RETIRADO.
  const resultado = await withDeliveryOrderLock(order.id, async tx => {
    // 🔴 hz:ce654971:D3 (Codex r4 B7): un programado que se canceló antes de su hora no va a la cocina. Uber no ordena sus
    // webhooks, y un «ya es hora» que llegó antes que el pedido queda FAILED y se reintenta DESPUÉS: el aviso podía llegar con la
    // cuenta ya cancelada, y como `cancelDeliveryOrder` borra las comandas, la cuenta cancelada no tenía ninguna y aquí nacía una
    // viva. Como la ingesta (`deliveryOrderIngestion.service.ts`): candado de FILA de la cuenta —el MISMO de la cancelación y del
    // cobro— dentro del advisory del pedido, y su estado releído con él. La cancelación o ya terminó (se ve aquí) o espera a que
    // esta comanda exista (y la borra).
    if (!(await lockExistingOrderForPayment(tx, { venueId: order.venueId, orderId: order.id }))) return 'CANCELADA' as const
    const actual = await tx.order.findUnique({ where: { id: order.id }, select: { status: true } })
    if (!actual || actual.status === OrderStatus.CANCELLED || actual.status === OrderStatus.DELETED) return 'CANCELADA' as const
    // Idempotente: los webhooks son at-least-once y una comanda duplicada hace que la cocina
    // prepare el pedido dos veces.
    if ((await tx.kdsOrder.count({ where: { orderId: order.id } })) > 0) return 'YA_EXISTIA' as const

    const items = await tx.orderItem.findMany({
      where: { orderId: order.id },
      select: {
        id: true,
        productName: true,
        quantity: true,
        externalLineId: true,
        productId: true,
        notes: true,
        modifiers: { select: { name: true, quantity: true } },
      },
    })
    // Misma lectura que la ingesta inmediata: UNA consulta de categorías para todos los renglones (sin N+1).
    const idsProducto = [...new Set(items.map(i => i.productId).filter((v): v is string => Boolean(v)))]
    const categoriaPorProducto = new Map<string, string | null>()
    if (idsProducto.length) {
      const filas = await tx.product.findMany({ where: { id: { in: idsProducto } }, select: { id: true, categoryId: true }, take: idsProducto.length })
      for (const p of filas) categoriaPorProducto.set(p.id, p.categoryId)
    }

    await tx.kdsOrder.create({
      data: {
        venueId: order.venueId,
        orderNumber: order.orderNumber,
        orderType: 'DELIVERY',
        orderId: order.id,
        printStationId: estacionReparto,
        customerName: order.customerName ?? null,
        customerContact: contactoParaComanda(order.customerPhone, order.customerPhonePin),
        items: {
          create: items.map(i => ({
            productName: i.productName ?? 'Producto',
            quantity: i.quantity,
            // La misma liga que pone la ingesta: sin ella no hay renglón que retirar.
            orderItemId: i.id,
            externalLineId: i.externalLineId,
            // Los ids que hacen RUTEABLE la comanda y reconocible «Sin comanda» (igual que la ingesta inmediata).
            productId: i.productId,
            categoryId: categoriaPorProducto.get(i.productId ?? '') ?? null,
            // Nota y modificadores por el normalizador COMPARTIDO: «sin cebolla» no se pierde al liberar.
            modifiers: i.modifiers.length ? JSON.stringify(toKdsModifierLabels(i.modifiers)) : null,
            notes: i.notes ?? null,
          })),
        },
      },
    })
    await marcarRetirosEnComandas(tx, order.id, order.venueId)
    return 'CREADA' as const
  })
  if (resultado === 'CANCELADA') {
    logger.warn('[🕗 Release] llegó la hora de un pedido programado que ya se canceló: no va a la cocina', {
      orderId: order.id,
      orderNumber: order.orderNumber,
    })
    return { outcome: 'ORDER_CANCELLED', orderId: order.id }
  }
  if (resultado === 'YA_EXISTIA') return { outcome: 'ALREADY_IN_KITCHEN', orderId: order.id }

  logger.info('🕗 [Release] pedido programado enviado a la cocina', {
    orderId: order.id,
    orderNumber: order.orderNumber,
    eraPara: order.scheduledFor?.toISOString(),
  })
  return { outcome: 'RELEASED', orderId: order.id }
}
