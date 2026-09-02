/**
 * Resumen de /orders para el dashboard — conteos por estado y sumas, en Postgres.
 *
 * Gemelo de `paymentSummary.dashboard.service.ts` (léelo primero: ahí está el porqué).
 * `Orders.tsx` pedía el listado con `pageSize: 10000` para contar pestañas y sumar
 * tarjetas en el navegador. Aquí se contesta con UN `GROUP BY` por estado.
 *
 * 🔴 `ordersSqlScope` espeja predicado por predicado a `buildOrdersWhereClause` (el
 * del listado y el export). La paridad se prueba contra base real en
 * `tests/integration/dashboard/listSummary-sql-parity.integration.test.ts`.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { utcTs } from '../../utils/sqlDates'
import { FAST_ORDER_NUMBER_PREFIX, FAST_TYPE_FILTER, OrderFilters } from './order.dashboard.service'
import { AmountFilter, amountPredicate, andAll, decimalBind, ilikeContains, orAny } from './listSummary.shared'

/** Los filtros que hoy aplica `Orders.tsx` en el navegador, encima del listado. */
export interface OrderClientFilters {
  total?: AmountFilter
  tip?: AmountFilter
}

export interface OrderSummaryGroup {
  status: string
  count: number
  total: number
  tipAmount: number
}

export interface OrdersSummary {
  groups: OrderSummaryGroup[]
  filteredGroups: OrderSummaryGroup[]
  total: number
  filteredTotal: number
}

const O = Prisma.raw('o')

