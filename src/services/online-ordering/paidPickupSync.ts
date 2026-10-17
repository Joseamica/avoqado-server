import { OnlineOrderPaymentMode, OnlineOrderStatus, OrderStatus, PaymentStatus, PaymentType, type Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { SYNC_BATCH_SIZE } from './constants'
import { emitOnlineOrderUpdated } from './traySocket'
import type { ReadCandidates } from './types'

/** Un pedido que ESTA pasada entregó (ganó su CAS): sólo éstos se anuncian. */
export interface CollectedAutomatically {
  id: string
  orderId: string
  venueId: string
  orderNumber: string
}

/**
 * La cuenta pagada completa, viva y SIN ningún reembolso registrado (A3: un reembolso es un `Payment` `REFUND` de la cuenta y
 * deja `paymentStatus: PAID`). Un pedido con reembolso no se entrega solo: lo decide una persona con «entregado».
 */
const PAID_ORDER: Prisma.OrderWhereInput = {
  paymentStatus: PaymentStatus.PAID,
  status: { notIn: [OrderStatus.CANCELLED, OrderStatus.DELETED] },
  payments: { none: { type: PaymentType.REFUND } },
}

/**
 * Opción 1 del founder (17-oct): cuando la cuenta de un pedido de pagar al recoger queda PAGADA completa, el pedido se entrega
 * solo (`COMPLETED`). Sin cierre por tiempo. Misma forma que R2 (`cancelledOrderSync.ts`): lectura con tope, CAS por fila sobre
 * el estado leído, y el anuncio después del commit con `announceCollectedAutomatically`. La llaman la bandeja y el job, en la
 * misma pasada y DESPUÉS de R2; nunca la máquina de estados.
 * - `paymentMode` explícito: en la fase 2 la tarjeta queda PAGADA al aceptar y sin este filtro se «entregaría» sola.
 * - ACEPTADO espera a su hora estimada: quien pagó al llegar con la comida aún en la cocina no desaparece de «En preparación».
 * - Nunca `PENDING_ACCEPTANCE` (un pedido pagado antes de aceptarse lo sigue aceptando una persona, R1); `PARTIAL`, `REFUNDED`
 *   o una cuenta con cualquier reembolso (A3) no cierran. El CAS repite el filtro de la cuenta: un reembolso que cae entre la
 *   lectura y la escritura tampoco se entrega.
 * - A5: el CAS de cada fila va aparte; si uno falla se registra y la pasada sigue con las demás (sus ganadoras se anuncian).
 * - Sólo escribe el pedido en línea: la cuenta ya la cerró el cobro.
 */
export async function syncOnlineOrdersOfPaidPickups(
  db: Pick<Prisma.TransactionClient, 'onlineOrder'>,
  scope: { venueId?: string },
  now: Date,
  /** A10: sólo la LECTURA pasa por aquí (el job la reintenta por conexión); los CAS nunca. */
  readCandidates: ReadCandidates = read => read(),
): Promise<CollectedAutomatically[]> {
  const rows = await readCandidates(() =>
    db.onlineOrder.findMany({
      where: {
        ...(scope.venueId !== undefined ? { venueId: scope.venueId } : {}),
        paymentMode: OnlineOrderPaymentMode.PAY_AT_PICKUP,
        order: PAID_ORDER,
        OR: [{ status: OnlineOrderStatus.READY }, { status: OnlineOrderStatus.ACCEPTED, estimatedReadyAt: { lte: now } }],
      },
      select: { id: true, orderId: true, venueId: true, status: true, order: { select: { orderNumber: true } } },
      orderBy: { id: 'asc' },
      take: SYNC_BATCH_SIZE,
    }),
  )

  const won: CollectedAutomatically[] = []
  for (const r of rows) {
    try {
      const cas = await db.onlineOrder.updateMany({
        where: { id: r.id, status: r.status, order: PAID_ORDER },
        data: { status: OnlineOrderStatus.COMPLETED, completedAt: now },
      })
      if (cas.count === 1) won.push({ id: r.id, orderId: r.orderId, venueId: r.venueId, orderNumber: r.order.orderNumber })
    } catch (error) {
      logger.error('[OnlineOrdering] no se pudo entregar solo un pedido ya pagado (la pasada sigue)', {
        onlineOrderId: r.id,
        venueId: r.venueId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (won.length > 0) {
    logger.info('[OnlineOrdering] pedidos de pagar al recoger entregados solos al quedar pagados', { ...scope, count: won.length })
  }
  return won
}

/** Socket a la bandeja y bitácora con actor de sistema. Sin aviso al comensal: ya está en el mostrador. */
export function announceCollectedAutomatically(won: CollectedAutomatically[], now: Date): void {
  for (const w of won) {
    emitOnlineOrderUpdated({
      venueId: w.venueId,
      orderId: w.orderId,
      orderNumber: w.orderNumber,
      onlineStatus: OnlineOrderStatus.COMPLETED,
      now,
    })
    void logAction({
      staffId: null,
      venueId: w.venueId,
      action: 'ONLINE_ORDER_COLLECTED',
      entity: 'OnlineOrder',
      entityId: w.id,
      data: { orderNumber: w.orderNumber, automatic: true },
    })
  }
}
