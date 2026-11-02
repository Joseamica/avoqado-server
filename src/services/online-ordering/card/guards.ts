// src/services/online-ordering/card/guards.ts
/**
 * Fase 2 — un pedido pagado con tarjeta en línea ya tiene su dinero en Stripe (apartado o cobrado). Nada de la caja, la terminal,
 * la cola sin red, el panel o el MCP lo cobra otra vez, le cambia el dinero ni le devuelve a mano el cobro de Stripe. Cada
 * guarda corre con el `tx` (y bajo el candado) del escritor que protege. Pagar al recoger no tiene cargo: no cambia nada.
 */
import { OnlineOrderChargeStatus, OnlineOrderPaymentMode, type Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { ConflictError } from '@/errors/AppError'

type Db = Pick<Prisma.TransactionClient, 'onlineOrder' | 'payment'>

export const ONLINE_ORDER_PAID_BY_CARD = 'ONLINE_ORDER_PAID_BY_CARD' as const
export const MENSAJE_PAGADO_CON_TARJETA = 'Este pedido ya se pagó con tarjeta en línea. No lo cobres en caja.'

export const cardOnlineOrderError = (details?: unknown) =>
  new ConflictError(MENSAJE_PAGADO_CON_TARJETA, ONLINE_ORDER_PAID_BY_CARD, details)

/** El pedido en línea con tarjeta de esta cuenta y el estado de su cargo, o `null` (no es pedido en línea o paga al recoger). */
export async function findCardOnlineOrderInTx(db: Db, i: { venueId: string; orderId: string }) {
  const row = await db.onlineOrder.findFirst({
    where: { orderId: i.orderId, venueId: i.venueId },
    select: { paymentMode: true, charge: { select: { id: true, status: true, paymentIntentId: true } } },
  })
  return row?.paymentMode === OnlineOrderPaymentMode.CARD_ONLINE ? row : null
}

export async function isCardOnlineOrderInTx(db: Db, i: { venueId: string; orderId: string }): Promise<boolean> {
  return (await findCardOnlineOrderInTx(db, i)) != null
}

/** Un cobro NUEVO (efectivo, terminal, manual, liquidar, cripto, saldo) sobre un pedido de tarjeta ⇒ 409. */
export async function assertNotCardOnlineOrderInTx(db: Db, i: { venueId: string; orderId: string }): Promise<void> {
  if (await isCardOnlineOrderInTx(db, i)) throw cardOnlineOrderError()
}

/**
 * Cambiar el dinero de la cuenta (renglones, descuentos, cortesías, cargos, dividir, juntar) de un pedido de tarjeta sin cobrar ⇒
 * 409: el cargo apartado es por un total fijo. Ya cobrado (`CAPTURED`) la cuenta está PAID y mandan las reglas de hoy.
 */
export async function assertCardOrderMoneyFrozenInTx(db: Db, i: { venueId: string; orderId: string }): Promise<void> {
  const card = await findCardOnlineOrderInTx(db, i)
  if (card && card.charge?.status !== OnlineOrderChargeStatus.CAPTURED) {
    throw new ConflictError(
      'Este pedido se pagó con tarjeta en línea por un total fijo; no se puede modificar.',
      ONLINE_ORDER_PAID_BY_CARD,
    )
  }
}

/**
 * El cobro de Stripe de un cargo (su `processorId` es el PaymentIntent del cargo, como lo escribe la captura) sólo se devuelve
 * desde Pedidos en línea, que regresa el dinero a la tarjeta. Otro pago de la misma cuenta (p. ej. un cobro tardío de la TPV) sigue
 * su camino de siempre.
 */
export async function assertCardRefundGoesThroughOnlineOrders(
  db: Db,
  i: {
    venueId: string
    paymentId: string
    viaOnlineOrders?: true
    /** El pago ya leído por quien llama (su `orderId` lo revalida el candado del cobro; `processorId` no cambia): ahorra la lectura. */
    payment?: { orderId: string | null; processorId: string | null }
  },
): Promise<void> {
  if (i.viaOnlineOrders === true) return
  const payment =
    i.payment ??
    (await db.payment.findFirst({ where: { id: i.paymentId, venueId: i.venueId }, select: { orderId: true, processorId: true } }))
  if (!payment?.orderId || !payment.processorId) return
  const card = await findCardOnlineOrderInTx(db, { venueId: i.venueId, orderId: payment.orderId })
  // `charge.paymentIntentId` siempre existe desde AUTHORIZED (la confirmación lo escribe), y la captura escribe el `processorId` con
  // `state.paymentIntentId ?? charge.paymentIntentId`: el mismo PI. Sin PI (PENDING_AUTH) aún no hay cobro de Stripe que proteger.
  if (card?.charge?.paymentIntentId && card.charge.paymentIntentId === payment.processorId) {
    throw new ConflictError(
      'Devuelve este pago desde Pedidos en línea para que regrese a la tarjeta del cliente.',
      'ONLINE_ORDER_REFUND_VIA_ONLINE_ORDERS',
    )
  }
}

/**
 * Un cobro YA hecho (la TPV registra dinero que ya se movió) no se rechaza. Si el pedido de tarjeta ya estaba cobrado, el cliente
 * pagó dos veces: 🚨 y bitácora para que el negocio devuelva uno. Va después del commit y nunca lanza.
 */
export async function avisarCobroDobleSobrePedidoConTarjeta(
  db: Db,
  i: { venueId: string; orderId: string; paymentId: string; staffId?: string | null; source: string },
): Promise<void> {
  try {
    const card = await findCardOnlineOrderInTx(db, i)
    if (card?.charge?.status !== OnlineOrderChargeStatus.CAPTURED) return
    logger.error('🚨 [OnlineOrderCard] cobro registrado sobre un pedido ya cobrado con tarjeta: el cliente pagó dos veces', i)
    // Import dinámico: las guardas cargan en `orderCancelGuard` y los cobros; la bitácora sólo hace falta aquí.
    const { logAction } = await import('@/services/dashboard/activity-log.service')
    await logAction({
      staffId: i.staffId ?? null,
      venueId: i.venueId,
      action: 'ONLINE_ORDER_CARD_DOUBLE_PAYMENT',
      entity: 'Order',
      entityId: i.orderId,
      data: { paymentId: i.paymentId, chargeId: card.charge.id, source: i.source },
    })
  } catch (error) {
    logger.error('[OnlineOrderCard] no se pudo revisar el cobro doble', { ...i, error: error instanceof Error ? error.message : String(error) })
  }
}
