import { OnlineOrderStatus, Prisma, type OnlineOrderPaymentMode } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { announceCancelledElsewhere, syncOnlineOrdersOfCancelledOrders } from './cancelledOrderSync'
import { BadRequestError } from '@/errors/AppError'
import { ACTIVE_CURSOR_PATTERN, INBOX_PAGE_SIZE, MAX_CART_LINES } from './constants'
import { announceCollectedAutomatically, syncOnlineOrdersOfPaidPickups } from './paidPickupSync'
import { onlineOrderNeedsPrint } from './printClaim.service'

export type InboxFilter = 'pending' | 'active' | 'done' | 'all'

export interface InboxOrder {
  /** Id de la CUENTA (`Order.id`): la llave de las acciones y del reclamo de impresión. */
  orderId: string
  onlineOrderId: string
  orderNumber: string
  status: OnlineOrderStatus
  paymentMode: OnlineOrderPaymentMode
  customerName: string | null
  customerPhone: string | null
  note: string | null
  createdAt: string
  acceptDeadlineAt: string
  estimatedReadyAt: string | null
  total: number
  remaining: number
  paymentStatus: string
  needsPrint: boolean
  items: Array<{ name: string; quantity: number; note: string | null; modifiers: Array<{ name: string; quantity: number }> }>
}

const PENDING = [OnlineOrderStatus.PENDING_ACCEPTANCE]
const ACTIVE = [OnlineOrderStatus.ACCEPTED, OnlineOrderStatus.READY]
const DONE = [
  OnlineOrderStatus.COMPLETED,
  OnlineOrderStatus.REJECTED,
  OnlineOrderStatus.EXPIRED,
  OnlineOrderStatus.CANCELLED_BY_CUSTOMER,
  OnlineOrderStatus.CANCELLED_BY_STAFF,
]
const DONE_PAGE_SIZE = 50

const SELECT = {
  id: true,
  status: true,
  paymentMode: true,
  acceptDeadlineAt: true,
  estimatedReadyAt: true,
  printClaimedAt: true,
  printedAt: true,
  createdAt: true,
  order: {
    select: {
      id: true,
      orderNumber: true,
      total: true,
      remainingBalance: true,
      paymentStatus: true,
      customerName: true,
      customerPhone: true,
      specialRequests: true,
      // Topes que nunca recortan lo que pidió el comensal: la tienda crea la cuenta con ≤ MAX_CART_LINES renglones y ≤ 30
      // opciones por renglón (esquema público `onlineOrdering.schema.ts`). El doble de renglones deja lugar a lo que la caja
      // agregue después a la cuenta; 50 opciones cubren las 30 del pedido.
      items: {
        take: 2 * MAX_CART_LINES,
        orderBy: [{ sequence: 'asc' as const }, { id: 'asc' as const }],
        select: { productName: true, quantity: true, notes: true, modifiers: { take: 50, select: { name: true, quantity: true } } },
      },
    },
  },
} satisfies Prisma.OnlineOrderSelect

type Row = Prisma.OnlineOrderGetPayload<{ select: typeof SELECT }>

const money = (d: Prisma.Decimal): number => Number(new Prisma.Decimal(d).toFixed(2))

function toInboxOrder(r: Row, now: Date): InboxOrder {
  return {
    orderId: r.order.id,
    onlineOrderId: r.id,
    orderNumber: r.order.orderNumber,
    status: r.status,
    paymentMode: r.paymentMode,
    customerName: r.order.customerName ?? null,
    customerPhone: r.order.customerPhone ?? null,
    note: r.order.specialRequests ?? null,
    createdAt: r.createdAt.toISOString(),
    acceptDeadlineAt: r.acceptDeadlineAt.toISOString(),
    estimatedReadyAt: r.estimatedReadyAt ? r.estimatedReadyAt.toISOString() : null,
    total: money(r.order.total),
    remaining: money(r.order.remainingBalance),
    paymentStatus: r.order.paymentStatus,
    needsPrint: onlineOrderNeedsPrint({ status: r.status, printedAt: r.printedAt, printClaimedAt: r.printClaimedAt }, now),
    items: r.order.items.map(i => ({
      name: i.productName ?? '',
      quantity: i.quantity,
      note: i.notes ?? null,
      modifiers: i.modifiers.map(m => ({ name: m.name ?? '', quantity: m.quantity })),
    })),
  }
}

/** A8: «<createdAt ISO>_<id>» del último activo de la página: la siguiente sigue DESPUÉS de él (createdAt desc, id desc). */
const toActiveCursor = (r: Row): string => `${r.createdAt.toISOString()}_${r.id}`
function fromActiveCursor(cursor: string): { createdAt: Date; id: string } {
  const m = ACTIVE_CURSOR_PATTERN.exec(cursor)
  const createdAt = m ? new Date(m[1]) : null
  if (!m || !createdAt || Number.isNaN(createdAt.getTime())) throw new BadRequestError('Cursor inválido', 'INVALID_CURSOR')
  return { createdAt, id: m[2] }
}

/**
 * A8 (P1-08): un pedido por su cuenta (`Order.id`) DENTRO del negocio, con la misma forma que la bandeja; `null` si no existe ahí.
 * Lo usa el MCP para atender un pedido conociendo su id, sin buscarlo dentro de una página de la bandeja.
 */
export async function getInboxOrder(p: { venueId: string; orderId: string; now?: Date }): Promise<InboxOrder | null> {
  const row = await prisma.onlineOrder.findFirst({ where: { venueId: p.venueId, orderId: p.orderId }, select: SELECT })
  return row ? toInboxOrder(row, p.now ?? new Date()) : null
}