/** Espejo SQL de `buildOrdersWhereClause(venueId, filters)`. */
export function ordersSqlScope(venueId: string, filters?: OrderFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    // { venueId }
    Prisma.sql`${O}."venueId" = ${venueId}`,
  ]
  // { status: { notIn: [PENDING, CANCELLED, DELETED] } } — salvo que el usuario elija estados
  if (filters?.statuses && filters.statuses.length > 0) {
    parts.push(Prisma.sql`${O}."status"::text IN (${Prisma.join(filters.statuses)})`)
  } else {
    parts.push(Prisma.sql`${O}."status"::text NOT IN ('PENDING', 'CANCELLED', 'DELETED')`)
  }
  if (!filters) return andAll(parts)

  // { type: { in } }
  // { type: { in } } — 'FAST' se traduce a `orderNumber LIKE 'FAST-%'` (ver buildOrdersWhereClause)
  if (filters.types && filters.types.length > 0) {
    const realTypes = filters.types.filter(t => t !== FAST_TYPE_FILTER)
    if (realTypes.length === filters.types.length) {
      parts.push(Prisma.sql`${O}."type"::text IN (${Prisma.join(filters.types)})`)
    } else {
      const or: Prisma.Sql[] = [Prisma.sql`${O}."orderNumber" LIKE ${`${FAST_ORDER_NUMBER_PREFIX}%`}`]
      if (realTypes.length > 0) or.push(Prisma.sql`${O}."type"::text IN (${Prisma.join(realTypes)})`)
      parts.push(orAny(or))
    }
  }
  // { tableId: { in } }
  if (filters.tableIds && filters.tableIds.length > 0) parts.push(Prisma.sql`${O}."tableId" IN (${Prisma.join(filters.tableIds)})`)
  // { servedById: { in } }
  if (filters.staffIds && filters.staffIds.length > 0) parts.push(Prisma.sql`${O}."servedById" IN (${Prisma.join(filters.staffIds)})`)
  // { createdAt: { gte, lte } } — 🔴 siempre utcTs
  if (filters.startDate) parts.push(Prisma.sql`${O}."createdAt" >= ${utcTs(new Date(filters.startDate))}`)
  if (filters.endDate) parts.push(Prisma.sql`${O}."createdAt" <= ${utcTs(new Date(filters.endDate))}`)

  // { OR: [ orderNumber~, total≈n, orderCustomers.some.customer.{firstName|lastName|phone}~ ] }
  if (filters.search) {
    const term = filters.search.trim()
    const n = parseFloat(term)
    const or: Prisma.Sql[] = [ilikeContains(Prisma.sql`${O}."orderNumber"`, term)]
    if (!isNaN(n)) or.push(Prisma.sql`${O}."total" >= ${decimalBind(n)} AND ${O}."total" < ${decimalBind(n + 1)}`)
    or.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM "OrderCustomer" oc JOIN "Customer" c ON c."id" = oc."customerId"
        WHERE oc."orderId" = ${O}."id"
          AND (${ilikeContains(Prisma.sql`c."firstName"`, term)} OR ${ilikeContains(Prisma.sql`c."lastName"`, term)} OR ${ilikeContains(
            Prisma.sql`c."phone"`,
            term,
          )})
      )`,
    )
    parts.push(orAny(or))
  }
  return andAll(parts)
}

export function ordersClientSqlScope(client?: OrderClientFilters): Prisma.Sql {
  if (!client) return Prisma.sql`TRUE`
  const parts: Prisma.Sql[] = []
  if (client.total) parts.push(amountPredicate(Prisma.sql`${O}."total"`, client.total))
  if (client.tip) parts.push(amountPredicate(Prisma.sql`${O}."tipAmount"`, client.tip))
  return andAll(parts)
}

export const hasOrderClientFilters = (client?: OrderClientFilters): boolean => Boolean(client && (client.total || client.tip))

type OrderGroupRow = {
  status: string
  count: number
  total: Prisma.Decimal
  tipAmount: Prisma.Decimal
  fcount: number
  ftotal: Prisma.Decimal
  ftipAmount: Prisma.Decimal
}

/** UNA pasada: agregados de pestañas y de tarjetas del mismo escaneo, con `FILTER (WHERE …)`. */
async function groupOrders(
  scope: Prisma.Sql,
  clientScope: Prisma.Sql,
): Promise<{ groups: OrderSummaryGroup[]; filteredGroups: OrderSummaryGroup[] }> {
  const rows = await prisma.$queryRaw<OrderGroupRow[]>`
    SELECT o."status"::text AS "status",
           COUNT(*)::int AS "count",
           COALESCE(SUM(o."total"), 0) AS "total",
           COALESCE(SUM(o."tipAmount"), 0) AS "tipAmount",
           COUNT(*) FILTER (WHERE ${clientScope})::int AS "fcount",
           COALESCE(SUM(o."total") FILTER (WHERE ${clientScope}), 0) AS "ftotal",
           COALESCE(SUM(o."tipAmount") FILTER (WHERE ${clientScope}), 0) AS "ftipAmount"
    FROM "Order" o
    WHERE ${scope}
    GROUP BY o."status"
    ORDER BY o."status"
  `
  const all = rows ?? []
  return {
    groups: all.map(r => ({ status: r.status, count: r.count, total: Number(r.total), tipAmount: Number(r.tipAmount) })),
    filteredGroups: all
      .filter(r => r.fcount > 0)
      .map(r => ({ status: r.status, count: r.fcount, total: Number(r.ftotal), tipAmount: Number(r.ftipAmount) })),
  }
}

export const sumOrderGroupCount = (groups: OrderSummaryGroup[]): number => groups.reduce((s, g) => s + g.count, 0)

export async function getOrdersSummary(venueId: string, filters?: OrderFilters, client?: OrderClientFilters): Promise<OrdersSummary> {
  if (!venueId) throw new NotFoundError('Venue ID es requerido')
  const { groups, filteredGroups } = await groupOrders(
    ordersSqlScope(venueId, filters),
    hasOrderClientFilters(client) ? ordersClientSqlScope(client) : Prisma.sql`TRUE`,
  )
  return { groups, filteredGroups, total: sumOrderGroupCount(groups), filteredTotal: sumOrderGroupCount(filteredGroups) }
}

// ─── Opciones de los filtros (antes: las 500 filas más recientes del listado) ──

export interface OrderFilterOptions {
  statuses: string[]
  types: string[]
  /** Hay órdenes `FAST-…` (venta sin productos): el cliente añade la opción 'FAST'. */
  hasFastSales: boolean
  tables: Array<{ id: string; number: string }>
  waiters: Array<{ id: string; firstName: string; lastName: string }>
}

/**
 * Valores DISTINTOS de las órdenes del venue, con el MISMO alcance base que el listado sin
 * filtros (fuera PENDING/CANCELLED/DELETED — por eso el filtro de estado nunca ofreció
 * "cancelada": así era y así sigue). Meseros = `servedBy || createdBy`. UN escaneo de las
 * órdenes + dos búsquedas por id.
 */
export async function getOrderFilterOptions(venueId: string): Promise<OrderFilterOptions> {
  if (!venueId) throw new NotFoundError('Venue ID es requerido')
  const scope = ordersSqlScope(venueId)

  const [facets] = await prisma.$queryRaw<
    Array<{ statuses: string[] | null; types: string[] | null; fast: boolean | null; tableIds: string[] | null; staffIds: string[] | null }>
  >`
    SELECT array_agg(DISTINCT o."status"::text) AS "statuses",
           array_agg(DISTINCT o."type"::text) AS "types",
           bool_or(o."orderNumber" LIKE 'FAST-%') AS "fast",
           array_agg(DISTINCT o."tableId") FILTER (WHERE o."tableId" IS NOT NULL) AS "tableIds",
           array_agg(DISTINCT COALESCE(o."servedById", o."createdById")) FILTER (WHERE COALESCE(o."servedById", o."createdById") IS NOT NULL) AS "staffIds"
    FROM "Order" o
    WHERE ${scope}
  `
  const tableIds = facets?.tableIds ?? []
  const staffIds = facets?.staffIds ?? []
  const [tables, waiters] = await Promise.all([
    tableIds.length > 0
      ? prisma.table.findMany({
          where: { id: { in: tableIds } },
          select: { id: true, number: true },
          orderBy: [{ number: 'asc' }, { id: 'asc' }],
        })
      : Promise.resolve([]),
    staffIds.length > 0
      ? prisma.staff.findMany({
          where: { id: { in: staffIds } },
          select: { id: true, firstName: true, lastName: true },
          orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
        })
      : Promise.resolve([]),
  ])

  return {
    statuses: [...(facets?.statuses ?? [])].sort(),
    types: [...(facets?.types ?? [])].sort(),
    hasFastSales: Boolean(facets?.fast),
    tables,
    waiters,
  }
}
