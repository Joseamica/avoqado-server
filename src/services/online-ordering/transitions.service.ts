import {
  OnlineOrderChargeStatus,
  OnlineOrderPaymentMode,
  OnlineOrderStatus,
  OrderStatus,
  PaymentStatus,
  Prisma,
  TransactionStatus,
  type OnlineOrderRejectReason,
} from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { withDeadlockRetry, type TxConReintento } from '@/utils/serializableRetry'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { debeMarcarCocina } from '@/services/kds/kitchenDisplayStations'
import { armarComandasTrasCommit } from '@/services/kds/kitchenTicketAuthoring.service'
import { devolverCanjesDeVentaAnuladaEnTx, findLiveTerminalCharge } from '@/services/shared/orderCancelGuard'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { releaseCharge } from './card/release.service'
import { announceCancelledElsewhere, syncOnlineOrdersOfCancelledOrders, type CancelledElsewhere } from './cancelledOrderSync'
import { esVentaCerrada } from '@/services/shared/orderBalance'
import { OPEN_ORDER_STATUSES, PREPAID_MODES } from './constants'
import { notifyOrderEvent } from './notifications.service'
import { getSettings } from './settings.service'
import { emitOnlineOrderUpdated } from './traySocket'
import type { Reloj } from './types'

export type TransitionResult =
  /** `unchanged`: ya estaba en ese estado y no se escribió nada (A12: entregar lo ya entregado). */
  | { outcome: 'OK'; status: OnlineOrderStatus; estimatedReadyAt?: string | null; unchanged?: true }
  | { outcome: 'STALE'; status: OnlineOrderStatus | null }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'PAYMENT_REQUIRED' }
  | { outcome: 'HAS_PAYMENTS' }
  /** Fase 2: el banco está cobrando la tarjeta del pedido; nada lo mueve hasta saber el desenlace. */
  | { outcome: 'CONFIRMING_PAYMENT' }

export type TransitionKind = 'ACCEPT' | 'REJECT' | 'EXPIRE' | 'CUSTOMER_CANCEL' | 'READY' | 'DELIVER'

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

