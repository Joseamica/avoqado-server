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
import { OrderFilters } from './order.dashboard.service'
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
  if (filters.types && filters.types.length > 0) parts.push(Prisma.sql`${O}."type"::text IN (${Prisma.join(filters.types)})`)
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

async function groupOrders(scope: Prisma.Sql, clientScope: Prisma.Sql): Promise<OrderSummaryGroup[]> {
  const rows = await prisma.$queryRaw<Array<{ status: string; count: number; total: Prisma.Decimal; tipAmount: Prisma.Decimal }>>`
    SELECT o."status"::text AS "status",
           COUNT(*)::int AS "count",
           COALESCE(SUM(o."total"), 0) AS "total",
           COALESCE(SUM(o."tipAmount"), 0) AS "tipAmount"
    FROM "Order" o
    WHERE ${scope} AND ${clientScope}
    GROUP BY o."status"
    ORDER BY o."status"
  `
  return (rows ?? []).map(r => ({ status: r.status, count: r.count, total: Number(r.total), tipAmount: Number(r.tipAmount) }))
}

export const sumOrderGroupCount = (groups: OrderSummaryGroup[]): number => groups.reduce((s, g) => s + g.count, 0)

export async function getOrdersSummary(venueId: string, filters?: OrderFilters, client?: OrderClientFilters): Promise<OrdersSummary> {
  if (!venueId) throw new NotFoundError('Venue ID es requerido')
  const scope = ordersSqlScope(venueId, filters)
  const groups = await groupOrders(scope, Prisma.sql`TRUE`)
  const filteredGroups = hasOrderClientFilters(client) ? await groupOrders(scope, ordersClientSqlScope(client)) : groups
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
 * Valores DISTINTOS de las órdenes del venue, con el MISMO alcance base que el listado
 * sin filtros (fuera PENDING/CANCELLED/DELETED — por eso el filtro de estado nunca
 * ofreció "cancelada": así era y así sigue). Meseros = `servedBy || createdBy`.
 */
export async function getOrderFilterOptions(venueId: string): Promise<OrderFilterOptions> {
  if (!venueId) throw new NotFoundError('Venue ID es requerido')
  const scope = ordersSqlScope(venueId)

  const [statuses, types, fast, tables, waiters] = await Promise.all([
    prisma.$queryRaw<Array<{ v: string }>>`SELECT DISTINCT o."status"::text AS "v" FROM "Order" o WHERE ${scope} ORDER BY 1`,
    prisma.$queryRaw<Array<{ v: string }>>`SELECT DISTINCT o."type"::text AS "v" FROM "Order" o WHERE ${scope} ORDER BY 1`,
    prisma.$queryRaw<
      Array<{ v: boolean }>
    >`SELECT EXISTS (SELECT 1 FROM "Order" o WHERE ${scope} AND o."orderNumber" LIKE 'FAST-%') AS "v"`,
    prisma.$queryRaw<Array<{ id: string; number: string }>>`
      SELECT t."id", t."number" FROM "Table" t
      WHERE t."id" IN (SELECT DISTINCT o."tableId" FROM "Order" o WHERE ${scope} AND o."tableId" IS NOT NULL)
      ORDER BY t."number", t."id"
    `,
    prisma.$queryRaw<Array<{ id: string; firstName: string; lastName: string }>>`
      SELECT s."id", s."firstName", s."lastName" FROM "Staff" s
      WHERE s."id" IN (SELECT DISTINCT COALESCE(o."servedById", o."createdById") FROM "Order" o WHERE ${scope} AND COALESCE(o."servedById", o."createdById") IS NOT NULL)
      ORDER BY s."firstName", s."lastName", s."id"
    `,
  ])

  return {
    statuses: (statuses ?? []).map(r => r.v).filter(Boolean),
    types: (types ?? []).map(r => r.v).filter(Boolean),
    hasFastSales: Boolean(fast?.[0]?.v),
    tables: tables ?? [],
    waiters: waiters ?? [],
  }
}
