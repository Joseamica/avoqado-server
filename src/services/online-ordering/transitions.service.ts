import { OnlineOrderStatus, OrderStatus, PaymentStatus, Prisma, type OnlineOrderRejectReason } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { debeMarcarCocina } from '@/services/kds/kitchenDisplayStations'
import { armarComandasTrasCommit } from '@/services/kds/kitchenTicketAuthoring.service'
import { findLiveTerminalCharge } from '@/services/shared/orderCancelGuard'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { announceCancelledElsewhere, syncOnlineOrdersOfCancelledOrders, type CancelledElsewhere } from './cancelledOrderSync'
import { OPEN_ORDER_STATUSES, PREPAID_MODES } from './constants'
import { notifyOrderEvent } from './notifications.service'
import { getSettings } from './settings.service'
import { emitOnlineOrderUpdated } from './traySocket'

export type TransitionResult =
  | { outcome: 'OK'; status: OnlineOrderStatus; estimatedReadyAt?: string | null }
  | { outcome: 'STALE'; status: OnlineOrderStatus | null }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'PAYMENT_REQUIRED' }
  | { outcome: 'HAS_PAYMENTS' }

type TransitionKind = 'ACCEPT' | 'REJECT' | 'EXPIRE' | 'CUSTOMER_CANCEL' | 'READY' | 'DELIVER'

const OPEN_ORDER = [...OPEN_ORDER_STATUSES] as OrderStatus[]

/**
 * R1: cada transición del pedido en línea y lo que le hace a su `Order`.
 * - `from` → `to`: el CAS del `OnlineOrder`.
 * - `order.when` → `order.to`: la `Order` sólo se mueve desde esos estados. Aceptar sólo confirma una `PENDING` (nunca reabre
 *   una cobrada); «listo» sólo desde `CONFIRMED`/`PREPARING` (una cobrada no regresa a abierta); nada revive una cancelada.
 * - `cancels`: la transición cancela la cuenta; exige que no tenga dinero ni un cobro de terminal vivo (§C.6).
 */
const RULES: Record<
  TransitionKind,
  { from: OnlineOrderStatus[]; to: OnlineOrderStatus; order: { when: OrderStatus[]; to: OrderStatus }; cancels: boolean }
> = {
  ACCEPT: {
    from: [OnlineOrderStatus.PENDING_ACCEPTANCE],
    to: OnlineOrderStatus.ACCEPTED,
    order: { when: [OrderStatus.PENDING], to: OrderStatus.CONFIRMED },
    cancels: false,
  },
  REJECT: {
    from: [OnlineOrderStatus.PENDING_ACCEPTANCE],
    to: OnlineOrderStatus.REJECTED,
    order: { when: OPEN_ORDER, to: OrderStatus.CANCELLED },
    cancels: true,
  },
  EXPIRE: {
    from: [OnlineOrderStatus.PENDING_ACCEPTANCE],
    to: OnlineOrderStatus.EXPIRED,
    order: { when: OPEN_ORDER, to: OrderStatus.CANCELLED },
    cancels: true,
  },
  CUSTOMER_CANCEL: {
    from: [OnlineOrderStatus.PENDING_ACCEPTANCE],
    to: OnlineOrderStatus.CANCELLED_BY_CUSTOMER,
    order: { when: OPEN_ORDER, to: OrderStatus.CANCELLED },
    cancels: true,
  },
  READY: {
    from: [OnlineOrderStatus.ACCEPTED],
    to: OnlineOrderStatus.READY,
    order: { when: [OrderStatus.CONFIRMED, OrderStatus.PREPARING], to: OrderStatus.READY },
    cancels: false,
  },
  DELIVER: {
    from: [OnlineOrderStatus.READY, OnlineOrderStatus.ACCEPTED],
    to: OnlineOrderStatus.COMPLETED,
    order: { when: OPEN_ORDER, to: OrderStatus.COMPLETED },
    cancels: false,
  },
}