/**
 * Bandeja del restaurante: lo pendiente primero (el que vence antes arriba), lo activo y el historial de las últimas 24 h.
 * Los conteos son exactos (`groupBy` y `count`, también los cerrados del periodo, H10); las listas llevan topes leídos con
 * `tope + 1`: si recortan, `truncated` lo dice y queda un `logger.warn`. A8: los ACTIVOS (aceptados y listos, que no vencen solos)
 * siguen por llave estable con `activeCursor` ← `nextCursor`; sin cursor la respuesta es la de siempre.
 */
export async function listInbox(p: { venueId: string; filter?: InboxFilter; activeCursor?: string; now?: Date }) {
  const now = p.now ?? new Date()
  const after = p.activeCursor ? fromActiveCursor(p.activeCursor) : null
  const filter = p.filter ?? 'all'
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000)

  // Antes de leer, y en este orden (ninguna le cuesta la lista; cada una anuncia a SUS ganadores, ya fuera de transacción):
  // R2 cierra los pedidos cuya cuenta se canceló por otra vía (POS, panel); luego, opción 1 del founder (17-oct), se entrega
  // solo lo de pagar al recoger que ya quedó pagado.
  const warnSync = (que: string) => (error: unknown) => {
    logger.warn(`[OnlineOrdering] no se pudieron ${que} antes de la bandeja`, {
      venueId: p.venueId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  await syncOnlineOrdersOfCancelledOrders(prisma, { venueId: p.venueId }, now)
    .then(won => announceCancelledElsewhere(won, now))
    .catch(warnSync('cerrar los pedidos de cuentas canceladas'))
  await syncOnlineOrdersOfPaidPickups(prisma, { venueId: p.venueId }, now)
    .then(won => announceCollectedAutomatically(won, now))
    .catch(warnSync('entregar los pedidos ya pagados'))

  const wantPending = filter === 'pending' || filter === 'all'
  const wantActive = filter === 'active' || filter === 'all'
  const wantDone = filter === 'done' || filter === 'all'

  // H10: `tope + 1` para saber si sobró uno (exactamente el tope no es recorte).
  const [pendingRows, activeRows, doneRows, grouped, doneCount] = await Promise.all([
    wantPending
      ? prisma.onlineOrder.findMany({
          where: { venueId: p.venueId, status: { in: PENDING } },
          orderBy: [{ acceptDeadlineAt: 'asc' }, { id: 'asc' }],
          take: INBOX_PAGE_SIZE + 1,
          select: SELECT,
        })
      : Promise.resolve([] as Row[]),
    wantActive
      ? prisma.onlineOrder.findMany({
          where: {
            venueId: p.venueId,
            status: { in: ACTIVE },
            ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
          },
          // I-2: lo más nuevo primero (las apps ordenan en pantalla): si el tope recorta, nunca esconde lo recién aceptado.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: INBOX_PAGE_SIZE + 1,
          select: SELECT,
        })
      : Promise.resolve([] as Row[]),
    wantDone
      ? prisma.onlineOrder.findMany({
          where: { venueId: p.venueId, status: { in: DONE }, createdAt: { gte: dayAgo } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: DONE_PAGE_SIZE + 1,
          select: SELECT,
        })
      : Promise.resolve([] as Row[]),
    prisma.onlineOrder.groupBy({
      by: ['status'],
      where: { venueId: p.venueId, status: { in: [...PENDING, ...ACTIVE] } },
      _count: { _all: true },
    }),
    // H10 (R17): los cerrados del periodo también se cuentan, aunque la lista sólo muestre los últimos 50.
    prisma.onlineOrder.count({ where: { venueId: p.venueId, status: { in: DONE }, createdAt: { gte: dayAgo } } }),
  ])

  const count = (statuses: OnlineOrderStatus[]) => grouped.filter(g => statuses.includes(g.status)).reduce((s, g) => s + g._count._all, 0)
  const counts = {
    pending: count(PENDING),
    active: count(ACTIVE),
    done: doneCount,
    // 1b: los activos por etapa, del mismo `groupBy` exacto (las pestañas del panel no cuentan sobre una lista con tope).
    accepted: count([OnlineOrderStatus.ACCEPTED]),
    ready: count([OnlineOrderStatus.READY]),
  }
  const truncated = pendingRows.length > INBOX_PAGE_SIZE || activeRows.length > INBOX_PAGE_SIZE || doneRows.length > DONE_PAGE_SIZE
  const pending = pendingRows.slice(0, INBOX_PAGE_SIZE)
  const active = activeRows.slice(0, INBOX_PAGE_SIZE)
  const done = doneRows.slice(0, DONE_PAGE_SIZE)
  if (truncated) {
    logger.warn('[OnlineOrdering] la bandeja se recortó por un tope (los activos siguen con nextCursor)', {
      venueId: p.venueId,
      counts,
      topes: { porAceptar: INBOX_PAGE_SIZE, activos: INBOX_PAGE_SIZE, cerrados: DONE_PAGE_SIZE },
    })
  }

  return {
    serverTime: now.toISOString(),
    counts,
    orders: [...pending, ...active, ...done].map(r => toInboxOrder(r, now)),
    truncated,
    /** A8: si quedaron activos fuera, pásalo como `cursor` (con `status=active`) para la siguiente página; si no, `null`. */
    nextCursor: activeRows.length > INBOX_PAGE_SIZE ? toActiveCursor(active[active.length - 1]) : null,
  }
}
