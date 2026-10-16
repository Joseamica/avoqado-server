import { OnlineOrderStatus, OrderStatus, type Prisma } from '@prisma/client'
import logger from '@/config/logger'

/** Estados del pedido en línea que todavía esperan algo del restaurante. */
export const OPEN_ONLINE_STATUSES: OnlineOrderStatus[] = [
  OnlineOrderStatus.PENDING_ACCEPTANCE,
  OnlineOrderStatus.ACCEPTED,
  OnlineOrderStatus.READY,
]

/** `cancelledBy` cuando la cuenta se canceló por otra vía: no sabemos quién, sí que fue el negocio y no el comensal. */
export const CANCELLED_ELSEWHERE = 'ORDER_CANCELLED_ELSEWHERE'

/**
 * R2 (resoluciones r1): las cancelaciones de una `Order` NO pasan por un punto común (`orderCancelWriters.test.ts` inventaría
 * siete escritores en seis archivos). Por eso el pedido en línea se sincroniza AL LEER, en un solo helper que usan la máquina
 * de estados (bajo el candado de la orden), el job de vencimiento (todos los negocios) y la bandeja (un negocio):
 * cuenta cancelada o borrada + pedido abierto ⇒ CAS a `CANCELLED_BY_STAFF`. Nunca se avisa como «vencido».
 */
export async function syncOnlineOrdersOfCancelledOrders(
  db: Pick<Prisma.TransactionClient, 'onlineOrder'>,
  scope: { venueId?: string; orderId?: string },
  now: Date,
): Promise<number> {
  const r = await db.onlineOrder.updateMany({
    where: {
      ...(scope.venueId ? { venueId: scope.venueId } : {}),
      ...(scope.orderId ? { orderId: scope.orderId } : {}),
      status: { in: OPEN_ONLINE_STATUSES },
      order: { status: { in: [OrderStatus.CANCELLED, OrderStatus.DELETED] } },
    },
    data: { status: OnlineOrderStatus.CANCELLED_BY_STAFF, cancelledAt: now, cancelledBy: CANCELLED_ELSEWHERE },
  })
  if (r.count > 0) {
    logger.info('[OnlineOrdering] pedidos en línea cerrados porque su cuenta se canceló por otra vía', { ...scope, count: r.count })
  }
  return r.count
}
