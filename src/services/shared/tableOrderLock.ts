import { Prisma } from '@prisma/client'
import { NotFoundError, ForbiddenError } from '@/errors/AppError'
import { tomarCandadoDeComandas } from '@/services/kds/kitchenTicketAuthoring.service'
type Tx = Prisma.TransactionClient
const openStatus = { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] as ('COMPLETED' | 'CANCELLED' | 'DELETED')[] }
const orderSelect = { id: true, tableId: true, status: true, paymentStatus: true, createdAt: true } as const
export const tableSelect = { id: true, number: true, status: true, currentOrderId: true } as const
type OrderRow = Prisma.OrderGetPayload<{ select: typeof orderSelect }>
export type TableRow = Prisma.TableGetPayload<{ select: typeof tableSelect }>
export type LockedTableScope = { venueId: string; tables: TableRow[]; orders: OrderRow[] }
type ScopeInput = {
  venueId: string
  orderIds: readonly string[]
  tableIds?: readonly string[]
  kdsOrderIds?: readonly string[]
  /** POS classification only: this one candidate may disappear; every other order and every Table stays strict. */
  optionalOrderId?: string
}
export class OrderTableTopologyChanged extends Error {
  constructor() {
    super('ORDER_TABLE_TOPOLOGY_CHANGED')
  }
}
const sorted = (ids: readonly string[]) => [...new Set(ids)].sort()
async function snapshot(tx: Tx, input: ScopeInput): Promise<LockedTableScope> {
  const explicitIds = sorted(input.orderIds)
  const explicit = explicitIds.length
    ? await tx.order.findMany({
        where: { venueId: input.venueId, id: { in: explicitIds } },
        select: orderSelect,
        orderBy: { id: 'asc' },
        take: explicitIds.length,
      })
    : []
  const pointing = explicitIds.length
    ? await tx.table.findMany({
        where: { venueId: input.venueId, currentOrderId: { in: explicitIds } },
        select: tableSelect,
        orderBy: { id: 'asc' },
        take: explicitIds.length,
      })
    : []
  const tableIds = sorted([...(input.tableIds ?? []), ...pointing.map(t => t.id), ...explicit.flatMap(o => (o.tableId ? [o.tableId] : []))])
  const tables = tableIds.length
    ? await tx.table.findMany({
        where: { venueId: input.venueId, id: { in: tableIds } },
        select: tableSelect,
        orderBy: { id: 'asc' },
        take: tableIds.length,
      })
    : []
  const byId = new Map(explicit.map(o => [o.id, o]))
  if (tableIds.length) {
    let cursor: string | undefined
    for (;;) {
      const page = await tx.order.findMany({
        where: { venueId: input.venueId, tableId: { in: tableIds }, status: openStatus, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: orderSelect,
        orderBy: { id: 'asc' },
        take: 100,
      })
      for (const order of page) byId.set(order.id, order)
      if (page.length < 100) break
      cursor = page[page.length - 1].id
    }
  }
  const pointers = sorted(tables.flatMap(t => (t.currentOrderId ? [t.currentOrderId] : [])).filter(id => !byId.has(id)))
  for (let start = 0; start < pointers.length; start += 100) {
    const ids = pointers.slice(start, start + 100)
    for (const order of await tx.order.findMany({
      where: { venueId: input.venueId, id: { in: ids } },
      select: orderSelect,
      orderBy: { id: 'asc' },
      take: ids.length,
    }))
      byId.set(order.id, order)
  }
  if (tables.some(t => t.currentOrderId && !byId.has(t.currentOrderId)))
    throw new ForbiddenError('La cuenta de la mesa no pertenece a este establecimiento')
  return { venueId: input.venueId, tables, orders: [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) }
}
function shape(scope: LockedTableScope) {
  return JSON.stringify({
    tables: scope.tables.map(t => [t.id, t.currentOrderId, t.status]),
    orders: scope.orders.map(o => [o.id, o.tableId, o.status, o.paymentStatus]),
  })
}
export async function lockTableOrderScope(tx: Tx, input: ScopeInput): Promise<LockedTableScope> {
  if (
    input.optionalOrderId !== undefined &&
    (!input.optionalOrderId ||
      input.orderIds.length !== 1 ||
      input.orderIds[0] !== input.optionalOrderId ||
      (input.kdsOrderIds?.length ?? 0) > 0)
  )
    throw new RangeError('An optional POS candidate requires exactly its one explicit order ID and no KDS claims')
  const venues = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Venue" WHERE id=${input.venueId} FOR KEY SHARE`
  if (!venues.length) throw new NotFoundError('Venue not found')
  let before = await snapshot(tx, input)
  if (input.orderIds.some(id => id !== input.optionalOrderId && !before.orders.some(o => o.id === id)))
    throw new NotFoundError('Order not found')
  if ((input.tableIds ?? []).some(id => !before.tables.some(t => t.id === id)))
    throw new NotFoundError('Table not found or does not belong to this venue')
  for (const id of sorted(input.kdsOrderIds ?? [])) await tomarCandadoDeComandas(tx, id)
  const ids = before.orders.map(o => o.id)
  if (ids.length) {
    // PostgreSQL orders the entire known set in its own collation, not separately sorted JS chunks.
    const locked = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM "Order" WHERE "venueId"=${input.venueId} AND id=ANY(${ids}::text[]) ORDER BY id FOR UPDATE`
    const lockedIds = new Set(locked.map(order => order.id))
    const missing = ids.filter(id => !lockedIds.has(id))
    if (locked.length !== ids.length || missing.length > 0) {
      // Keep the complete required set. Only POS's classified candidate may vanish while this claim waits;
      // no extra ID, duplicate row, sibling loss, changed Table set or second lock pass is accepted.
      if (
        !input.optionalOrderId ||
        missing.length !== 1 ||
        missing[0] !== input.optionalOrderId ||
        locked.length !== ids.length - 1 ||
        lockedIds.size !== locked.length ||
        locked.some(order => !ids.includes(order.id))
      )
        throw new OrderTableTopologyChanged()
      before = { ...before, orders: before.orders.filter(order => order.id !== input.optionalOrderId) }
    }
  }
  const tableIds = before.tables.map(t => t.id)
  if (tableIds.length) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM "Table" WHERE "venueId"=${input.venueId} AND id IN (${Prisma.join(tableIds)}) ORDER BY id FOR NO KEY UPDATE`,
    )
    if (locked.length !== tableIds.length) throw new OrderTableTopologyChanged()
  }
  let after: LockedTableScope
  try {
    after = await snapshot(tx, input)
  } catch (error) {
    if (error instanceof ForbiddenError) throw new OrderTableTopologyChanged()
    throw error
  }
  if (shape(before) !== shape(after)) throw new OrderTableTopologyChanged()
  return after
}