type CasResult =
  | {
      r: 'OK'
      now: Date
      onlineOrderId: string
      orderNumber: string
      orderWritten: boolean
      /** M-7: el estado al que esta transición movió la cuenta, o `null` si no la escribió. */
      orderStatus: OrderStatus | null
    }
  | {
      r: 'STALE'
      now: Date
      status: OnlineOrderStatus | null
      deadlinePassed: boolean
      /** R2: lo que la sincronización cerró en esta transacción; se anuncia después del commit (I-1). */
      cancelledElsewhere?: CancelledElsewhere[]
    }
  | { r: 'NOT_FOUND' }
  | { r: 'HAS_PAYMENTS' }
  | { r: 'PAYMENT_REQUIRED' }

/** M-1: la transición cancela pero la cuenta no se escribió: se lanza para que Postgres revierta también el CAS en línea. */
class OrderNotWritten extends Error {
  constructor(readonly now: Date) {
    super('la cuenta no se canceló')
  }
}

/**
 * Un solo cambio de estado, bajo el candado de la orden: candado → reloj → relectura de `OnlineOrder` y `Order` → reglas de la
 * tabla `RULES` → CAS (`updateMany` con el estado esperado) → la `Order` desde los estados permitidos. Si otro actor ganó, el
 * CAS da 0 y no se toca nada más.
 */
async function casTransition(a: {
  kind: TransitionKind
  venueId: string
  orderId: string
  now?: Date
  onlineData: (now: Date) => Prisma.OnlineOrderUncheckedUpdateManyInput
  /** Campos extra de la `Order` (marca de cocina, `completedAt`); van en la MISMA escritura que mueve su estado. */
  orderExtra?: (now: Date) => Prisma.OrderUncheckedUpdateManyInput
  /** Condición extra del CAS; recibe si la cuenta ya tiene dinero (un pedido cobrado no vence). */
  extraWhere?: (now: Date, hasMoney: boolean) => Prisma.OnlineOrderWhereInput
}): Promise<CasResult> {
  const rule = RULES[a.kind]
  let result: CasResult
  try {
    result = await prisma.$transaction(async (tx): Promise<CasResult> => {
      if (!(await lockExistingOrderForPayment(tx, { venueId: a.venueId, orderId: a.orderId }))) return { r: 'NOT_FOUND' }
      // R1: el reloj se toma DESPUÉS del candado: esperar la orden no puede convertir una aceptación vencida en válida.
      const now = a.now ?? new Date()
      const row = await tx.onlineOrder.findFirst({
        where: { orderId: a.orderId, venueId: a.venueId },
        select: {
          id: true,
          status: true,
          paymentMode: true,
          acceptDeadlineAt: true,
          order: { select: { orderNumber: true, status: true, paymentStatus: true, paidAmount: true } },
        },
      })
      if (!row) return { r: 'NOT_FOUND' }
      const stale = (current: OnlineOrderStatus | null, deadlinePassed = false): Extract<CasResult, { r: 'STALE' }> => ({
        r: 'STALE',
        now,
        status: current,
        deadlinePassed,
      })

      // R2: la Order se canceló por otra vía (POS, panel, anular): el pedido se cierra con ella y nada lo revive ni lo «vence».
      if (row.order.status === OrderStatus.CANCELLED || row.order.status === OrderStatus.DELETED) {
        const cancelledElsewhere = await syncOnlineOrdersOfCancelledOrders(tx, { venueId: a.venueId, orderId: a.orderId }, now)
        const after = await tx.onlineOrder.findFirst({ where: { id: row.id }, select: { status: true } })
        return { ...stale(after?.status ?? null), cancelledElsewhere }
      }
      if (!rule.from.includes(row.status)) return stale(row.status)

      const hasMoney = row.order.paymentStatus !== PaymentStatus.PENDING || new Prisma.Decimal(row.order.paidAmount).gt(0)
      if (rule.cancels) {
        // Ninguna cuenta con dinero —ni con un cobro de terminal en curso— se cancela desde aquí: misma regla que
        // `assertOrderCancellableUnderLock`, sin lanzar (el job y la bandeja necesitan un desenlace, no un error).
        if (hasMoney) return { r: 'HAS_PAYMENTS' }
        if (await findLiveTerminalCharge(tx, { venueId: a.venueId, orderId: a.orderId })) return { r: 'HAS_PAYMENTS' }
      }
      // Se entrega cuando YA se cobró, leído bajo el candado (el cobro lo hace el flujo normal de caja). M-2: falla CERRADO: sólo
      // un modo ya cobrado de antemano (`PREPAID_MODES`, vacío en 1a) se libra de exigirlo.
      if (a.kind === 'DELIVER' && !PREPAID_MODES.includes(row.paymentMode) && row.order.paymentStatus !== PaymentStatus.PAID) {
        return { r: 'PAYMENT_REQUIRED' }
      }

      const cas = await tx.onlineOrder.updateMany({
        where: { id: row.id, status: { in: rule.from }, ...(a.extraWhere?.(now, hasMoney) ?? {}) },
        data: { status: rule.to, ...a.onlineData(now) },
      })
      if (cas.count !== 1) {
        const current = await tx.onlineOrder.findFirst({ where: { id: row.id }, select: { status: true, acceptDeadlineAt: true } })
        return stale(current?.status ?? null, !!current && current.acceptDeadlineAt.getTime() <= now.getTime())
      }

      const orderData: Prisma.OrderUncheckedUpdateManyInput = { status: rule.order.to, ...(a.orderExtra?.(now) ?? {}) }
      const written = await tx.order.updateMany({
        where: { id: a.orderId, venueId: a.venueId, status: { in: rule.order.when } },
        data: orderData,
      })
      // M-1: rechazar, vencer o cancelar sin cancelar la cuenta le diría al comensal «rechazado» o «vencido» con la venta viva
      // (p. ej. una cortesía ya cerrada sin dinero). Se revierte todo y se responde el estado vigente.
      if (rule.cancels && written.count !== 1) throw new OrderNotWritten(now)
      const orderWritten = written.count === 1
      return {
        r: 'OK',
        now,
        onlineOrderId: row.id,
        orderNumber: row.order.orderNumber,
        orderWritten,
        orderStatus: orderWritten ? rule.order.to : null,
      }
    }, ORDER_LOCK_WAIT_BUDGET)
  } catch (error) {
    if (!(error instanceof OrderNotWritten)) throw error
    const current = await prisma.onlineOrder.findFirst({ where: { orderId: a.orderId, venueId: a.venueId }, select: { status: true } })
    return { r: 'STALE', now: error.now, status: current?.status ?? null, deadlinePassed: false }
  }

  // I-1: lo que cerró la sincronización de R2 se anuncia aquí, ya con la transacción confirmada y sólo si ganó el CAS de la fila.
  if (result.r === 'STALE' && result.cancelledElsewhere) announceCancelledElsewhere(result.cancelledElsewhere, result.now)
  return result
}