export type CasResult =
  | {
      r: 'OK'
      now: Date
      onlineOrderId: string
      orderNumber: string
      orderWritten: boolean
      /** M-7: el estado al que esta transición movió la cuenta, o `null` si no la escribió. */
      orderStatus: OrderStatus | null
      /** Fase 2: esta transición canceló y pasó el cargo AUTHORIZED → RELEASING; el llamador libera la tarjeta tras el commit. */
      releaseChargeId?: string
    }
  | {
      r: 'STALE'
      now: Date
      status: OnlineOrderStatus | null
      deadlinePassed: boolean
      /** R2: lo que la sincronización cerró en esta transacción; se anuncia después del commit (I-1). */
      cancelledElsewhere?: CancelledElsewhere[]
      /** Fase 2: el cargo de tarjeta está en `CAPTURING`; no se escribió nada. */
      confirmingPayment?: true
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

export interface CasArgs {
  kind: TransitionKind
  venueId: string
  orderId: string
  /** Una hora fija (pruebas, o quien ya la leyó bajo SU candado). Sin ella se lee `reloj` (o el reloj del sistema) bajo el candado. */
  now?: Date
  /** R52: el reloj del trabajo; se lee aquí, DESPUÉS del candado. */
  reloj?: Reloj
  onlineData: (now: Date) => Prisma.OnlineOrderUncheckedUpdateManyInput
  /** Campos extra de la `Order` (marca de cocina, `completedAt`); van en la MISMA escritura que mueve su estado. */
  orderExtra?: (now: Date) => Prisma.OrderUncheckedUpdateManyInput
  /** Condición extra del CAS; recibe si la cuenta ya tiene dinero (un pedido cobrado no vence). */
  extraWhere?: (now: Date, hasMoney: boolean) => Prisma.OnlineOrderWhereInput
  /** Fase 2: sólo la captura misma, que termina su propia aceptación o rechazo, corre con el cargo en `CAPTURING`. */
  allowCapturing?: true
}

/**
 * Un solo cambio de estado, bajo el candado de la orden, en la transacción que recibe: candado → reloj → relectura de
 * `OnlineOrder`, su cargo de tarjeta y la `Order` → reglas de la tabla `RULES` → CAS (`updateMany` con el estado esperado) → la
 * `Order` desde los estados permitidos. Si otro actor ganó, el CAS da 0 y no se toca nada más. M-1: lanza `OrderNotWritten`
 * cuando cancela sin poder cancelar la cuenta, para que quien abrió la transacción la revierta entera.
 */
export async function casTransitionInTx(tx: TxConReintento, a: CasArgs): Promise<CasResult> {
  const rule = RULES[a.kind]
  if (!(await lockExistingOrderForPayment(tx, { venueId: a.venueId, orderId: a.orderId }))) return { r: 'NOT_FOUND' }
  // R1: el reloj se toma DESPUÉS del candado: esperar la orden no puede convertir una aceptación vencida en válida. R52: también el
  // del trabajo (`reloj`), así lo escrito (`expiredAt`, `acceptedAt`…) es la hora de la escritura y no la del inicio de la pasada.
  const now = a.now ?? a.reloj?.() ?? new Date()
  const row = await tx.onlineOrder.findFirst({
    where: { orderId: a.orderId, venueId: a.venueId },
    select: {
      id: true,
      status: true,
      paymentMode: true,
      requiresAcceptance: true,
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

  // Fase 2: mientras el banco cobra la tarjeta, nada mueve el pedido (ni lo sincroniza con una cancelación de otra vía): el
  // desenlace lo decide la captura, que corre con `allowCapturing`. Pagar al recoger no tiene cargo.
  const charge = await tx.onlineOrderCharge.findUnique({ where: { onlineOrderId: row.id }, select: { id: true, status: true } })
  if (charge?.status === OnlineOrderChargeStatus.CAPTURING && a.allowCapturing !== true) {
    return { ...stale(row.status), confirmingPayment: true }
  }

  // R2: la Order se canceló por otra vía (POS, panel, anular): el pedido se cierra con ella y nada lo revive ni lo «vence».
  if (row.order.status === OrderStatus.CANCELLED || row.order.status === OrderStatus.DELETED) {
    const cancelledElsewhere = await syncOnlineOrdersOfCancelledOrders(tx, { venueId: a.venueId, orderId: a.orderId }, now)
    const after = await tx.onlineOrder.findFirst({ where: { id: row.id }, select: { status: true } })
    return { ...stale(after?.status ?? null), cancelledElsewhere }
  }
  if (!rule.from.includes(row.status)) return stale(row.status)
  // R46: un folio no se rechaza: se quita con «Cancelar folio» (§12, `orders:cancel-unpaid`). Un REJECTED de folio queda sólo por
  // datos que lo traigan.
  if (a.kind === 'REJECT' && row.requiresAcceptance === false) return stale(row.status)

  const hasMoney = row.order.paymentStatus !== PaymentStatus.PENDING || new Prisma.Decimal(row.order.paidAmount).gt(0)
  // R44: un folio cuyo abono se reembolsó completo (cuenta PARTIAL con dinero neto 0, leído aquí bajo el candado que también toman
  // los cobros y los reembolsos) se trata como «sin dinero» SÓLO para vencer: queda EXPIRED SIN cancelar su cuenta (la guarda
  // compartida no cancela una PARTIAL) y sale de «Por pagar». Si después llega dinero, `syncPaidClosedFolios` lo revive.
  const venceSinCancelar =
    a.kind === 'EXPIRE' &&
    row.requiresAcceptance === false &&
    row.order.paymentStatus === PaymentStatus.PARTIAL &&
    !(await netoCobradoPorCuenta(tx, [a.orderId])).get(a.orderId)?.gt(0)
  const cancela = rule.cancels && !venceSinCancelar
  if (rule.cancels) {
    // Ninguna cuenta con dinero —ni con un cobro de terminal en curso— se cancela desde aquí: misma regla que
    // `assertOrderCancellableUnderLock`, sin lanzar (el job y la bandeja necesitan un desenlace, no un error).
    if (hasMoney && !venceSinCancelar) return { r: 'HAS_PAYMENTS' }
    if (await findLiveTerminalCharge(tx, { venueId: a.venueId, orderId: a.orderId })) return { r: 'HAS_PAYMENTS' }
  }
  // Se entrega cuando YA se cobró, leído bajo el candado (el cobro lo hace el flujo normal de caja). M-2: falla CERRADO: sólo
  // un modo ya cobrado de antemano (`PREPAID_MODES`: la tarjeta en línea, que se captura al aceptar) se libra de exigirlo.
  if (a.kind === 'DELIVER' && !PREPAID_MODES.includes(row.paymentMode) && row.order.paymentStatus !== PaymentStatus.PAID) {
    return { r: 'PAYMENT_REQUIRED' }
  }

  // Un folio (`requiresAcceptance:false`, QR o liga) no se prepara sin pago: aceptar exige la venta cobrada (`esVentaCerrada`).
  if (a.kind === 'ACCEPT' && row.requiresAcceptance === false && !esVentaCerrada(row.order.paymentStatus)) {
    return { r: 'PAYMENT_REQUIRED' }
  }

  const cas = await tx.onlineOrder.updateMany({
    where: {
      id: row.id,
      status: { in: rule.from },
      ...(a.extraWhere?.(now, hasMoney) ?? {}),
      ...(venceSinCancelar ? { requiresAcceptance: false } : {}),
    },
    data: { status: rule.to, ...a.onlineData(now) },
  })
  if (cas.count !== 1) {
    const current = await tx.onlineOrder.findFirst({ where: { id: row.id }, select: { status: true, acceptDeadlineAt: true } })
    return stale(current?.status ?? null, !!current && current.acceptDeadlineAt.getTime() <= now.getTime())
  }

  // 🔴 LEALTAD (hz:a8104ac8:D1): rechazar, vencer o cancelar el pedido anula su venta, y sus canjes vuelven al cliente como al
  // quitar el descuento. Después de ganar el CAS de la fila y antes de escribir la Order: si la Order no se escribe,
  // `OrderNotWritten` revierte también esta devolución (Codex r2).
  if (cancela) await devolverCanjesDeVentaAnuladaEnTx(tx, { venueId: a.venueId, orderId: a.orderId, camino: `pedidoEnLinea:${a.kind}` })
  const orderData: Prisma.OrderUncheckedUpdateManyInput = { status: rule.order.to, ...(a.orderExtra?.(now) ?? {}) }
  // R44: vencer sin cancelar no escribe la cuenta (queda como la dejó el reembolso).
  const written = venceSinCancelar
    ? { count: 0 }
    : await tx.order.updateMany({
        where: { id: a.orderId, venueId: a.venueId, status: { in: rule.order.when } },
        data: orderData,
      })
  // M-1: rechazar, vencer o cancelar sin cancelar la cuenta le diría al comensal «rechazado» o «vencido» con la venta viva
  // (p. ej. una cortesía ya cerrada sin dinero). Se revierte todo y se responde el estado vigente.
  if (cancela && written.count !== 1) throw new OrderNotWritten(now)
  const orderWritten = written.count === 1

  // Fase 2: cancelar suelta la tarjeta apartada. Se marca aquí, en la MISMA transacción; la liberación con el banco la hace el
  // llamador después del commit, y sólo si esta transición fue la que movió el cargo.
  let releaseChargeId: string | undefined
  if (cancela && charge?.status === OnlineOrderChargeStatus.AUTHORIZED) {
    const released = await tx.onlineOrderCharge.updateMany({
      where: { id: charge.id, status: OnlineOrderChargeStatus.AUTHORIZED },
      data: { status: OnlineOrderChargeStatus.RELEASING },
    })
    if (released.count === 1) releaseChargeId = charge.id
  }
  return {
    r: 'OK',
    now,
    onlineOrderId: row.id,
    orderNumber: row.order.orderNumber,
    orderWritten,
    orderStatus: orderWritten ? rule.order.to : null,
    ...(releaseChargeId ? { releaseChargeId } : {}),
  }
}

/**
 * R44: dinero NETO de cada cuenta = Σ (amount + tipAmount) de sus `Payment` COMPLETED. Los reembolsos son filas NEGATIVAS (importe y
 * propina), así que restan solos: es lo cobrado menos lo devuelto de `summarizeRefunds`. Una consulta por lote (sin N+1); una
 * cuenta sin cobros no sale en el mapa (neto 0).
 */
export async function netoCobradoPorCuenta(
  db: Pick<Prisma.TransactionClient, 'payment'>,
  orderIds: string[],
): Promise<Map<string, Prisma.Decimal>> {
  if (orderIds.length === 0) return new Map()
  const filas = await db.payment.groupBy({
    by: ['orderId'],
    where: { orderId: { in: orderIds }, status: TransactionStatus.COMPLETED },
    _sum: { amount: true, tipAmount: true },
  })
  return new Map(filas.map(f => [f.orderId, new Prisma.Decimal(f._sum.amount ?? 0).plus(f._sum.tipAmount ?? 0)]))
}

/**
 * Escritura extra en la MISMA transacción, después del CAS (fase 2: el estado del cargo de tarjeta). Lanzar revierte todo. Lo que
 * devuelve sale (por `alConfirmar`) SÓLO del intento que hizo commit: nada se asigna afuera desde el cuerpo reintentable (R65 b).
 */
export type AfterCasInTx = (tx: TxConReintento, r: CasResult) => Promise<unknown>

/** `casTransitionInTx` en su propia transacción, con el presupuesto del candado de la orden. */
async function casTransition(a: CasArgs, afterCas?: AfterCasInTx, alConfirmar?: (valor: unknown) => void): Promise<CasResult> {
  let result: CasResult
  try {
    const hecho = await withDeadlockRetry(
      async tx => {
        const r = await casTransitionInTx(tx, a)
        const valor = afterCas ? await afterCas(tx, r) : undefined
        return { r, valor }
      },
      { etiqueta: 'casTransition', ...ORDER_LOCK_WAIT_BUDGET },
    )
    result = hecho.r
    // Ya con la transacción confirmada: el valor es el del intento ganador (un intento abortado por 40P01 no deja nada).
    alConfirmar?.(hecho.valor)
  } catch (error) {
    if (!(error instanceof OrderNotWritten)) throw error
    const current = await prisma.onlineOrder.findFirst({ where: { orderId: a.orderId, venueId: a.venueId }, select: { status: true } })
    return { r: 'STALE', now: error.now, status: current?.status ?? null, deadlinePassed: false }
  }

  // I-1: lo que cerró la sincronización de R2 se anuncia aquí, ya con la transacción confirmada y sólo si ganó el CAS de la fila.
  if (result.r === 'STALE' && result.cancelledElsewhere) announceCancelledElsewhere(result.cancelledElsewhere, result.now)
  return result
}

export function settled(r: Exclude<CasResult, { r: 'OK' }>): TransitionResult {
  switch (r.r) {
    case 'STALE':
      return r.confirmingPayment ? { outcome: 'CONFIRMING_PAYMENT' } : { outcome: 'STALE', status: r.status }
    case 'NOT_FOUND':
      return { outcome: 'NOT_FOUND' }
    case 'HAS_PAYMENTS':
      return { outcome: 'HAS_PAYMENTS' }
    default:
      return { outcome: 'PAYMENT_REQUIRED' }
  }
}

export interface AcceptInput {
  venueId: string
  orderId: string
  staffId: string | null
  estimatedMinutes?: number
  now?: Date
}

export async function prepMinutes(venueId: string, estimatedMinutes?: number): Promise<number> {
  const { defaultPrepMinutes } = await getSettings(venueId)
  return Math.min(240, Math.max(1, Math.round(estimatedMinutes ?? defaultPrepMinutes)))
}

/** Fase 2: un pedido pagado con tarjeta en línea se acepta cobrando la tarjeta (`acceptCardOnlineOrder`); pagar al recoger, igual que hoy. */
export async function acceptOnlineOrder(i: AcceptInput): Promise<TransitionResult> {
  const card = await prisma.onlineOrder.count({
    where: { orderId: i.orderId, venueId: i.venueId, paymentMode: OnlineOrderPaymentMode.CARD_ONLINE },
  })
  if (card > 0) {
    // Dinámico: el módulo de la captura importa esta máquina de estados.
    const { acceptCardOnlineOrder } = await import('./card/capture.service')
    return acceptCardOnlineOrder(i)
  }
  // Tienda híbrida (decisión 18): aceptar un folio es pasarlo a «Por entregar» por el único camino (`prepararFolioPagado`).
  const folio = await prisma.onlineOrder.count({ where: { orderId: i.orderId, venueId: i.venueId, requiresAcceptance: false } })
  if (folio > 0) {
    // Dinámico: `folios.service` importa esta máquina de estados.
    const { prepararFolioPagado } = await import('./folios.service')
    return prepararFolioPagado(i)
  }
  return acceptWithoutCapture(i)
}

/** La aceptación de siempre, sin tocar ninguna tarjeta (pagar al recoger, o una cuenta que ya trae dinero de otro camino). */
export async function acceptWithoutCapture(i: AcceptInput): Promise<TransitionResult> {
  const minutes = await prepMinutes(i.venueId, i.estimatedMinutes)
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
  return announceAccepted({ venueId: i.venueId, orderId: i.orderId, staffId: i.staffId, minutes, marcarCocina }, r)
}

/** Lo de después del commit de una aceptación (comandas, bandeja, aviso al comensal, bitácora); la comparte la captura. */
export function announceAccepted(
  i: { venueId: string; orderId: string; staffId: string | null; minutes: number; marcarCocina: boolean },
  r: Extract<CasResult, { r: 'OK' }>,
): TransitionResult {
  if (i.marcarCocina && r.orderWritten) void armarComandasTrasCommit(i.venueId, i.orderId, 'ROUND')
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
    data: { orderNumber: r.orderNumber, estimatedMinutes: i.minutes },
  })
  return {
    outcome: 'OK',
    status: OnlineOrderStatus.ACCEPTED,
    estimatedReadyAt: new Date(r.now.getTime() + i.minutes * 60_000).toISOString(),
  }
}

export async function rejectOnlineOrder(i: {
  venueId: string
  orderId: string
  staffId: string | null
  reason: OnlineOrderRejectReason
  note?: string | null
  now?: Date
  /** Fase 2, sólo la captura fallida: rechaza con el cargo en `CAPTURING`. */
  allowCapturing?: true
  /** Fase 2: lo que el cargo escribe en la MISMA transacción (captura fallida, aviso de Stripe de «cancelado»). */
  afterCas?: AfterCasInTx
  /** Después del commit: recibe lo que devolvió `afterCas` en el intento que confirmó. */
  alConfirmar?: (valor: unknown) => void
}): Promise<TransitionResult> {
  const r = await casTransition(
    {
      kind: 'REJECT',
      venueId: i.venueId,
      orderId: i.orderId,
      now: i.now,
      allowCapturing: i.allowCapturing,
      onlineData: now => ({ rejectedAt: now, rejectReason: i.reason, rejectNote: i.note ?? null }),
    },
    i.afterCas,
    i.alConfirmar,
  )
  if (r.r !== 'OK') return settled(r)
  if (r.releaseChargeId) await releaseCharge(r.releaseChargeId)

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

export async function expireOnlineOrder(i: { venueId: string; orderId: string; now?: Date; reloj?: Reloj }): Promise<TransitionResult> {
  const r = await casTransition({
    kind: 'EXPIRE',
    venueId: i.venueId,
    orderId: i.orderId,
    now: i.now,
    reloj: i.reloj,
    extraWhere: now => ({ acceptDeadlineAt: { lte: now } }),
    onlineData: now => ({ expiredAt: now }),
  })
  if (r.r !== 'OK') return settled(r)
  if (r.releaseChargeId) await releaseCharge(r.releaseChargeId)

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
  // A12: «entregado» sobre lo que ya se entregó (la bandeja o el job lo cerraron al quedar pagado, o fue un doble toque) es
  // éxito: la caja pidió justo ese estado. Nada se escribe ni se audita otra vez.
  if (r.r === 'STALE' && r.status === OnlineOrderStatus.COMPLETED) {
    return { outcome: 'OK', status: OnlineOrderStatus.COMPLETED, unchanged: true }
  }
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
  if (r.releaseChargeId) await releaseCharge(r.releaseChargeId)

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
 * T13: además, un FOLIO por pagar (`PENDING_ACCEPTANCE` con `requiresAcceptance === false`, la clienta pidió y paga en caja) se
 * puede cancelar por personal. Un pedido de «Mi equipo» por aceptar no: ése se acepta o se rechaza. Una sola condición, la
 * misma en la lectura y en el CAS de dentro de la transacción.
 */
const STAFF_CANCELLABLE_WHERE = {
  OR: [{ status: { in: STAFF_CANCELLABLE } }, { status: OnlineOrderStatus.PENDING_ACCEPTANCE, requiresAcceptance: false }],
}

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
    select: { id: true, status: true, requiresAcceptance: true, order: { select: { orderNumber: true } } },
  })
  if (!row) return { outcome: 'NOT_FOUND' }
  const cancellable =
    STAFF_CANCELLABLE.includes(row.status) || (row.status === OnlineOrderStatus.PENDING_ACCEPTANCE && row.requiresAcceptance === false)
  if (!cancellable) return { outcome: 'STALE', status: row.status }

  const { cancelOrder } = await import('@/services/mobile/order.mobile.service')
  let cancelledAt = i.now ?? new Date()
  try {
    await cancelOrder(i.venueId, i.orderId, undefined, i.staffId ?? undefined, async tx => {
      cancelledAt = i.now ?? new Date() // ya con el candado de la orden
      const cas = await tx.onlineOrder.updateMany({
        where: { id: row.id, ...STAFF_CANCELLABLE_WHERE },
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
