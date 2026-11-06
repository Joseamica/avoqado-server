import { OnlineOrderStatus, OrderStatus, Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { debeMarcarCocina } from '@/services/kds/kitchenDisplayStations'
import { armarComandasTrasCommit } from '@/services/kds/kitchenTicketAuthoring.service'
import { FOLIO_PAID_STATUSES } from '@/services/shared/orderBalance'
import { instanteUtcSql, seAcaboElDiaDelNegocioDeSql } from '@/services/shared/pagadaPeroAbierta'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { BadRequestError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'
import { announceCancelledElsewhere, cerrarCanceladasReleyendo } from './cancelledOrderSync'
import { EXPIRY_BATCH_SIZE, INBOX_PAGE_SIZE, OPEN_ORDER_STATUSES, SYNC_BATCH_SIZE, foliosPorPagarWhere } from './constants'
// Ciclo a propósito: `inbox.service` usa las sincronizaciones de aquí y esta lista usa su forma; todo se usa al llamar, nunca al cargar.
import { INBOX_SELECT, fromActiveCursor, toActiveCursor, toInboxOrder } from './inbox.service'
import { getSettings } from './settings.service'
import { notifyOrderEvent } from './notifications.service'
import { announceAccepted, casTransitionInTx, prepMinutes, settled, type CasResult, type TransitionResult } from './transitions.service'
import { emitOnlineOrderUpdated } from './traySocket'
import type { ReadCandidates } from './types'

/**
 * R18: la cuenta de un folio está SALDADA (`FOLIO_PAID_STATUSES`, el espejo de `esVentaCerrada`) y viva. R5: NO excluye las cuentas
 * con un `Payment` `REFUND` (el `PAID_ORDER` de `paidPickupSync` sí): un reembolso real deja la cuenta PAID, y un folio pagado y
 * reembolsado tiene que salir de «Por pagar» igual (decisión 18: lo saca una persona). Un abono parcial no entra: espera el resto.
 */
const CUENTA_VIVA: Prisma.OrderWhereInput = { status: { notIn: [OrderStatus.CANCELLED, OrderStatus.DELETED] } }
const CUENTA_SALDADA: Prisma.OrderWhereInput = { paymentStatus: { in: FOLIO_PAID_STATUSES }, ...CUENTA_VIVA }

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

/**
 * Decisión 18, T9b: «Por entregar» sale de la lista sólo con «Entregado» de una persona o, aquí, al terminar el día del negocio
 * (corte de las 04:00 en la zona del negocio, la regla de `seAcaboElDiaDelNegocioDeSql`). El día se cuenta desde `acceptedAt`: el
 * folio que el dinero tardío pasó a la lista hoy (aunque se creó ayer) sale hasta el cierre de hoy. Sólo escribe `OnlineOrder`
 * (estado y `completedAt`): ni la cuenta, ni el dinero, ni la cocina; por eso no necesita el candado de la orden y basta el CAS por
 * fila sobre el estado, el `acceptedAt` (un folio revivido hoy no sale por un día viejo) y la cuenta viva (una cancelación no termina «Entregado»), con `requiresAcceptance:false` (si una persona lo entregó antes, el CAS pierde y no cuenta).
 * Lectura con tope (lo que sobre lo toma la siguiente pasada) y una escritura por fila; anuncia después, con actor de sistema.
 */
export async function cerrarFoliosDelDiaTerminado(
  scope: { venueId?: string },
  now: Date,
  readCandidates: ReadCandidates = read => read(),
): Promise<number> {
  const rows = await readCandidates(
    () => prisma.$queryRaw<
      Array<{ id: string; orderId: string; venueId: string; status: OnlineOrderStatus; acceptedAt: Date; orderNumber: string }>
    >`
      SELECT oo.id, oo."orderId", oo."venueId", oo.status::text AS status, oo."acceptedAt", o."orderNumber"
      FROM "OnlineOrder" oo
      JOIN "Order" o ON o.id = oo."orderId"
      WHERE oo."requiresAcceptance" = false
        AND oo.status IN ('ACCEPTED', 'READY')
        AND o.status NOT IN ('CANCELLED', 'DELETED')
        ${scope.venueId !== undefined ? Prisma.sql`AND oo."venueId" = ${scope.venueId}` : Prisma.empty}
        AND ${Prisma.raw(seAcaboElDiaDelNegocioDeSql('oo."acceptedAt"', 'oo."venueId"', instanteUtcSql(now)))}
      ORDER BY oo.id ASC
      LIMIT ${SYNC_BATCH_SIZE}`,
  )
  let won = 0
  for (const row of rows) {
    try {
      const cas = await prisma.onlineOrder.updateMany({
        where: { id: row.id, status: row.status, requiresAcceptance: false, acceptedAt: row.acceptedAt, order: CUENTA_VIVA },
        data: { status: OnlineOrderStatus.COMPLETED, completedAt: now },
      })
      if (cas.count !== 1) continue
      won += 1
      emitOnlineOrderUpdated({
        venueId: row.venueId,
        orderId: row.orderId,
        orderNumber: row.orderNumber,
        onlineStatus: OnlineOrderStatus.COMPLETED,
        now,
      })
      void logAction({
        staffId: null,
        venueId: row.venueId,
        action: 'ONLINE_ORDER_COLLECTED',
        entity: 'OnlineOrder',
        entityId: row.id,
        data: { orderNumber: row.orderNumber, automatic: 'END_OF_DAY' },
      })
    } catch (error) {
      logger.error('[OnlineOrdering] no se pudo entregar al terminar el día un folio (la pasada sigue)', {
        onlineOrderId: row.id,
        venueId: row.venueId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (won > 0) logger.info('[OnlineOrdering] folios entregados al terminar el día del negocio', { ...scope, count: won })
  return won
}

/** Un pedido a vencer, con su llave estable (`acceptDeadlineAt`, `id`): el trabajo sigue DESPUÉS de ella dentro de la pasada. */
export interface CandidatoAVencer {
  id: string
  orderId: string
  venueId: string
  acceptDeadlineAt: Date
}
export type CursorDeVencer = { at: Date; id: string }

/**
 * R50: lo vencido por pagar con la cuenta abierta, una página por llave estable. El SQL excluye TODO lo que el vencimiento bajo el
 * candado (`casTransitionInTx`, `EXPIRE`) rechazaría de forma durable —cada lectura su dinero (`cuenta`), y las dos la cuenta con un
 * cobro de terminal sin desenlace acreditado, con el MISMO predicado y la misma llave (negocio y orden) que la guarda
 * (`findLiveTerminalCharge`)—, así que lo que se lea y no venza sólo puede ser una carrera pasajera, y no gasta páginas.
 */
async function leerVencidos(now: Date, despues: CursorDeVencer | null, cuenta: Prisma.Sql): Promise<CandidatoAVencer[]> {
  // Dinámico, como la guarda (`orderCancelGuard`): el servicio de terminal arrastra sockets y alertas.
  const { unresolvedFinancialOutcomeSql } = await import('@/services/terminal-payment.service')
  return prisma.$queryRaw<CandidatoAVencer[]>`
    SELECT oo.id, oo."orderId", oo."venueId", oo."acceptDeadlineAt"
    FROM "OnlineOrder" oo
    JOIN "Order" o ON o.id = oo."orderId"
    WHERE oo.status = 'PENDING_ACCEPTANCE'
      AND oo."acceptDeadlineAt" <= ${utcTs(now)}
      AND o.status::text IN (${Prisma.join([...OPEN_ORDER_STATUSES])})
      AND ${cuenta}
      AND NOT EXISTS (
        SELECT 1 FROM "TerminalPaymentRequest" r
        WHERE r."venueId" = oo."venueId" AND r."orderId" = oo."orderId" AND ${unresolvedFinancialOutcomeSql('r')}
      )
      ${despues ? Prisma.sql`AND (oo."acceptDeadlineAt", oo.id) > (${utcTs(despues.at)}, ${despues.id})` : Prisma.empty}
    ORDER BY oo."acceptDeadlineAt" ASC, oo.id ASC
    LIMIT ${EXPIRY_BATCH_SIZE}`
}

/**
 * R1/R49: el barrido principal. Sólo cuentas sin un peso (`PENDING`), de folios y de «Mi equipo»: uno ya cobrado no vence, y un abono
 * (PARTIAL) nunca entra aquí: el devuelto va en `leerFoliosConAbonoDevuelto` y el vivo no vence (R18).
 */
export const leerPedidosVencidos = (now: Date, despues: CursorDeVencer | null) =>
  leerVencidos(now, despues, Prisma.sql`o."paymentStatus" = 'PENDING'`)

/**
 * R44/R49: folios por pagar cuyo abono se devolvió completo (cuenta PARTIAL). El dinero neto (Σ amount + tipAmount de los `Payment`
 * COMPLETED; los reembolsos son filas negativas) se filtra EN esta consulta: un abono vivo nunca sale de aquí (Codex r2). El trabajo
 * vence cada uno bajo el candado de la orden, releyendo el neto (`casTransitionInTx`, R44).
 */
export const leerFoliosConAbonoDevuelto = (now: Date, despues: CursorDeVencer | null) =>
  leerVencidos(
    now,
    despues,
    Prisma.sql`oo."requiresAcceptance" = false
      AND o."paymentStatus" = 'PARTIAL'
      AND COALESCE((SELECT SUM(p.amount + p."tipAmount") FROM "Payment" p WHERE p."orderId" = o.id AND p.status = 'COMPLETED'), 0) <= 0`,
  )

export type FolioSection = 'toPay' | 'toDeliver'

/**
 * Tienda híbrida (T12): la lista de la caja (TPV, POS y panel). «Por pagar» = folios sin saldar (`foliosPorPagarWhere`, R42) y «Por
 * entregar» = folios pagados que nadie ha entregado (`ACCEPTED`), del más viejo al más nuevo. Cada sección es una página de
 * `INBOX_PAGE_SIZE` leída con `tope + 1` y sigue por `(createdAt, id)` con el cursor de la Bandeja; `counts` son exactos.
 * Sin `section`: la primera página de las dos. Con `section` y `cursor`: la siguiente de ésa y la otra vacía.
 * R43: antes de leer corre lo mismo que la Bandeja, así lo que la caja acaba de cobrar ya está en «Por entregar».
 */
export async function listFolios(p: { venueId: string; section?: FolioSection; cursor?: string; now?: Date }) {
  const now = p.now ?? new Date()
  // El cursor es de UNA sección: sin ella no hay forma no ambigua de aplicarlo (la ruta ya lo frena; esto cubre a quien llame directo).
  if (p.cursor && !p.section) throw new BadRequestError('El cursor necesita la sección a la que sigue', 'INVALID_CURSOR')
  const after = p.cursor ? fromActiveCursor(p.cursor) : null
  const warnSync = (que: string) => (error: unknown) => {
    logger.warn(`[OnlineOrdering] no se pudieron ${que} antes de la lista de folios`, {
      venueId: p.venueId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  await cerrarCanceladasReleyendo({ venueId: p.venueId }, now)
    .then(won => announceCancelledElsewhere(won, now))
    .catch(warnSync('cerrar los pedidos de cuentas canceladas'))
  await syncPaidFolios({ venueId: p.venueId }, now).catch(warnSync('pasar a «Por entregar» los folios pagados'))
  await syncPaidClosedFolios({ venueId: p.venueId }, now).catch(warnSync('revivir los folios cerrados ya saldados'))

  const porPagar = foliosPorPagarWhere(p.venueId)
  const porEntregar = { venueId: p.venueId, requiresAcceptance: false, status: OnlineOrderStatus.ACCEPTED }
  const page = (where: Prisma.OnlineOrderWhereInput, mine: FolioSection) =>
    p.section && p.section !== mine
      ? Promise.resolve([] as Awaited<ReturnType<typeof prisma.onlineOrder.findMany<{ select: typeof INBOX_SELECT }>>>)
      : prisma.onlineOrder.findMany({
          where: {
            ...where,
            ...(after && p.section === mine
              ? { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] }
              : {}),
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: INBOX_PAGE_SIZE + 1,
          select: INBOX_SELECT,
        })
  const [payRows, deliverRows, toPayCount, toDeliverCount, settings] = await Promise.all([
    page(porPagar, 'toPay'),
    page(porEntregar, 'toDeliver'),
    prisma.onlineOrder.count({ where: porPagar }),
    prisma.onlineOrder.count({ where: porEntregar }),
    getSettings(p.venueId),
  ])

  const toPay = payRows.slice(0, INBOX_PAGE_SIZE)
  const toDeliver = deliverRows.slice(0, INBOX_PAGE_SIZE)
  const enabled = settings.enabled
  const requiresAcceptance = settings.requiresAcceptance
  // El mosaico sigue mientras haya folios vivos aunque se cambie a «Mi equipo» o se apague la tienda: se cobran o vencen.
  const showTile = (enabled && !requiresAcceptance) || toPayCount + toDeliverCount > 0
  return {
    serverTime: now.toISOString(),
    enabled,
    requiresAcceptance,
    showTile,
    pollSeconds: showTile ? 30 : 600,
    counts: { toPay: toPayCount, toDeliver: toDeliverCount },
    toPay: toPay.map(r => toInboxOrder(r, now)),
    toDeliver: toDeliver.map(r => toInboxOrder(r, now)),
    nextCursors: {
      toPay: payRows.length > INBOX_PAGE_SIZE ? toActiveCursor(toPay[toPay.length - 1]) : null,
      toDeliver: deliverRows.length > INBOX_PAGE_SIZE ? toActiveCursor(toDeliver[toDeliver.length - 1]) : null,
    },
  }
}