function settled(r: Exclude<CasResult, { r: 'OK' }>): TransitionResult {
  switch (r.r) {
    case 'STALE':
      return { outcome: 'STALE', status: r.status }
    case 'NOT_FOUND':
      return { outcome: 'NOT_FOUND' }
    case 'HAS_PAYMENTS':
      return { outcome: 'HAS_PAYMENTS' }
    default:
      return { outcome: 'PAYMENT_REQUIRED' }
  }
}

export async function acceptOnlineOrder(i: {
  venueId: string
  orderId: string
  staffId: string | null
  estimatedMinutes?: number
  now?: Date
}): Promise<TransitionResult> {
  const { defaultPrepMinutes } = await getSettings(i.venueId)
  const minutes = Math.min(240, Math.max(1, Math.round(i.estimatedMinutes ?? defaultPrepMinutes)))
  // Igual que el cobro: la marca de comanda sólo si hace falta (nunca lanza).
  const marcarCocina = await debeMarcarCocina(i.venueId, { orderId: i.orderId })

  const r = await casTransition({
    kind: 'ACCEPT',
    venueId: i.venueId,
    orderId: i.orderId,
    now: i.now,
    // Sin dinero, sólo antes de la hora límite (compite con el vencimiento por el mismo CAS). Un pedido ya cobrado no vence:
    // el job no lo toca (R1) y queda en la bandeja para aceptarlo.
    extraWhere: (now, hasMoney) => (hasMoney ? {} : { acceptDeadlineAt: { gt: now } }),
    onlineData: now => ({ acceptedAt: now, estimatedReadyAt: new Date(now.getTime() + minutes * 60_000) }),
    // `kitchenPendingAt` es la marca que el barrido de comandas retoma si el armado de abajo falla; la pone la MISMA
    // escritura que confirma la orden (contrato de la columna).
    orderExtra: now => (marcarCocina ? { kitchenPendingAt: now } : {}),
  })
  if (r.r === 'STALE' && r.status === OnlineOrderStatus.PENDING_ACCEPTANCE && r.deadlinePassed) {
    // R1: aceptar perdió por la hora. Se vence aquí mismo y se responde el estado real, no un confuso «por aceptar».
    const expired = await expireOnlineOrder({ venueId: i.venueId, orderId: i.orderId, now: r.now })
    return {
      outcome: 'STALE',
      status: expired.outcome === 'OK' ? OnlineOrderStatus.EXPIRED : 'status' in expired ? expired.status : r.status,
    }
  }
  if (r.r !== 'OK') return settled(r)

  if (marcarCocina && r.orderWritten) void armarComandasTrasCommit(i.venueId, i.orderId, 'ROUND')
  emitOnlineOrderUpdated({
    venueId: i.venueId,
    orderId: i.orderId,
    orderNumber: r.orderNumber,
    onlineStatus: OnlineOrderStatus.ACCEPTED,
    orderStatus: r.orderStatus,
    now: r.now,
  })
  void notifyOrderEvent(i.orderId, 'ACCEPTED')
  void logAction({
    staffId: i.staffId,
    venueId: i.venueId,
    action: 'ONLINE_ORDER_ACCEPTED',
    entity: 'OnlineOrder',
    entityId: r.onlineOrderId,
    data: { orderNumber: r.orderNumber, estimatedMinutes: minutes },
  })
  return {
    outcome: 'OK',
    status: OnlineOrderStatus.ACCEPTED,
    estimatedReadyAt: new Date(r.now.getTime() + minutes * 60_000).toISOString(),
  }
}

