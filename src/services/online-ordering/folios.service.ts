import { OnlineOrderStatus, OrderStatus, Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { debeMarcarCocina } from '@/services/kds/kitchenDisplayStations'
import { armarComandasTrasCommit } from '@/services/kds/kitchenTicketAuthoring.service'
import { FOLIO_PAID_STATUSES } from '@/services/shared/orderBalance'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import prisma from '@/utils/prismaClient'
import { announceCancelledElsewhere } from './cancelledOrderSync'
import { SYNC_BATCH_SIZE } from './constants'
import { notifyOrderEvent } from './notifications.service'
import { announceAccepted, casTransitionInTx, prepMinutes, settled, type CasResult, type TransitionResult } from './transitions.service'
import { emitOnlineOrderUpdated } from './traySocket'
import type { ReadCandidates } from './types'

/**
 * R18: la cuenta de un folio está SALDADA (`FOLIO_PAID_STATUSES`, el espejo de `esVentaCerrada`) y viva. R5: NO excluye las cuentas
 * con un `Payment` `REFUND` (el `PAID_ORDER` de `paidPickupSync` sí): un reembolso real deja la cuenta PAID, y un folio pagado y
 * reembolsado tiene que salir de «Por pagar» igual (decisión 18: lo saca una persona). Un abono parcial no entra: espera el resto.
 */
const CUENTA_SALDADA: Prisma.OrderWhereInput = {
  paymentStatus: { in: FOLIO_PAID_STATUSES },
  status: { notIn: [OrderStatus.CANCELLED, OrderStatus.DELETED] },
}

/** Dónde puede estar un folio que el dinero tardío revive: vencido, cancelado o rechazado (tabla 7b del diseño). */
const FOLIO_CERRADO: OnlineOrderStatus[] = [
  OnlineOrderStatus.EXPIRED,
  OnlineOrderStatus.CANCELLED_BY_CUSTOMER,
  OnlineOrderStatus.CANCELLED_BY_STAFF,
  OnlineOrderStatus.REJECTED,
]

/**
 * R4 (regla de capacidad): `syncPaidClosedFolios` sólo mira lo cerrado en esta ventana. La fecha es `updatedAt` (índice
 * `[requiresAcceptance, status, updatedAt]`): el cierre la escribe y nada más toca un folio cerrado; el cierre vive en tres
 * columnas (`expiredAt`, `cancelledAt`, `rejectedAt`) y un solo índice no las cubre.
 * ponytail: dinero que salde un folio cerrado hace más de 7 días no lo revive solo (queda su cuenta abierta y el aviso al gerente).
 */
const VENTANA_DE_CERRADOS_MS = 7 * 24 * 3_600_000

/**
 * Decisión 18: el ÚNICO paso de pagado a «Por entregar». Bajo el candado de la orden (`casTransitionInTx`, `kind: 'ACCEPT'`): CAS
 * `PENDING_ACCEPTANCE → ACCEPTED` con su hora estimada y la cuenta `PENDING → CONFIRMED` (nunca reabre una cerrada; así una cuenta
 * pagada por «Liquidar saldo» no queda escondida). Un folio sin pagar da `PAYMENT_REQUIRED` (la puerta de T2).
 * La marca de cocina va en la escritura de la cuenta; si la cuenta ya estaba cerrada por el cobro (la TPV la deja COMPLETED), va
 * aparte, mientras no esté cancelada. Nunca duplica: el armado sólo toma renglones sin comanda (`kitchenTicketAuthoring`).
 * `requiresAcceptance` se lee antes del candado a propósito: nunca cambia (P1).
 */
export async function prepararFolioPagadoEnTx(
  tx: Prisma.TransactionClient,
  a: { venueId: string; orderId: string; marcarCocina: boolean; minutes: number; now?: Date },
): Promise<CasResult | { r: 'NOT_FOLIO' }> {
  const pedido = await tx.onlineOrder.findFirst({
    where: { orderId: a.orderId, venueId: a.venueId },
    select: { requiresAcceptance: true },
  })
  if (!pedido) return { r: 'NOT_FOUND' }
  if (pedido.requiresAcceptance !== false) return { r: 'NOT_FOLIO' }

  const r = await casTransitionInTx(tx, {
    kind: 'ACCEPT',
    venueId: a.venueId,
    orderId: a.orderId,
    now: a.now,
    onlineData: now => ({ acceptedAt: now, estimatedReadyAt: new Date(now.getTime() + a.minutes * 60_000) }),
    orderExtra: now => (a.marcarCocina ? { kitchenPendingAt: now } : {}),
  })
  if (r.r === 'OK' && a.marcarCocina && !r.orderWritten) {
    await tx.order.updateMany({
      where: { id: a.orderId, venueId: a.venueId, status: { notIn: [OrderStatus.CANCELLED, OrderStatus.DELETED] } },
      data: { kitchenPendingAt: r.now },
    })
  }
  return r
}

/** `prepararFolioPagadoEnTx` en su transacción y, tras el commit, los avisos de una aceptación y el armado de la comanda. */
export async function prepararFolioPagado(i: {
  venueId: string
  orderId: string
  staffId: string | null
  estimatedMinutes?: number
  now?: Date
}): Promise<TransitionResult> {
  const minutes = await prepMinutes(i.venueId, i.estimatedMinutes)
  const marcarCocina = await debeMarcarCocina(i.venueId, { orderId: i.orderId }) // nunca lanza
  const r = await prisma.$transaction(
    tx => prepararFolioPagadoEnTx(tx, { venueId: i.venueId, orderId: i.orderId, marcarCocina, minutes, now: i.now }),
    ORDER_LOCK_WAIT_BUDGET,
  )
  if (r.r === 'NOT_FOLIO') return { outcome: 'NOT_FOUND' }
  if (r.r !== 'OK') {
    if (r.r === 'STALE' && r.cancelledElsewhere) announceCancelledElsewhere(r.cancelledElsewhere, r.now)
    return settled(r)
  }
  // Con OK la cuenta quedó marcada (en su escritura o aparte): se arma aquí, también cuando la cuenta no se escribió.
  const result = announceAccepted({ venueId: i.venueId, orderId: i.orderId, staffId: i.staffId, minutes, marcarCocina: false }, r)
  if (marcarCocina) void armarComandasTrasCommit(i.venueId, i.orderId, 'ROUND')
  return result
}

/**
 * Decisión 18: todo folio por pagar cuya cuenta ya quedó saldada —por cualquier camino: la TPV, el POS, el panel, «Liquidar saldo»,
 * o pagado y reembolsado— pasa a «Por entregar». Lectura con tope (lo que sobre lo toma la siguiente pasada) y una transacción por
 * fila (`prepararFolioPagado`), que relee bajo el candado. Compite con el «aceptar» del aparato por el mismo CAS: gana uno.
 */
export async function syncPaidFolios(
  scope: { venueId?: string },
  now: Date,
  readCandidates: ReadCandidates = read => read(),
): Promise<number> {
  const rows = await readCandidates(() =>
    prisma.onlineOrder.findMany({
      where: {
        ...(scope.venueId !== undefined ? { venueId: scope.venueId } : {}),
        requiresAcceptance: false,
        status: OnlineOrderStatus.PENDING_ACCEPTANCE,
        order: CUENTA_SALDADA,
      },
      select: { orderId: true, venueId: true },
      orderBy: { id: 'asc' },
      take: SYNC_BATCH_SIZE,
    }),
  )
  let won = 0
  for (const row of rows) {
    try {
      const r = await prepararFolioPagado({ venueId: row.venueId, orderId: row.orderId, staffId: null, now })
      if (r.outcome === 'OK') won += 1
    } catch (error) {
      logger.error('[OnlineOrdering] no se pudo pasar a «Por entregar» un folio ya pagado (la pasada sigue)', {
        orderId: row.orderId,
        venueId: row.venueId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (won > 0) logger.info('[OnlineOrdering] folios pagados pasados a «Por entregar»', { ...scope, count: won })
  return won
}

/**
 * Tabla 7b, regla 2: un abono tardío reabre la cuenta de un folio cerrado y el folio sigue cerrado; cuando OTRO cobro la salda (desde
 * las cuentas abiertas, que no pasa por `conciliarPedidoEnLinea`), esta pasada lo revive a «Por entregar» (`ACCEPTED`), nunca a
 * «Entregado». Una transacción por fila, bajo el candado de la orden, y un CAS que repite el estado leído y la cuenta saldada. No
 * marca la cocina (decisión 19: la comanda, si sale, es del cobro que saldó) ni toca la cuenta.
 */
export async function syncPaidClosedFolios(
  scope: { venueId?: string },
  now: Date,
  readCandidates: ReadCandidates = read => read(),
): Promise<number> {
  const rows = await readCandidates(() =>
    prisma.onlineOrder.findMany({
      where: {
        ...(scope.venueId !== undefined ? { venueId: scope.venueId } : {}),
        requiresAcceptance: false,
        status: { in: FOLIO_CERRADO },
        updatedAt: { gte: new Date(now.getTime() - VENTANA_DE_CERRADOS_MS) },
        order: CUENTA_SALDADA,
      },
      select: { id: true, orderId: true, venueId: true, status: true, order: { select: { orderNumber: true } } },
      orderBy: { id: 'asc' },
      take: SYNC_BATCH_SIZE,
    }),
  )
  let won = 0
  for (const row of rows) {
    try {
      const movido = await prisma.$transaction(async tx => {
        if (!(await lockExistingOrderForPayment(tx, { venueId: row.venueId, orderId: row.orderId }))) return false
        const cas = await tx.onlineOrder.updateMany({
          where: { id: row.id, status: row.status, requiresAcceptance: false, order: CUENTA_SALDADA },
          data: { status: OnlineOrderStatus.ACCEPTED, acceptedAt: now },
        })
        return cas.count === 1
      }, ORDER_LOCK_WAIT_BUDGET)
      if (!movido) continue
      won += 1
      emitOnlineOrderUpdated({
        venueId: row.venueId,
        orderId: row.orderId,
        orderNumber: row.order.orderNumber,
        onlineStatus: OnlineOrderStatus.ACCEPTED,
        now,
      })
      void notifyOrderEvent(row.orderId, 'ACCEPTED')
      void logAction({
        staffId: null,
        venueId: row.venueId,
        action: 'ONLINE_ORDER_ACCEPTED',
        entity: 'OnlineOrder',
        entityId: row.id,
        data: { orderNumber: row.order.orderNumber, automatic: true, from: row.status },
      })
    } catch (error) {
      logger.error('[OnlineOrdering] no se pudo pasar a «Por entregar» un folio cerrado ya saldado (la pasada sigue)', {
        onlineOrderId: row.id,
        venueId: row.venueId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (won > 0) logger.info('[OnlineOrdering] folios cerrados que otro cobro saldó, de vuelta en «Por entregar»', { ...scope, count: won })
  return won
}
