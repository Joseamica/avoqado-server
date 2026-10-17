import { OnlineOrderStatus, OrderStatus, type Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { SYNC_BATCH_SIZE } from './constants'
import { notifyOrderEvent } from './notifications.service'
import { emitOnlineOrderUpdated } from './traySocket'

/** Estados del pedido en línea que todavía esperan algo del restaurante. */
export const OPEN_ONLINE_STATUSES: OnlineOrderStatus[] = [
  OnlineOrderStatus.PENDING_ACCEPTANCE,
  OnlineOrderStatus.ACCEPTED,
  OnlineOrderStatus.READY,
]

/** `cancelledBy` cuando la cuenta se canceló por otra vía: no sabemos quién, sí que fue el negocio y no el comensal. */
export const CANCELLED_ELSEWHERE = 'ORDER_CANCELLED_ELSEWHERE'

/** Un pedido que ESTA pasada cerró (ganó su CAS): sólo éstos se anuncian. */
export interface CancelledElsewhere {
  id: string
  orderId: string
  venueId: string
  orderNumber: string
  orderStatus: OrderStatus
}

/**
 * R2 (resoluciones r1): las cancelaciones de una `Order` NO pasan por un punto común (`orderCancelWriters.test.ts` inventaría
 * siete escritores en seis archivos). Por eso el pedido en línea se sincroniza AL LEER, en un solo helper que usan la máquina
 * de estados (bajo el candado de la orden), el job de vencimiento (todos los negocios) y la bandeja (un negocio):
 * cuenta cancelada o borrada + pedido abierto ⇒ CAS a `CANCELLED_BY_STAFF`. Nunca se avisa como «vencido».
 *
 * I-1: lee con tope (`SYNC_BATCH_SIZE`; lo que sobre lo toma la siguiente pasada) y hace un CAS POR FILA sobre su `status`: si la
 * bandeja y el job chocan, una sola pasada gana cada pedido y sólo ésa lo devuelve. NO avisa: quien la llama anuncia a los
 * ganadores con `announceCancelledElsewhere` después del commit.
 */
export async function syncOnlineOrdersOfCancelledOrders(
  db: Pick<Prisma.TransactionClient, 'onlineOrder'>,
  scope: { venueId?: string; orderId?: string },
  now: Date,
): Promise<CancelledElsewhere[]> {
  const rows = await db.onlineOrder.findMany({
    where: {
      // `!== undefined`: un venueId vacío filtra (y no encuentra nada); nunca se vuelve «todos los negocios».
      ...(scope.venueId !== undefined ? { venueId: scope.venueId } : {}),
      ...(scope.orderId !== undefined ? { orderId: scope.orderId } : {}),
      status: { in: OPEN_ONLINE_STATUSES },
      order: { status: { in: [OrderStatus.CANCELLED, OrderStatus.DELETED] } },
    },
    select: { id: true, orderId: true, venueId: true, order: { select: { orderNumber: true, status: true } } },
    orderBy: { id: 'asc' },
    take: SYNC_BATCH_SIZE,
  })

  const won: CancelledElsewhere[] = []
  for (const r of rows) {
    const cas = await db.onlineOrder.updateMany({
      where: { id: r.id, status: { in: OPEN_ONLINE_STATUSES } },
      data: { status: OnlineOrderStatus.CANCELLED_BY_STAFF, cancelledAt: now, cancelledBy: CANCELLED_ELSEWHERE },
    })
    if (cas.count === 1) {
      won.push({ id: r.id, orderId: r.orderId, venueId: r.venueId, orderNumber: r.order.orderNumber, orderStatus: r.order.status })
    }
  }
  if (won.length > 0) {
    logger.info('[OnlineOrdering] pedidos en línea cerrados porque su cuenta se canceló por otra vía', { ...scope, count: won.length })
  }
  return won
}

/**
 * I-1: el comensal y la bandeja se enteran de lo que cerró R2. Sólo con los ganadores del CAS y DESPUÉS del commit: socket a la
 * bandeja, el aviso neutro «cancelado» (ruling de T8) y la bitácora con actor de sistema.
 */
export function announceCancelledElsewhere(won: CancelledElsewhere[], now: Date): void {
  for (const w of won) {
    emitOnlineOrderUpdated({
      venueId: w.venueId,
      orderId: w.orderId,
      orderNumber: w.orderNumber,
      onlineStatus: OnlineOrderStatus.CANCELLED_BY_STAFF,
      orderStatus: w.orderStatus,
      now,
    })
    void notifyOrderEvent(w.orderId, 'CANCELLED')
    void logAction({
      staffId: null,
      venueId: w.venueId,
      action: 'ONLINE_ORDER_CANCELLED_BY_STAFF',
      entity: 'OnlineOrder',
      entityId: w.id,
      data: { orderNumber: w.orderNumber, cancelledBy: CANCELLED_ELSEWHERE },
    })
  }
}
