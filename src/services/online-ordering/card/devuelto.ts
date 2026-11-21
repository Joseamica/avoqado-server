// src/services/online-ordering/card/devuelto.ts
/**
 * D661 (Task 5): el cierre «Devuelto» de un pedido con tarjeta de «Nadie», COMPARTIDO por los dos destinos de la devolución (la
 * tarjeta y, en la Task 6, el saldo a favor). No cancela nada («Cierre por devolución» del plan): el pedido pasa a «Entregado»
 * (`COMPLETED`) con `refundedAt` y la venta queda como cualquier venta reembolsada (PAID con renglones REFUND). `COMPLETED` no está en
 * `FOLIO_CERRADO`, así que ni `syncPaidClosedFolios` ni `revivirFolioSaldadoEnTx` lo reviven.
 */
import { OnlineOrderCardRefundStatus as R, OnlineOrderPaymentMode, OnlineOrderStatus, type Prisma } from '@prisma/client'
import { lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'

/** Una devolución que YA tiene su renglón REFUND en el libro: a la tarjeta anotada, revertida o resuelta (y el saldo a favor nace RESOLVED). */
export const DEVOLUCION_ANOTADA: R[] = [R.RECORDED, R.REVERSED, R.RESOLVED]
/** Lo que una devolución de «Nadie» reserva (y cierra desde la reserva): por entregar. */
export const ENTREGABLE: OnlineOrderStatus[] = [OnlineOrderStatus.ACCEPTED, OnlineOrderStatus.READY]
/**
 * Ya «Entregado» (una persona) o «No lo recogió» (el cierre del día): sólo se le pone la marca. Se LEE en lista: `status:
 * OnlineOrderStatus.COMPLETED` es la forma de una escritura y la vigila `escritoresDeEntregado`.
 */
export const YA_ENTREGADO: OnlineOrderStatus[] = [OnlineOrderStatus.COMPLETED]

export type CierreDevuelto = { cerrado: false } | { cerrado: true; onlineOrderId: string; orderNumber: string; desde: OnlineOrderStatus }

/**
 * Cierra «Devuelto», bajo el candado de la orden (lo toma aquí: tomarlo otra vez en la misma transacción no espera). Garantías:
 * - Sólo un pedido de «Nadie» (`requiresAcceptance: false`) pagado con tarjeta en línea, y sólo si su cargo ya tiene una devolución
 *   ANOTADA (con su renglón REFUND): nunca «Devuelto» sin el dinero devuelto en el libro.
 * - `ACCEPTED`/`READY` sólo con su reserva (`refundRequestedAt`) → `COMPLETED` + `completedAt` + `refundedAt`. Ya `COMPLETED`
 *   (entregado o «No lo recogió») → sólo `refundedAt`. Cualquier otro estado, o ya con `refundedAt`: nada (`cerrado: false`).
 * - Cada rama es un CAS que repite todas sus condiciones: idempotente, y la que gana escribe en la MISMA transacción la cocina limpia
 *   (`kitchenPendingAt = null`: lo devuelto ya no se cocina) y su bitácora `ONLINE_ORDER_CLOSED_AS_REFUNDED`, una sola vez.
 * Quien llama avisa a la bandeja después del commit.
 */
export async function cerrarComoDevueltoEnTx(
  tx: Prisma.TransactionClient,
  i: { venueId: string; orderId: string; now: Date; staffId?: string | null },
): Promise<CierreDevuelto> {
  if (!(await lockExistingOrderForPayment(tx, { venueId: i.venueId, orderId: i.orderId }))) return { cerrado: false }
  const row = await tx.onlineOrder.findFirst({
    where: { orderId: i.orderId, venueId: i.venueId },
    select: { id: true, status: true, order: { select: { orderNumber: true } } },
  })
  if (!row) return { cerrado: false }
  const anotada = { charge: { is: { cardRefunds: { some: { status: { in: DEVOLUCION_ANOTADA } } } } } }
  const cas = ENTREGABLE.includes(row.status)
    ? await tx.onlineOrder.updateMany({
        where: {
          id: row.id,
          requiresAcceptance: false,
          paymentMode: OnlineOrderPaymentMode.CARD_ONLINE,
          refundRequestedAt: { not: null },
          status: { in: ENTREGABLE },
          refundedAt: null,
          ...anotada,
        },
        data: { status: OnlineOrderStatus.COMPLETED, completedAt: i.now, refundedAt: i.now },
      })
    : await tx.onlineOrder.updateMany({
        where: {
          id: row.id,
          requiresAcceptance: false,
          paymentMode: OnlineOrderPaymentMode.CARD_ONLINE,
          status: { in: YA_ENTREGADO },
          refundedAt: null,
          ...anotada,
        },
        data: { refundedAt: i.now },
      })
  if (cas.count !== 1) return { cerrado: false }
  await tx.order.updateMany({ where: { id: i.orderId, venueId: i.venueId }, data: { kitchenPendingAt: null } })
  await tx.activityLog.create({
    data: {
      venueId: i.venueId,
      staffId: i.staffId ?? null,
      action: 'ONLINE_ORDER_CLOSED_AS_REFUNDED',
      entity: 'OnlineOrder',
      entityId: row.id,
      data: { orderNumber: row.order.orderNumber, desde: row.status },
    },
  })
  return { cerrado: true, onlineOrderId: row.id, orderNumber: row.order.orderNumber, desde: row.status }
}