export async function rejectOnlineOrder(i: {
  venueId: string
  orderId: string
  staffId: string | null
  reason: OnlineOrderRejectReason
  note?: string | null
  now?: Date
}): Promise<TransitionResult> {
  const r = await casTransition({
    kind: 'REJECT',
    venueId: i.venueId,
    orderId: i.orderId,
    now: i.now,
    onlineData: now => ({ rejectedAt: now, rejectReason: i.reason, rejectNote: i.note ?? null }),
  })
  if (r.r !== 'OK') return settled(r)

  emitOnlineOrderUpdated({
    venueId: i.venueId,
    orderId: i.orderId,
    orderNumber: r.orderNumber,
    onlineStatus: OnlineOrderStatus.REJECTED,
    orderStatus: r.orderStatus,
    now: r.now,
  })
  void notifyOrderEvent(i.orderId, 'REJECTED')
  void logAction({
    staffId: i.staffId,
    venueId: i.venueId,
    action: 'ONLINE_ORDER_REJECTED',
    entity: 'OnlineOrder',
    entityId: r.onlineOrderId,
    data: { orderNumber: r.orderNumber, reason: i.reason, note: i.note ?? null },
  })
  return { outcome: 'OK', status: OnlineOrderStatus.REJECTED }
}

export async function expireOnlineOrder(i: { venueId: string; orderId: string; now?: Date }): Promise<TransitionResult> {
  const r = await casTransition({
    kind: 'EXPIRE',
    venueId: i.venueId,
    orderId: i.orderId,
    now: i.now,
    extraWhere: now => ({ acceptDeadlineAt: { lte: now } }),
    onlineData: now => ({ expiredAt: now }),
  })
  if (r.r !== 'OK') return settled(r)

  emitOnlineOrderUpdated({
    venueId: i.venueId,
    orderId: i.orderId,
    orderNumber: r.orderNumber,
    onlineStatus: OnlineOrderStatus.EXPIRED,
    orderStatus: r.orderStatus,
    now: r.now,
  })
  void notifyOrderEvent(i.orderId, 'EXPIRED')
  void logAction({
    staffId: null,
    venueId: i.venueId,
    action: 'ONLINE_ORDER_EXPIRED',
    entity: 'OnlineOrder',
    entityId: r.onlineOrderId,
    data: { orderNumber: r.orderNumber },
  })
  return { outcome: 'OK', status: OnlineOrderStatus.EXPIRED }
}

