import { OnlineOrderStatus, OrderStatus, type Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import prisma from '@/utils/prismaClient'
import { CANCELLED_ELSEWHERE, OPEN_ONLINE_STATUSES, SYNC_BATCH_SIZE } from './constants'
import { notifyOrderEvent } from './notifications.service'
import { emitOnlineOrderUpdated } from './traySocket'
import type { ReadCandidates, Reloj } from './types'

// Viven en `constants.ts` (sin dependencias) para que el cobro capturado (`shared/cuentaCancelada.ts`) cierre el pedido con los
// MISMOS valores sin cargar este módulo (correo, WhatsApp, sockets). Se reexportan: los que ya los importaban de aquí siguen igual.
export { CANCELLED_ELSEWHERE, OPEN_ONLINE_STATUSES }

/** Un pedido que ESTA pasada cerró (ganó su CAS): sólo éstos se anuncian. */
export interface CancelledElsewhere {
  id: string
  orderId: string
  venueId: string
  orderNumber: string
  orderStatus: OrderStatus
}

const CUENTA_CANCELADA: Prisma.OrderWhereInput = { status: { in: [OrderStatus.CANCELLED, OrderStatus.DELETED] } }

/**
 * R2 (resoluciones r1): las cancelaciones de una `Order` NO pasan por un punto común (`orderCancelWriters.test.ts` inventaría
 * siete escritores en seis archivos). Por eso el pedido en línea se sincroniza AL LEER, en un solo helper que usan la máquina
 * de estados (bajo el candado de la orden), el job de vencimiento (todos los negocios) y la bandeja (un negocio):
 * cuenta cancelada o borrada + pedido abierto ⇒ CAS a `CANCELLED_BY_STAFF`. Nunca se avisa como «vencido».
 *
 * I-1: lee con tope (`SYNC_BATCH_SIZE`; lo que sobre lo toma la siguiente pasada) y hace un CAS POR FILA sobre su `status`: si la
 * bandeja y el job chocan, una sola pasada gana cada pedido y sólo ésa lo devuelve. NO avisa: quien la llama anuncia a los
 * ganadores con `announceCancelledElsewhere` después del commit.
 * A5: el CAS de cada fila va aparte; si uno falla se registra y la pasada sigue (las ganadoras se devuelven y se anuncian). Dentro
 * de la transacción de `casTransition` (una sola fila) un fallo deja la transacción abortada y su siguiente lectura lanza.
 * Tienda híbrida (R12): ésta es la forma DENTRO de una transacción que ya tiene el candado de la orden (`casTransitionInTx`). La
 * bandeja, las listas y el job usan `cerrarCanceladasReleyendo`, que relee la cuenta bajo el candado.
 */
export async function syncOnlineOrdersOfCancelledOrders(
  db: Pick<Prisma.TransactionClient, 'onlineOrder'>,
  scope: { venueId?: string; orderId?: string },
  now: Date,
  /** A10: sólo la LECTURA pasa por aquí (el job la reintenta por conexión); los CAS nunca. */
  readCandidates: ReadCandidates = read => read(),
): Promise<CancelledElsewhere[]> {
  const rows = await readCandidates(() =>
    db.onlineOrder.findMany({
      where: {
        // `!== undefined`: un venueId vacío filtra (y no encuentra nada); nunca se vuelve «todos los negocios».
        ...(scope.venueId !== undefined ? { venueId: scope.venueId } : {}),
        ...(scope.orderId !== undefined ? { orderId: scope.orderId } : {}),
        status: { in: OPEN_ONLINE_STATUSES },
        order: CUENTA_CANCELADA,
      },
      select: { id: true, orderId: true, venueId: true, order: { select: { orderNumber: true, status: true } } },
      orderBy: { id: 'asc' },
      take: SYNC_BATCH_SIZE,
    }),
  )

  const won: CancelledElsewhere[] = []
  for (const r of rows) {
    try {
      const cas = await db.onlineOrder.updateMany({
        where: { id: r.id, status: { in: OPEN_ONLINE_STATUSES } },
        data: { status: OnlineOrderStatus.CANCELLED_BY_STAFF, cancelledAt: now, cancelledBy: CANCELLED_ELSEWHERE },
      })
      if (cas.count === 1) {
        won.push({ id: r.id, orderId: r.orderId, venueId: r.venueId, orderNumber: r.order.orderNumber, orderStatus: r.order.status })
      }
    } catch (error) {
      logger.error('[OnlineOrdering] no se pudo cerrar un pedido cuya cuenta se canceló (la pasada sigue)', {
        onlineOrderId: r.id,
        venueId: r.venueId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (won.length > 0) {
    logger.info('[OnlineOrdering] pedidos en línea cerrados porque su cuenta se canceló por otra vía', { ...scope, count: won.length })
  }
  return won
}

/**
 * Tienda híbrida (R12, decisión 18): la forma de la bandeja, las listas y el job, con el cliente raíz. Lee los candidatos sin candado
 * y cierra cada uno en SU transacción, bajo el candado de la orden y con un CAS que vuelve a exigir la cuenta cancelada: si entre la
 * lectura y el candado el dinero tardío reabrió la cuenta y pasó el folio a «Por entregar» (`conciliarPedidoEnLinea`), no lo toca.
 * Antes el CAS sólo repetía «pedido abierto», y `ACCEPTED` lo es: una lectura vieja cancelaba lo que el dinero acababa de revivir.
 * Devuelve a los ganadores, ya confirmados: quien llama los anuncia con `announceCancelledElsewhere`.
 * R52: `cancelledAt` lee `reloj` ya con el candado, no la hora con la que empezó la pasada o la petición.
 */
export async function cerrarCanceladasReleyendo(
  scope: { venueId?: string },
  reloj: Reloj,
  readCandidates: ReadCandidates = read => read(),
): Promise<CancelledElsewhere[]> {
  const rows = await readCandidates(() =>
    prisma.onlineOrder.findMany({
      where: {
        ...(scope.venueId !== undefined ? { venueId: scope.venueId } : {}),
        status: { in: OPEN_ONLINE_STATUSES },
        order: CUENTA_CANCELADA,
      },
      select: { id: true, orderId: true, venueId: true, order: { select: { orderNumber: true, status: true } } },
      orderBy: { id: 'asc' },
      take: SYNC_BATCH_SIZE,
    }),
  )

  const won: CancelledElsewhere[] = []
  for (const r of rows) {
    try {
      const cerrado = await prisma.$transaction(async tx => {
        if (!(await lockExistingOrderForPayment(tx, { venueId: r.venueId, orderId: r.orderId }))) return false
        const cas = await tx.onlineOrder.updateMany({
          where: { id: r.id, status: { in: OPEN_ONLINE_STATUSES }, order: CUENTA_CANCELADA },
          data: { status: OnlineOrderStatus.CANCELLED_BY_STAFF, cancelledAt: reloj(), cancelledBy: CANCELLED_ELSEWHERE },
        })
        return cas.count === 1
      }, ORDER_LOCK_WAIT_BUDGET)
      if (cerrado) {
        won.push({ id: r.id, orderId: r.orderId, venueId: r.venueId, orderNumber: r.order.orderNumber, orderStatus: r.order.status })
      }
    } catch (error) {
      logger.error('[OnlineOrdering] no se pudo cerrar un pedido cuya cuenta se canceló (la pasada sigue)', {
        onlineOrderId: r.id,
        venueId: r.venueId,
        error: error instanceof Error ? error.message : String(error),
      })
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