export async function markOnlineOrderReady(i: {
  venueId: string
  orderId: string
  staffId: string | null
  now?: Date
}): Promise<TransitionResult> {
  const r = await casTransition({
    kind: 'READY',
    venueId: i.venueId,
    orderId: i.orderId,
    now: i.now,
    onlineData: now => ({ readyAt: now }),
  })
  if (r.r !== 'OK') return settled(r)

  emitOnlineOrderUpdated({
    venueId: i.venueId,
    orderId: i.orderId,
    orderNumber: r.orderNumber,
    onlineStatus: OnlineOrderStatus.READY,
    orderStatus: r.orderStatus,
    now: r.now,
  })
  void notifyOrderEvent(i.orderId, 'READY')
  void logAction({
    staffId: i.staffId,
    venueId: i.venueId,
    action: 'ONLINE_ORDER_READY',
    entity: 'OnlineOrder',
    entityId: r.onlineOrderId,
    data: { orderNumber: r.orderNumber },
  })
  return { outcome: 'OK', status: OnlineOrderStatus.READY }
}

export async function markOnlineOrderDelivered(i: {
  venueId: string
  orderId: string
  staffId: string | null
  now?: Date
}): Promise<TransitionResult> {
  const r = await casTransition({
    kind: 'DELIVER',
    venueId: i.venueId,
    orderId: i.orderId,
    now: i.now,
    onlineData: now => ({ completedAt: now }),
    // El cobro normalmente ya dejó la Order completada con su `completedAt` real: sólo se completa la que siga abierta.
    orderExtra: now => ({ completedAt: now }),
  })
  if (r.r !== 'OK') return settled(r)

  emitOnlineOrderUpdated({
    venueId: i.venueId,
    orderId: i.orderId,
    orderNumber: r.orderNumber,
    onlineStatus: OnlineOrderStatus.COMPLETED,
    orderStatus: r.orderStatus,
    now: r.now,
  })
  void logAction({
    staffId: i.staffId,
    venueId: i.venueId,
    action: 'ONLINE_ORDER_COLLECTED',
    entity: 'OnlineOrder',
    entityId: r.onlineOrderId,
    data: { orderNumber: r.orderNumber },
  })
  return { outcome: 'OK', status: OnlineOrderStatus.COMPLETED }
}

export async function cancelOnlineOrderByCustomer(i: { venueId: string; trackingToken: string; now?: Date }): Promise<TransitionResult> {
  const found = await prisma.onlineOrder.findUnique({
    where: { trackingToken: i.trackingToken },
    select: { orderId: true, venueId: true },
  })
  // El token vale sólo dentro del venue de la URL.
  if (!found || found.venueId !== i.venueId) return { outcome: 'NOT_FOUND' }

  const r = await casTransition({
    kind: 'CUSTOMER_CANCEL',
    venueId: i.venueId,
    orderId: found.orderId,
    now: i.now,
    onlineData: now => ({ cancelledAt: now, cancelledBy: 'CUSTOMER' }),
  })
  if (r.r !== 'OK') return settled(r)

  emitOnlineOrderUpdated({
    venueId: i.venueId,
    orderId: found.orderId,
    orderNumber: r.orderNumber,
    onlineStatus: OnlineOrderStatus.CANCELLED_BY_CUSTOMER,
    orderStatus: r.orderStatus,
    now: r.now,
  })
  // H9 (r2): sólo el ganador de la transición avisa; la página de seguimiento ya lo muestra, el correo lo confirma.
  void notifyOrderEvent(found.orderId, 'CANCELLED')
  void logAction({
    staffId: null,
    venueId: i.venueId,
    action: 'ONLINE_ORDER_CANCELLED_BY_CUSTOMER',
    entity: 'OnlineOrder',
    entityId: r.onlineOrderId,
    data: { orderNumber: r.orderNumber },
  })
  return { outcome: 'OK', status: OnlineOrderStatus.CANCELLED_BY_CUSTOMER }
}

/** El CAS del pedido perdió dentro de la cancelación existente: se lanza para que ESA transacción se revierta entera. */
class OnlineOrderChangedDuringCancel extends Error {}

const STAFF_CANCELLABLE: OnlineOrderStatus[] = [OnlineOrderStatus.ACCEPTED, OnlineOrderStatus.READY]

/**
 * R1: cancelar por personal NO escribe la `Order` a mano. Reutiliza `cancelOrder` de `order.mobile.service.ts` —candado de
 * cocina → orden (`lockTableOrderScope`), retiro de comandas, `assertOrderCancellableUnderLock` (sin dinero ni cobro vivo) y
 * los avisos de después del commit— y hace el CAS del pedido en línea con su gancho `dentroDeLaTx`, en la MISMA transacción.
 * Se pasa `reason` vacío a propósito: con motivo, la cancelación existente sobrescribe `specialRequests`, que aquí es la nota
 * del comensal. En 1a la cancelación por personal no lleva motivo (el `ActivityLog` de abajo sólo registra el folio).
 */
export async function cancelOnlineOrderByStaff(i: {
  venueId: string
  orderId: string
  staffId: string | null
  now?: Date
}): Promise<TransitionResult> {
  const row = await prisma.onlineOrder.findFirst({
    where: { orderId: i.orderId, venueId: i.venueId },
    select: { id: true, status: true, order: { select: { orderNumber: true } } },
  })
  if (!row) return { outcome: 'NOT_FOUND' }
  if (!STAFF_CANCELLABLE.includes(row.status)) return { outcome: 'STALE', status: row.status }

  const { cancelOrder } = await import('@/services/mobile/order.mobile.service')
  let cancelledAt = i.now ?? new Date()
  try {
    await cancelOrder(i.venueId, i.orderId, undefined, i.staffId ?? undefined, async tx => {
      cancelledAt = i.now ?? new Date() // ya con el candado de la orden
      const cas = await tx.onlineOrder.updateMany({
        where: { id: row.id, status: { in: STAFF_CANCELLABLE } },
        data: { status: OnlineOrderStatus.CANCELLED_BY_STAFF, cancelledAt, cancelledBy: i.staffId ?? 'STAFF' },
      })
      if (cas.count !== 1) throw new OnlineOrderChangedDuringCancel()
    })
  } catch (error) {
    if (error instanceof OnlineOrderChangedDuringCancel) {
      const current = await prisma.onlineOrder.findFirst({ where: { id: row.id }, select: { status: true } })
      return { outcome: 'STALE', status: current?.status ?? null }
    }
    // La guarda existente responde 400 cuando la cuenta ya tiene dinero: el camino es reembolsar y luego cancelar.
    if (error instanceof BadRequestError) return { outcome: 'HAS_PAYMENTS' }
    if (error instanceof NotFoundError) return { outcome: 'NOT_FOUND' }
    throw error // p. ej. 409 ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE: las apps ya lo conocen
  }

  emitOnlineOrderUpdated({
    venueId: i.venueId,
    orderId: i.orderId,
    orderNumber: row.order.orderNumber,
    onlineStatus: OnlineOrderStatus.CANCELLED_BY_STAFF,
    // Sin `orderStatus`: la cuenta la canceló `cancelOrder`, que ya publica su propio aviso de cancelación.
    now: cancelledAt,
  })
  void notifyOrderEvent(i.orderId, 'CANCELLED')
  void logAction({
    staffId: i.staffId,
    venueId: i.venueId,
    action: 'ONLINE_ORDER_CANCELLED_BY_STAFF',
    entity: 'OnlineOrder',
    entityId: row.id,
    data: { orderNumber: row.order.orderNumber },
  })
  return { outcome: 'OK', status: OnlineOrderStatus.CANCELLED_BY_STAFF }
}
