/**
 * Organization Dashboard Service
 * Provides organization-level metrics, manager dashboards, and cross-venue analytics
 * for the PlayTelecom/White-Label dashboard.
 *
 * IMPORTANT: All date calculations use venue timezone (America/Mexico_City by default)
 * to ensure "today", "this week", "this month" match the business's operating timezone.
 *
 * Límite conocido (decisión del founder, 2026-09-01): las funciones de ORGANIZACIÓN usan
 * UNA zona por llamada (`timezone`, default DEFAULT_TIMEZONE), no la de cada venue: la
 * organización no tiene zona propia y "hoy" es un solo corte para todas sus tiendas. Es
 * exacto mientras todas las tiendas de la org compartan zona (hoy, todas). Con tiendas en
 * zonas distintas (Tijuana, Cancún) el "hoy" de esa tienda queda corrido 1 h. Los heatmaps
 * sí agrupan por `v."timezone"` de cada tienda. Si algún día hace falta, el arreglo es
 * "hoy" por tienda en TODAS las funciones de org, no sólo en algunas.
 */
import { Prisma, StaffRole } from '@prisma/client'
import { endOfDay, endOfMonth, format, startOfDay, subDays } from 'date-fns'
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz'
import { localWallClock, utcTs } from '../../utils/sqlDates'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { ROLE_HIERARCHY } from '../../lib/permissions'
import {
  DEFAULT_TIMEZONE,
  parseDbDateRange,
  venueEndOfDay,
  venueStartOfDay,
  venueStartOfDayOffset,
  venueStartOfMonth,
} from '../../utils/datetime'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import { computeTerminalMigration, type MigrationCommandLike } from '../dashboard/terminals.superadmin.service'
import { cerrarSesionesNuevasPorCambioDeContrasena } from '../../utils/passwordChangeGuard'

// Types for organization dashboard
export interface OrgCategoryBreakdown {
  id: string
  name: string
  sales: number
  units: number
  percentage: number
}

export interface OrgVisionGlobalSummary {
  todaySales: number
  todayCashSales: number
  weekSales: number
  monthSales: number
  unitsSold: number
  avgTicket: number
  activePromoters: number
  totalPromoters: number
  activeStores: number
  totalStores: number
  approvedDeposits: number
  categoryBreakdown: OrgCategoryBreakdown[]
}

export interface OrgStorePerformance {
  id: string
  name: string
  slug: string
  logo: string | null
  todaySales: number
  weekSales: number
  unitsSold: number
  promoterCount: number
  activePromoters: number
  trend: 'up' | 'down' | 'stable'
  rank: number
  performance?: number // Goal progress percentage (0-100+)
  goalAmount?: number // Configured goal amount
  goalType?: 'AMOUNT' | 'QUANTITY' // Type of goal (currency or unit count)
  goalPeriod?: 'DAILY' | 'WEEKLY' | 'MONTHLY'
  goalId?: string // ID of the active venue-wide sales goal
  goalSource?: 'venue' | 'organization' // Where the goal config came from
}

export interface OrgCrossStoreAnomaly {
  id: string
  type: 'LOW_PERFORMANCE' | 'NO_CHECKINS' | 'LOW_STOCK' | 'PENDING_DEPOSITS' | 'GPS_VIOLATION'
  severity: 'CRITICAL' | 'WARNING' | 'INFO'
  storeId: string
  storeName: string
  title: string
  description: string
}

export interface ManagerDashboard {
  manager: {
    id: string
    name: string
    email: string | null
    phone: string | null
  }
  stores: Array<{
    id: string
    name: string
    slug: string
    todaySales: number
    weekSales: number
    promoterCount: number
    activePromoters: number
    monthGoal: number
    goalProgress: number
  }>
  aggregateMetrics: {
    totalSales: number
    totalUnits: number
    avgGoalProgress: number
    promotersActive: number
    promotersTotal: number
  }
}

export interface OrgStockSummary {
  totalPieces: number
  totalValue: number
  lowStockAlerts: number
  criticalAlerts: number
  storeBreakdown: Array<{
    storeId: string
    storeName: string
    available: number
    value: number
    alertLevel: 'OK' | 'WARNING' | 'CRITICAL'
  }>
}

export interface OnlineStaffMember {
  staffId: string
  staffName: string
  venueId: string
  venueName: string
  clockInTime: Date
  role: string
}

export interface OrgOnlineStaff {
  onlineCount: number
  totalCount: number
  percentageOnline: number
  byVenue: Array<{
    venueId: string
    venueName: string
    onlineCount: number
    totalCount: number
  }>
  onlineStaff: OnlineStaffMember[]
}

export type ActivityType = 'sale' | 'checkin' | 'checkout' | 'gps_error' | 'alert' | 'other'
export type ActivitySeverity = 'normal' | 'warning' | 'error'

export interface ActivityEvent {
  id: string
  type: ActivityType
  title: string
  subtitle: string // "Staff Name • Venue Name"
  timestamp: Date
  severity: ActivitySeverity
  venueId: string
  venueName: string
  staffId?: string
  staffName?: string
  // Org-internal identifier (white-label orgs). Populated when the staff
  // member has a code set; left blank otherwise. Surfaced beside the name in
  // the dashboard and in CSV/Excel exports so Walmart-style audits can map
  // sales/check-ins to the org's own ID system.
  staffEmployeeCode?: string | null
  metadata?: Record<string, any>
}

export interface OrgActivityFeed {
  events: ActivityEvent[]
  total: number
}

export interface OrganizationGoalData {
  id: string
  organizationId: string
  period: string
  periodDate: Date
  salesTarget: number
  volumeTarget: number
}

export interface RevenueVsTargetData {
  day: string // "Lun", "Mar", "Mié", etc.
  actual: number // Actual revenue
  target: number // Target revenue for that day
  date: string // ISO date string
}

export interface VolumeVsTargetData {
  day: string
  actual: number // Actual count
  target: number // Target count
  date: string // ISO date string
}

/**
 * Compare two version strings numerically (e.g. "1.14.0" > "1.9.0").
 * Returns >0 if a is newer, <0 if older, 0 if equal. Tolerant of non-semver
 * formats — splits on . - + and treats missing/NaN segments as 0.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/)
  const pb = b.split(/[.\-+]/)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = parseInt(pa[i] ?? '0', 10) || 0
    const y = parseInt(pb[i] ?? '0', 10) || 0
    if (x !== y) return x - y
  }
  return 0
}

// ── Reescritura 2026-09-01 (fase 3 de la migración Node→SQL) ──────────────────
// Las agregaciones de este servicio materializaban en Node TODAS las órdenes, pagos o
// checadas de la organización en el rango (PlayTelecom: ~40 tiendas) sólo para contar,
// sumar o agrupar. Ahora agrega Postgres y Node da formato. Reglas de estas consultas,
// verificadas contra findMany en el borde exacto (la sesión de Postgres corre en
// America/Mexico_City y las columnas guardan UTC real):
//  · un bind de fecha se compara SIEMPRE con `utcTs(d)`: un `${d}` pelón corre 6 horas;
//  · el día del venue es ((col AT TIME ZONE 'UTC') AT TIME ZONE tz), nunca una sola vez;
//  · divisiones, redondeos y desempates se quedan en Node, idénticos a los de antes.

/** Tabla física de `TimeEntry` (`@@map("time_entries")`). */
const TIME_ENTRIES = Prisma.raw('"time_entries"')

/** `col >= from` y, si hay tope, `col <= to` — con los binds correctos para columnas UTC. */
const rangeSql = (col: Prisma.Sql, from: Date, to?: Date): Prisma.Sql =>
  to ? Prisma.sql`${col} >= ${utcTs(from)} AND ${col} <= ${utcTs(to)}` : Prisma.sql`${col} >= ${utcTs(from)}`

/** Subconsulta con los ids de TODOS los venues de la org (sin filtrar por status): acota una consulta al tenant en el propio SQL. */
const orgVenueIdsSql = (orgId: string): Prisma.Sql => Prisma.sql`SELECT ov."id" FROM "Venue" ov WHERE ov."organizationId" = ${orgId}`

/** Día civil del venue (YYYY-MM-DD) de una columna UTC, con la zona de la fila `Venue` (alias `v`). */
const venueLocalDay = (col: Prisma.Sql): Prisma.Sql =>
  Prisma.sql`to_char((${col} AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(NULLIF(v."timezone", ''), ${DEFAULT_TIMEZONE}), 'YYYY-MM-DD')`

/**
 * Personas distintas con checada en la ventana, por tienda. Sustituye a los
 * `timeEntry.findMany({ distinct })`: Prisma resuelve `distinct` en memoria del
 * cliente, así que traía todas las checadas del rango sólo para contar personas.
 */
/**
 * Días civiles del rango [from, to] como 'YYYY-MM-DD', iterados en UTC y anclados a mediodía:
 * nunca pasan por la zona del host. (`eachDayOfInterval({ start: new Date('YYYY-MM-DD') })`
 * daba el rango correcto en un host UTC y corrido un día en un host en México.)
 */
function calendarDayStrings(fromStr: string, toStr: string): string[] {
  const out: string[] = []
  const end = new Date(`${toStr}T12:00:00Z`)
  for (const cur = new Date(`${fromStr}T12:00:00Z`); cur <= end; cur.setUTCDate(cur.getUTCDate() + 1)) {
    out.push(cur.toISOString().slice(0, 10))
  }
  return out
}

async function activeStaffByVenue(venueIds: string[], from: Date, to?: Date): Promise<Map<string, number>> {
  if (venueIds.length === 0) return new Map()
  const rows = await prisma.$queryRaw<Array<{ venueId: string; n: number }>>`
    SELECT te."venueId", COUNT(DISTINCT te."staffId")::int AS "n"
    FROM ${TIME_ENTRIES} te
    WHERE te."venueId" IN (${Prisma.join(venueIds)}) AND ${rangeSql(Prisma.raw('te."clockInTime"'), from, to)}
    GROUP BY te."venueId"
  `
  return new Map(rows.map(r => [r.venueId, r.n]))
}

/** Personas distintas con checada en la ventana en cualquiera de las tiendas (en dos tiendas cuenta una vez). */
async function activeStaffCount(venueIds: string[], from: Date, to?: Date): Promise<number> {
  if (venueIds.length === 0) return 0
  const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(DISTINCT te."staffId")::int AS "n"
    FROM ${TIME_ENTRIES} te
    WHERE te."venueId" IN (${Prisma.join(venueIds)}) AND ${rangeSql(Prisma.raw('te."clockInTime"'), from, to)}
  `
  return row?.n ?? 0
}

/**
 * Efectivo cobrado DURANTE cada checada del rango: los pagos CASH completados de esa
 * persona en esa tienda con `createdAt` en [clockIn, clockOut], inclusivo — una checada
 * abierta llega hasta el fin del rango. Antes se traían todos los pagos en efectivo del
 * rango y se cruzaban en Node checada por checada.
 */
async function cashSalesPerTimeEntry(venueIds: string[], from: Date, to: Date): Promise<Map<string, number>> {
  if (venueIds.length === 0) return new Map()
  const rows = await prisma.$queryRaw<Array<{ timeEntryId: string; cash: Prisma.Decimal | null }>>`
    SELECT te."id" AS "timeEntryId", SUM(p."amount") AS "cash"
    FROM ${TIME_ENTRIES} te
    JOIN "Payment" p
      ON p."processedById" = te."staffId"
     AND p."venueId" = te."venueId"
     AND p."createdAt" >= te."clockInTime"
     AND (te."clockOutTime" IS NULL OR p."createdAt" <= te."clockOutTime")
    WHERE te."venueId" IN (${Prisma.join(venueIds)})
      AND ${rangeSql(Prisma.raw('te."clockInTime"'), from, to)}
      AND ${rangeSql(Prisma.raw('p."createdAt"'), from, to)}
      AND p."status" = 'COMPLETED'
      AND p."method" = 'CASH'
    GROUP BY te."id"
  `
  return new Map(rows.map(r => [r.timeEntryId, Number(r.cash) || 0]))
}

class OrganizationDashboardService {
  /**
   * Get vision global summary for an organization (aggregate KPIs)
   *
   * IMPORTANT: Date calculations use venue timezone (America/Mexico_City by default)
   * to ensure "today", "this week", "this month" match the business's operating timezone,
   * not the server's timezone (which may be UTC).
   */
  async getVisionGlobalSummary(
    orgId: string,
    timezone: string = 'America/Mexico_City',
    startDate?: string,
    endDate?: string,
    filterVenueId?: string,
  ): Promise<OrgVisionGlobalSummary> {
    // Calculate dates in venue timezone for DB queries.
    // IMPORTANT: DB stores local time in `timestamp without time zone` columns
    // (PostgreSQL timezone = America/Mexico_City). Use parseDbDateRange/venueStartOf*
    // helpers which create Dates where UTC components = venue local time,
    // matching the DB's storage format.
    let todayStart: Date
    let rangeEnd: Date | undefined

    if (startDate || endDate) {
      const range = parseDbDateRange(startDate, endDate, timezone, 1)
      todayStart = range.from
      rangeEnd = range.to
    } else {
      todayStart = venueStartOfDay(timezone)
    }

    // Week start (7 days ago) in venue timezone
    const weekStart = venueStartOfDayOffset(timezone, -7)

    // Month start in venue timezone
    const monthStart = venueStartOfMonth(timezone)

    // Get all venues in organization (or just the filtered one)
    const venues = await prisma.venue.findMany({
      where: {
        organizationId: orgId,
        status: 'ACTIVE',
        ...(filterVenueId ? { id: filterVenueId } : {}),
      },
      select: { id: true },
    })
    const venueIds = venues.map(v => v.id)

    // Also get total venue count (unfiltered) for the totalStores metric
    const allVenuesCount = filterVenueId ? await prisma.venue.count({ where: { organizationId: orgId, status: 'ACTIVE' } }) : venues.length

    if (venueIds.length === 0) {
      return {
        todaySales: 0,
        todayCashSales: 0,
        weekSales: 0,
        monthSales: 0,
        unitsSold: 0,
        avgTicket: 0,
        activePromoters: 0,
        totalPromoters: 0,
        activeStores: 0,
        totalStores: 0,
        approvedDeposits: 0,
        categoryBreakdown: [],
      }
    }

    // Aggregate sales from completed orders — sumas y categorías en Postgres (antes se
    // materializaban todas las órdenes del rango con sus items para reducirlas en Node).
    const rangeFilter = rangeEnd ? { gte: todayStart, lte: rangeEnd } : { gte: todayStart }
    const orderScope = Prisma.sql`o."venueId" IN (${Prisma.join(venueIds)}) AND o."status" = 'COMPLETED' AND ${rangeSql(Prisma.raw('o."createdAt"'), todayStart, rangeEnd)}`
    const [todayTotals, categoryRows, weekOrders, monthOrders] = await Promise.all([
      prisma.$queryRaw<Array<{ sales: Prisma.Decimal | null; orders: number }>>`
        SELECT SUM(o."total") AS "sales", COUNT(*)::int AS "orders"
        FROM "Order" o
        WHERE ${orderScope}
      `,
      // Una fila por categoría. Productos normales: `categoryName` desnormalizado; SIMs:
      // `categoryName` nulo y el `productName` ES la categoría. Vacío cae al siguiente, como el `||`.
      prisma.$queryRaw<Array<{ name: string; units: number; sales: Prisma.Decimal | null }>>`
        SELECT COALESCE(NULLIF(oi."categoryName", ''), NULLIF(oi."productName", ''), 'Sin categoría') AS "name",
               SUM(oi."quantity")::int AS "units", SUM(oi."total") AS "sales"
        FROM "OrderItem" oi
        JOIN "Order" o ON o."id" = oi."orderId"
        WHERE ${orderScope}
        GROUP BY 1
        ORDER BY SUM(oi."quantity") DESC, 1
      `,
      prisma.order.aggregate({
        where: {
          venueId: { in: venueIds },
          status: 'COMPLETED',
          createdAt: { gte: weekStart },
        },
        _sum: { total: true },
      }),
      prisma.order.aggregate({
        where: {
          venueId: { in: venueIds },
          status: 'COMPLETED',
          createdAt: { gte: monthStart },
        },
        _sum: { total: true },
      }),
    ])

    const todaySales = Number(todayTotals[0]?.sales) || 0
    const todayOrderCount = todayTotals[0]?.orders ?? 0
    const unitsSold = categoryRows.reduce((sum, c) => sum + c.units, 0)
    const avgTicket = todayOrderCount > 0 ? todaySales / todayOrderCount : 0

    // Sum CASH payments only (money physically in the field)
    const cashPaymentsResult = await prisma.payment.aggregate({
      where: {
        venueId: { in: venueIds },
        method: 'CASH',
        status: 'COMPLETED',
        createdAt: rangeFilter,
      },
      _sum: { amount: true },
    })
    const todayCashSales = Number(cashPaymentsResult._sum?.amount) || 0

    // Count promoters (distinct staff with a check-in in range — counted in Postgres)
    const [activePromoters, totalPromoters] = await Promise.all([
      activeStaffCount(venueIds, todayStart, rangeEnd),
      prisma.staffVenue.count({
        where: {
          venueId: { in: venueIds },
          active: true,
          role: { in: ['CASHIER', 'WAITER'] },
        },
      }),
    ])

    // Count active stores (stores with sales in range)
    const storesWithSales = await prisma.order.groupBy({
      by: ['venueId'],
      where: {
        venueId: { in: venueIds },
        status: 'COMPLETED',
        createdAt: rangeFilter,
      },
    })

    // Sum approved cash deposits in the date range
    const approvedDepositsResult = await prisma.cashDeposit.aggregate({
      where: {
        venueId: { in: venueIds },
        status: 'APPROVED',
        timestamp: rangeFilter,
      },
      _sum: { amount: true },
    })
    const approvedDeposits = Number(approvedDepositsResult._sum?.amount) || 0

    // Top 5 categorías por unidades (ya vienen ordenadas de Postgres; el porcentaje es
    // sobre TODAS las unidades del rango, no sólo las cinco mostradas — como siempre).
    const totalCategoryUnits = unitsSold
    const categoryBreakdown: OrgCategoryBreakdown[] = categoryRows.slice(0, 5).map(cat => ({
      id: cat.name,
      name: cat.name,
      sales: Math.round((Number(cat.sales) || 0) * 100) / 100,
      units: cat.units,
      percentage: totalCategoryUnits > 0 ? Math.round((cat.units / totalCategoryUnits) * 100) : 0,
    }))

    return {
      todaySales: Math.round(todaySales * 100) / 100,
      todayCashSales: Math.round(todayCashSales * 100) / 100,
      weekSales: Math.round((Number(weekOrders._sum?.total) || 0) * 100) / 100,
      monthSales: Math.round((Number(monthOrders._sum?.total) || 0) * 100) / 100,
      unitsSold,
      avgTicket: Math.round(avgTicket * 100) / 100,
      activePromoters,
      totalPromoters,
      activeStores: storesWithSales.length,
      totalStores: allVenuesCount,
      approvedDeposits: Math.round(approvedDeposits * 100) / 100,
      categoryBreakdown,
    }
  }

  /**
   * Get store performance ranking for organization
   *
   * IMPORTANT: Date calculations use venue timezone to match business operating hours.
   */
  async getStorePerformance(
    orgId: string,
    limit: number = 10,
    timezone: string = 'America/Mexico_City',
    startDate?: string,
    endDate?: string,
  ): Promise<OrgStorePerformance[]> {
    // DB stores local time in `timestamp without time zone` — use venue helpers
    let todayStart: Date
    let rangeEnd: Date | undefined

    if (startDate || endDate) {
      const range = parseDbDateRange(startDate, endDate, timezone, 1)
      todayStart = range.from
      rangeEnd = range.to
    } else {
      todayStart = venueStartOfDay(timezone)
    }

    const weekStart = venueStartOfDayOffset(timezone, -7)
    const prevWeekStart = venueStartOfDayOffset(timezone, -14)

    const monthStart = venueStartOfMonth(timezone)

    // Get all venues
    const venues = await prisma.venue.findMany({
      where: { organizationId: orgId },
      select: {
        id: true,
        name: true,
        slug: true,
        logo: true,
        status: true,
        state: true,
      },
    })

    // Fetch SalesGoals from VenueModule config for all venues (batch query)
    const serializedModule = await prisma.module.findUnique({
      where: { code: 'SERIALIZED_INVENTORY' },
    })

    type GoalConfig = {
      goal: number
      goalType: 'AMOUNT' | 'QUANTITY'
      period: 'DAILY' | 'WEEKLY' | 'MONTHLY'
      goalId: string
      source: 'venue' | 'organization'
    }
    const venueGoalsMap = new Map<string, GoalConfig>()

    if (serializedModule) {
      const venueModules = await prisma.venueModule.findMany({
        where: {
          venueId: { in: venues.map(v => v.id) },
          moduleId: serializedModule.id,
        },
        select: { venueId: true, config: true },
      })

      for (const vm of venueModules) {
        const config = vm.config as Record<string, any> | null
        const goals = Array.isArray(config?.salesGoals) ? (config.salesGoals as any[]) : []
        // Find the active venue-wide goal (staffId = null)
        const venueGoal = goals.find(g => g.staffId === null && g.active)
        if (venueGoal && venueGoal.goal > 0) {
          venueGoalsMap.set(vm.venueId, {
            goal: venueGoal.goal,
            goalType: venueGoal.goalType || 'AMOUNT',
            period: venueGoal.period,
            goalId: venueGoal.id,
            source: 'venue',
          })
        }
      }
    }

    // Fallback: for venues without a goal, check org-level goals
    const venuesWithoutGoal = venues.filter(v => !venueGoalsMap.has(v.id))
    if (venuesWithoutGoal.length > 0) {
      const orgGoals = await prisma.organizationSalesGoalConfig.findMany({
        where: { organizationId: orgId, active: true },
      })
      // Use the first matching org goal (prefer DAILY for daily dashboards, but use any available)
      const orgGoal = orgGoals.find(g => g.period === 'DAILY') || orgGoals.find(g => g.period === 'MONTHLY') || orgGoals[0]
      if (orgGoal && orgGoal.goal.toNumber() > 0) {
        for (const venue of venuesWithoutGoal) {
          venueGoalsMap.set(venue.id, {
            goal: orgGoal.goal.toNumber(),
            goalType: (orgGoal.goalType as 'AMOUNT' | 'QUANTITY') || 'AMOUNT',
            period: (orgGoal.period as 'DAILY' | 'WEEKLY' | 'MONTHLY') || 'MONTHLY',
            goalId: orgGoal.id,
            source: 'organization',
          })
        }
      }
    }

    const venueIds = venues.map(v => v.id)

    if (venueIds.length === 0) {
      return []
    }

    // Determine which conditional queries we need based on goal configs
    const goalConfigs = [...venueGoalsMap.values()]
    const needsMonthSales = goalConfigs.some(g => g.period === 'MONTHLY' && g.goalType === 'AMOUNT')
    const needsWeekUnits = goalConfigs.some(g => g.period === 'WEEKLY' && g.goalType === 'QUANTITY')
    const needsMonthUnits = goalConfigs.some(g => g.period === 'MONTHLY' && g.goalType === 'QUANTITY')

    const todayCreatedAtWhere = rangeEnd ? { gte: todayStart, lte: rangeEnd } : { gte: todayStart }

    // Bulk queries — replaces N per-venue loops with a constant number of queries
    const [
      todaySalesByVenue,
      todayUnitsByVenue,
      weekSalesByVenue,
      prevWeekSalesByVenue,
      staffCountsByVenue,
      activePromoterEntries,
      monthSalesByVenue,
      weekUnitsByVenue,
      monthUnitsByVenue,
    ] = await Promise.all([
      // 1. Today sales per venue
      prisma.order.groupBy({
        by: ['venueId'],
        where: { venueId: { in: venueIds }, status: 'COMPLETED', createdAt: todayCreatedAtWhere },
        _sum: { total: true },
      }),
      // 2. Today units per venue (SUM quantity — OrderItem has no venueId, needs raw SQL)
      rangeEnd
        ? prisma.$queryRaw<Array<{ venueId: string; unitsSold: any }>>`
            SELECT o."venueId", COALESCE(SUM(oi.quantity), 0) as "unitsSold"
            FROM "Order" o
            JOIN "OrderItem" oi ON oi."orderId" = o.id
            WHERE o."venueId" IN (${Prisma.join(venueIds)})
              AND o.status = 'COMPLETED'
              AND o."createdAt" >= ${utcTs(todayStart)}
              AND o."createdAt" <= ${utcTs(rangeEnd)}
            GROUP BY o."venueId"
          `
        : prisma.$queryRaw<Array<{ venueId: string; unitsSold: any }>>`
            SELECT o."venueId", COALESCE(SUM(oi.quantity), 0) as "unitsSold"
            FROM "Order" o
            JOIN "OrderItem" oi ON oi."orderId" = o.id
            WHERE o."venueId" IN (${Prisma.join(venueIds)})
              AND o.status = 'COMPLETED'
              AND o."createdAt" >= ${utcTs(todayStart)}
            GROUP BY o."venueId"
          `,
      // 3. Week sales per venue
      prisma.order.groupBy({
        by: ['venueId'],
        where: { venueId: { in: venueIds }, status: 'COMPLETED', createdAt: { gte: weekStart } },
        _sum: { total: true },
      }),
      // 4. Previous week sales per venue (for trend calculation)
      prisma.order.groupBy({
        by: ['venueId'],
        where: { venueId: { in: venueIds }, status: 'COMPLETED', createdAt: { gte: prevWeekStart, lt: weekStart } },
        _sum: { total: true },
      }),
      // 5. Staff counts per venue
      prisma.staffVenue.groupBy({
        by: ['venueId'],
        where: { venueId: { in: venueIds }, active: true, role: { in: ['CASHIER', 'WAITER'] } },
        _count: true,
      }),
      // 6. Active promoters per venue (distinct staff with a check-in — counted in Postgres)
      activeStaffByVenue(venueIds, todayStart, rangeEnd),
      // 7. Month sales per venue (conditional — only if MONTHLY AMOUNT goals exist)
      needsMonthSales
        ? prisma.order.groupBy({
            by: ['venueId'],
            where: { venueId: { in: venueIds }, status: 'COMPLETED', createdAt: { gte: monthStart } },
            _sum: { total: true },
          })
        : Promise.resolve([] as any[]),
      // 8. Week units per venue (conditional — only if QUANTITY WEEKLY goals exist)
      needsWeekUnits
        ? prisma.$queryRaw<Array<{ venueId: string; units: any }>>`
            SELECT o."venueId", COALESCE(SUM(oi.quantity), 0) as units
            FROM "Order" o
            JOIN "OrderItem" oi ON oi."orderId" = o.id
            WHERE o."venueId" IN (${Prisma.join(venueIds)})
              AND o.status = 'COMPLETED'
              AND o."createdAt" >= ${utcTs(weekStart)}
            GROUP BY o."venueId"
          `
        : Promise.resolve([] as any[]),
      // 9. Month units per venue (conditional — only if QUANTITY MONTHLY goals exist)
      needsMonthUnits
        ? prisma.$queryRaw<Array<{ venueId: string; units: any }>>`
            SELECT o."venueId", COALESCE(SUM(oi.quantity), 0) as units
            FROM "Order" o
            JOIN "OrderItem" oi ON oi."orderId" = o.id
            WHERE o."venueId" IN (${Prisma.join(venueIds)})
              AND o.status = 'COMPLETED'
              AND o."createdAt" >= ${utcTs(monthStart)}
            GROUP BY o."venueId"
          `
        : Promise.resolve([] as any[]),
    ])

    // Build lookup maps for O(1) access
    const todaySalesMap = new Map(todaySalesByVenue.map(r => [r.venueId, Number(r._sum.total) || 0]))
    const todayUnitsMap = new Map(todayUnitsByVenue.map((r: any) => [r.venueId, Number(r.unitsSold)]))
    const weekSalesMap = new Map(weekSalesByVenue.map(r => [r.venueId, Number(r._sum.total) || 0]))
    const prevWeekSalesMap = new Map(prevWeekSalesByVenue.map(r => [r.venueId, Number(r._sum.total) || 0]))
    const staffCountsMap = new Map(staffCountsByVenue.map(r => [r.venueId, r._count]))
    const monthSalesMap = new Map((monthSalesByVenue as any[]).map(r => [r.venueId, Number(r._sum?.total) || 0]))
    const weekUnitsMap = new Map((weekUnitsByVenue as any[]).map(r => [r.venueId, Number(r.units)]))
    const monthUnitsMap = new Map((monthUnitsByVenue as any[]).map(r => [r.venueId, Number(r.units)]))

    const activePromotersMap = activePromoterEntries

    // Map venues to results — no DB calls in this loop
    const results: OrgStorePerformance[] = venues.map(venue => {
      const goalConfig = venueGoalsMap.get(venue.id)
      const todaySales = todaySalesMap.get(venue.id) || 0
      const unitsSold = todayUnitsMap.get(venue.id) || 0
      const weekSales = weekSalesMap.get(venue.id) || 0
      const prevWeekSales = prevWeekSalesMap.get(venue.id) || 0

      // Determine trend
      let trend: 'up' | 'down' | 'stable' = 'stable'
      if (prevWeekSales > 0) {
        const change = ((weekSales - prevWeekSales) / prevWeekSales) * 100
        if (change > 10) trend = 'up'
        else if (change < -10) trend = 'down'
      }

      // Calculate goal performance
      let performance: number | undefined
      if (goalConfig && goalConfig.goal > 0) {
        let progressValue = 0

        if (goalConfig.goalType === 'QUANTITY') {
          switch (goalConfig.period) {
            case 'DAILY':
              progressValue = unitsSold
              break
            case 'WEEKLY':
              progressValue = weekUnitsMap.get(venue.id) || 0
              break
            case 'MONTHLY':
              progressValue = monthUnitsMap.get(venue.id) || 0
              break
          }
        } else {
          switch (goalConfig.period) {
            case 'DAILY':
              progressValue = todaySales
              break
            case 'WEEKLY':
              progressValue = weekSales
              break
            case 'MONTHLY':
              progressValue = monthSalesMap.get(venue.id) || 0
              break
          }
        }
        performance = Math.round((progressValue / goalConfig.goal) * 100)
      }

      return {
        id: venue.id,
        name: venue.name,
        slug: venue.slug,
        logo: venue.logo,
        todaySales: Math.round(todaySales * 100) / 100,
        weekSales: Math.round(weekSales * 100) / 100,
        unitsSold,
        promoterCount: staffCountsMap.get(venue.id) || 0,
        activePromoters: activePromotersMap.get(venue.id) || 0,
        trend,
        rank: 0, // Will be set after sorting
        performance,
        goalAmount: goalConfig?.goal,
        goalType: goalConfig?.goalType,
        goalPeriod: goalConfig?.period,
        goalId: goalConfig?.goalId,
        goalSource: goalConfig?.source,
      }
    })

    // Sort by week sales and assign ranks
    results.sort((a, b) => b.weekSales - a.weekSales)
    results.forEach((r, i) => (r.rank = i + 1))

    return results.slice(0, limit)
  }

  /**
   * Get cross-store anomalies for organization
   *
   * IMPORTANT: Uses venue timezone for date calculations.
   */
  async getCrossStoreAnomalies(orgId: string, timezone: string = DEFAULT_TIMEZONE): Promise<OrgCrossStoreAnomaly[]> {
    // DB stores local time — use venue helpers
    const now = new Date()
    const nowInTz = toZonedTime(now, timezone)
    const todayStart = venueStartOfDay(timezone)

    const anomalies: OrgCrossStoreAnomaly[] = []

    // Get all venues
    const venues = await prisma.venue.findMany({
      where: { organizationId: orgId, status: 'ACTIVE' },
      select: { id: true, name: true, latitude: true, longitude: true, settings: { select: { geofenceRadiusMeters: true } } },
    })

    const venueIds = venues.map(v => v.id)
    const venuesWithGps = venues.filter(v => v.latitude && v.longitude)
    const venuesWithGpsIds = venuesWithGps.map(v => v.id)

    // Fetch org attendance config for geofence fallback
    const orgAttendanceConfig = await prisma.organizationAttendanceConfig.findUnique({
      where: { organizationId: orgId },
    })

    // 5 bulk queries replace all per-venue queries
    const [checkInsByVenue, pendingDepositsByVenue, allAlertConfigs, stockLevelsByVenueCategory, gpsEntries] = await Promise.all([
      // 1. Check-in counts per venue
      prisma.timeEntry.groupBy({
        by: ['venueId'],
        where: { venueId: { in: venueIds }, clockInTime: { gte: todayStart } },
        _count: true,
      }),
      // 2. Pending deposits per venue
      prisma.cashDeposit.groupBy({
        by: ['venueId'],
        where: { venueId: { in: venueIds }, status: 'PENDING' },
        _count: true,
      }),
      // 3. All stock alert configs across venues (replaces count + findMany per venue)
      prisma.stockAlertConfig.findMany({
        where: { venueId: { in: venueIds }, alertEnabled: true },
        include: { category: true },
      }),
      // 4. Available stock per venue+category (replaces N×serializedItem.count)
      prisma.serializedItem.groupBy({
        by: ['venueId', 'categoryId'],
        where: { venueId: { in: venueIds }, status: 'AVAILABLE' },
        _count: true,
      }),
      // 5. GPS entries for venues with coordinates
      venuesWithGpsIds.length > 0
        ? prisma.timeEntry.findMany({
            where: {
              venueId: { in: venuesWithGpsIds },
              clockInTime: { gte: todayStart },
              clockInLatitude: { not: null },
              clockInLongitude: { not: null },
            },
            // Select quirúrgico: sólo lo que usa el cálculo de distancia (antes: la
            // checada entera, con fotos y notas, por cada check-in del día).
            select: {
              id: true,
              venueId: true,
              clockInLatitude: true,
              clockInLongitude: true,
              staff: { select: { firstName: true, lastName: true } },
            },
          })
        : Promise.resolve([] as any[]),
    ])

    // Build lookup maps
    const checkInsMap = new Map(checkInsByVenue.map(r => [r.venueId, r._count]))
    const depositsMap = new Map(pendingDepositsByVenue.map(r => [r.venueId, r._count]))

    // Group alert configs by venueId
    const alertConfigsByVenue = new Map<string, typeof allAlertConfigs>()
    for (const config of allAlertConfigs) {
      const list = alertConfigsByVenue.get(config.venueId) || []
      list.push(config)
      alertConfigsByVenue.set(config.venueId, list)
    }

    // Stock levels map: "venueId:categoryId" → count
    const stockMap = new Map(stockLevelsByVenueCategory.map(r => [`${r.venueId}:${r.categoryId}`, r._count]))

    // Process anomalies from bulk data — no DB calls in this loop
    const currentHour = nowInTz.getHours()

    for (const venue of venues) {
      // 1. No check-ins after 10 AM
      if (currentHour >= 10) {
        const checkIns = checkInsMap.get(venue.id) || 0
        if (checkIns === 0) {
          anomalies.push({
            id: `no-checkins-${venue.id}`,
            type: 'NO_CHECKINS',
            severity: 'CRITICAL',
            storeId: venue.id,
            storeName: venue.name,
            title: 'Sin Check-ins',
            description: `${venue.name} no tiene registros de entrada hoy`,
          })
        }
      }

      // 2. Pending deposits
      const pendingCount = depositsMap.get(venue.id) || 0
      if (pendingCount > 5) {
        anomalies.push({
          id: `pending-deposits-${venue.id}`,
          type: 'PENDING_DEPOSITS',
          severity: pendingCount > 10 ? 'CRITICAL' : 'WARNING',
          storeId: venue.id,
          storeName: venue.name,
          title: 'Depósitos Pendientes',
          description: `${venue.name} tiene ${pendingCount} depósitos pendientes`,
        })
      }

      // 3. Low stock alerts
      const configs = alertConfigsByVenue.get(venue.id) || []
      for (const config of configs) {
        const available = stockMap.get(`${venue.id}:${config.categoryId}`) || 0
        if (available <= config.minimumStock) {
          anomalies.push({
            id: `low-stock-${venue.id}-${config.categoryId}`,
            type: 'LOW_STOCK',
            severity: available === 0 ? 'CRITICAL' : 'WARNING',
            storeId: venue.id,
            storeName: venue.name,
            title: 'Stock Bajo',
            description: `${venue.name}: ${config.category.name} tiene ${available} unidades`,
          })
        }
      }
    }

    // 4. GPS violations (process from bulk gpsEntries)
    const venueGpsMap = new Map(venuesWithGps.map(v => [v.id, v]))
    for (const entry of gpsEntries) {
      const venue = venueGpsMap.get(entry.venueId)
      if (!venue || !entry.clockInLatitude || !entry.clockInLongitude) continue

      const distance = this.calculateDistance(
        Number(venue.latitude),
        Number(venue.longitude),
        Number(entry.clockInLatitude),
        Number(entry.clockInLongitude),
      )

      // Resolve geofence: venue config > org config > 500m default
      const radiusKm = ((venue as any).settings?.geofenceRadiusMeters ?? orgAttendanceConfig?.geofenceRadiusMeters ?? 500) / 1000

      if (distance > radiusKm) {
        anomalies.push({
          id: `gps-violation-${entry.id}`,
          type: 'GPS_VIOLATION',
          severity: distance > radiusKm * 2 ? 'CRITICAL' : 'WARNING',
          storeId: venue.id,
          storeName: venue.name,
          title: 'Violación GPS',
          description: `${entry.staff.firstName} ${entry.staff.lastName} hizo check-in ${distance.toFixed(1)}km fuera del rango en ${venue.name}`,
        })
      }
    }

    // Sort by severity
    anomalies.sort((a, b) => {
      const severityOrder = { CRITICAL: 0, WARNING: 1, INFO: 2 }
      return severityOrder[a.severity] - severityOrder[b.severity]
    })

    return anomalies
  }

  /**
   * Calculate distance between two GPS coordinates using Haversine formula
   * @returns distance in kilometers
   */
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371 // Earth's radius in kilometers
    const dLat = this.toRadians(lat2 - lat1)
    const dLon = this.toRadians(lon2 - lon1)

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2)

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    return R * c
  }

  /**
   * Convert degrees to radians
   */
  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180)
  }

  /**
   * Get manager dashboard with stores they oversee
   *
   * IMPORTANT: Uses venue timezone for date calculations.
   */
  async getManagerDashboard(orgId: string, managerId: string, timezone: string = DEFAULT_TIMEZONE): Promise<ManagerDashboard | null> {
    // DB stores local time — use venue helpers
    const todayStart = venueStartOfDay(timezone)
    const weekStart = venueStartOfDayOffset(timezone, -7)

    // Get manager info
    const manager = await prisma.staff.findFirst({
      where: {
        id: managerId,
        organizations: { some: { organizationId: orgId } },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
      },
    })

    if (!manager) {
      return null
    }

    // Get stores managed by this manager (ADMIN or MANAGER role)
    // Sólo las tiendas de ESTA org: un gerente que también gestiona tiendas en otra org no las
    // trae al dashboard de ésta (IDOR cross-tenant, 2026-09-01).
    const managedStores = await prisma.staffVenue.findMany({
      where: {
        staffId: managerId,
        role: { in: ['ADMIN', 'MANAGER'] },
        active: true,
        venue: { organizationId: orgId },
      },
      include: {
        venue: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    })

    const monthStart = venueStartOfMonth(timezone)
    const allVenueIds = managedStores.map(sv => sv.venueId)

    // 5 bulk queries instead of 5N (avoids N+1 per store)
    const [todayByVenue, weekByVenue, promotersByVenue, activeEntries, goals] = await Promise.all([
      prisma.order.groupBy({
        by: ['venueId'],
        where: { venueId: { in: allVenueIds }, status: 'COMPLETED', createdAt: { gte: todayStart } },
        _sum: { total: true },
      }),
      prisma.order.groupBy({
        by: ['venueId'],
        where: { venueId: { in: allVenueIds }, status: 'COMPLETED', createdAt: { gte: weekStart } },
        _sum: { total: true },
      }),
      prisma.staffVenue.groupBy({
        by: ['venueId'],
        where: { venueId: { in: allVenueIds }, active: true, role: { in: ['CASHIER', 'WAITER'] } },
        _count: true,
      }),
      activeStaffByVenue(allVenueIds, todayStart),
      prisma.performanceGoal.findMany({
        where: { staffId: managerId, venueId: { in: allVenueIds }, month: monthStart },
      }),
    ])

    const todayMap = new Map(todayByVenue.map(o => [o.venueId, Number(o._sum.total) || 0]))
    const weekMap = new Map(weekByVenue.map(o => [o.venueId, Number(o._sum.total) || 0]))
    const promoterMap = new Map(promotersByVenue.map(p => [p.venueId, p._count]))
    const goalMap = new Map(goals.map(g => [g.venueId, g]))

    const activeByVenue = activeEntries

    const stores = managedStores.map(sv => {
      const todaySales = todayMap.get(sv.venueId) || 0
      const weekSales = weekMap.get(sv.venueId) || 0
      const goal = goalMap.get(sv.venueId)
      const monthGoal = goal ? Number(goal.salesGoal) : 50000

      const dayOfMonth = new Date().getDate()
      const estimatedMonthSales = (weekSales / 7) * dayOfMonth
      const goalProgress = monthGoal > 0 ? (estimatedMonthSales / monthGoal) * 100 : 0

      return {
        id: sv.venue.id,
        name: sv.venue.name,
        slug: sv.venue.slug,
        todaySales: Math.round(todaySales * 100) / 100,
        weekSales: Math.round(weekSales * 100) / 100,
        promoterCount: promoterMap.get(sv.venueId) || 0,
        activePromoters: activeByVenue.get(sv.venueId) || 0,
        monthGoal: Math.round(monthGoal * 100) / 100,
        goalProgress: Math.round(goalProgress),
      }
    })

    // Calculate aggregate metrics
    const aggregateMetrics = {
      totalSales: Math.round(stores.reduce((sum, s) => sum + s.todaySales, 0) * 100) / 100,
      totalUnits: 0, // Would need more detailed calculation
      avgGoalProgress: stores.length > 0 ? Math.round(stores.reduce((sum, s) => sum + s.goalProgress, 0) / stores.length) : 0,
      promotersActive: stores.reduce((sum, s) => sum + s.activePromoters, 0),
      promotersTotal: stores.reduce((sum, s) => sum + s.promoterCount, 0),
    }

    return {
      manager: {
        id: manager.id,
        name: `${manager.firstName} ${manager.lastName}`.trim(),
        email: manager.email,
        phone: manager.phone,
      },
      stores,
      aggregateMetrics,
    }
  }

  /**
   * Get organization-wide stock summary
   */
  async getOrgStockSummary(orgId: string): Promise<OrgStockSummary> {
    // Get all venues
    const venues = await prisma.venue.findMany({
      where: { organizationId: orgId, status: 'ACTIVE' },
      select: { id: true, name: true },
    })

    const venueIds = venues.map(v => v.id)

    // Single groupBy query gives us counts per venue+category (replaces all nested loops)
    const [countsByVenueCategory, categories, alertConfigs] = await Promise.all([
      prisma.serializedItem.groupBy({
        by: ['venueId', 'categoryId'],
        where: {
          venueId: { in: venueIds },
          status: 'AVAILABLE',
        },
        _count: true,
      }),
      prisma.itemCategory.findMany({
        where: { venueId: { in: venueIds }, active: true },
        select: { id: true, venueId: true, suggestedPrice: true },
      }),
      prisma.stockAlertConfig.findMany({
        where: { venueId: { in: venueIds }, alertEnabled: true },
      }),
    ])

    // Build lookup: "venueId:categoryId" → count
    const countMap = new Map<string, number>()
    let totalPieces = 0
    const venueCountMap = new Map<string, number>()

    for (const row of countsByVenueCategory) {
      const vid = row.venueId // always non-null here (filtered by venueId IN)
      if (!vid) continue
      const key = `${vid}:${row.categoryId}`
      countMap.set(key, row._count)
      totalPieces += row._count
      venueCountMap.set(vid, (venueCountMap.get(vid) || 0) + row._count)
    }

    // Calculate total value using pre-fetched counts
    let totalValue = 0
    for (const cat of categories) {
      if (cat.suggestedPrice) {
        const count = countMap.get(`${cat.venueId}:${cat.id}`) || 0
        totalValue += count * Number(cat.suggestedPrice)
      }
    }

    // Calculate alert counts using pre-fetched counts
    let lowStockAlerts = 0
    let criticalAlerts = 0

    for (const config of alertConfigs) {
      const available = countMap.get(`${config.venueId}:${config.categoryId}`) || 0
      if (available <= config.minimumStock) {
        lowStockAlerts++
        if (available === 0) criticalAlerts++
      }
    }

    // Build store breakdown using pre-fetched counts (no additional queries)
    const storeBreakdown = venues.map(venue => {
      const available = venueCountMap.get(venue.id) || 0

      // Calculate value for this store
      const storeCats = categories.filter(c => c.venueId === venue.id)
      let storeValue = 0
      for (const cat of storeCats) {
        if (cat.suggestedPrice) {
          const count = countMap.get(`${cat.venueId}:${cat.id}`) || 0
          storeValue += count * Number(cat.suggestedPrice)
        }
      }

      // Check alert level using pre-fetched counts
      const storeAlerts = alertConfigs.filter(a => a.venueId === venue.id)
      let alertLevel: 'OK' | 'WARNING' | 'CRITICAL' = 'OK'

      for (const config of storeAlerts) {
        const catAvailable = countMap.get(`${venue.id}:${config.categoryId}`) || 0
        if (catAvailable === 0) {
          alertLevel = 'CRITICAL'
          break
        } else if (catAvailable <= config.minimumStock) {
          alertLevel = 'WARNING'
        }
      }

      return {
        storeId: venue.id,
        storeName: venue.name,
        available,
        value: Math.round(storeValue * 100) / 100,
        alertLevel,
      }
    })

    return {
      totalPieces,
      totalValue: Math.round(totalValue * 100) / 100,
      lowStockAlerts,
      criticalAlerts,
      storeBreakdown,
    }
  }

  /**
   * Get online staff (promoters with active TimeEntry today)
   *
   * "Hoy" es el día civil del venue (medianoche en `timezone`), no el del host: en
   * producción (UTC) la medianoche del host son las 18:00 de AYER en México.
   */
  async getOnlineStaff(orgId: string, timezone: string = DEFAULT_TIMEZONE): Promise<OrgOnlineStaff> {
    const todayStart = venueStartOfDay(timezone)

    // Get all venues in organization
    const venues = await prisma.venue.findMany({
      where: { organizationId: orgId, status: 'ACTIVE' },
      select: { id: true, name: true },
    })
    const venueIds = venues.map(v => v.id)

    if (venueIds.length === 0) {
      return {
        onlineCount: 0,
        totalCount: 0,
        percentageOnline: 0,
        byVenue: [],
        onlineStaff: [],
      }
    }

    // Get all active TimeEntry records for today (clockIn without clockOut)
    const activeTimeEntries = await prisma.timeEntry.findMany({
      where: {
        venueId: { in: venueIds },
        clockInTime: { gte: todayStart },
        clockOutTime: null, // Only entries that haven't clocked out
      },
      // Select quirúrgico: "quién está dentro" sólo necesita esto (antes: la checada
      // entera, con fotos, GPS y notas, por cada persona en línea).
      select: {
        staffId: true,
        venueId: true,
        clockInTime: true,
        jobRole: true,
        staff: { select: { firstName: true, lastName: true } },
        venue: { select: { name: true } },
      },
      orderBy: {
        clockInTime: 'desc',
      },
    })

    // Get total staff count (CASHIER and WAITER roles)
    const totalStaff = await prisma.staffVenue.count({
      where: {
        venueId: { in: venueIds },
        active: true,
        role: { in: ['CASHIER', 'WAITER'] },
      },
    })

    // Build online staff list
    const onlineStaff: OnlineStaffMember[] = activeTimeEntries.map(entry => ({
      staffId: entry.staffId,
      staffName: `${entry.staff.firstName} ${entry.staff.lastName}`.trim(),
      venueId: entry.venueId,
      venueName: entry.venue.name,
      clockInTime: entry.clockInTime,
      role: entry.jobRole || 'Staff',
    }))

    // Bulk query: staff counts per venue (replaces N individual count queries)
    const staffCountsByVenue = await prisma.staffVenue.groupBy({
      by: ['venueId'],
      where: { venueId: { in: venueIds }, active: true, role: { in: ['CASHIER', 'WAITER'] } },
      _count: true,
    })
    const staffCountsMap = new Map(staffCountsByVenue.map(r => [r.venueId, r._count]))

    // Pre-build online counts per venue from in-memory data
    const onlineCountsByVenue = new Map<string, number>()
    for (const entry of activeTimeEntries) {
      onlineCountsByVenue.set(entry.venueId, (onlineCountsByVenue.get(entry.venueId) || 0) + 1)
    }

    const byVenue = venues.map(venue => ({
      venueId: venue.id,
      venueName: venue.name,
      onlineCount: onlineCountsByVenue.get(venue.id) || 0,
      totalCount: staffCountsMap.get(venue.id) || 0,
    }))

    return {
      onlineCount: activeTimeEntries.length,
      totalCount: totalStaff,
      percentageOnline: totalStaff > 0 ? Math.round((activeTimeEntries.length / totalStaff) * 100) : 0,
      byVenue,
      onlineStaff,
    }
  }

  /**
   * Get organization-wide activity feed
   *
   * Aggregates events from multiple sources:
   * - Sales (Order table)
   * - Check-ins (TimeEntry table)
   * - System alerts
   *
   * @param orgId - Organization ID
   * @param limit - Max events to return (default 50)
   */
  async getActivityFeed(
    orgId: string,
    limit: number = 50,
    startDate?: string,
    endDate?: string,
    filterVenueId?: string,
    scopedVenueIds?: string[],
  ): Promise<OrgActivityFeed> {
    let rangeStart: Date
    let rangeEnd: Date | undefined

    if (startDate || endDate) {
      const range = parseDbDateRange(startDate, endDate)
      rangeStart = range.from
      rangeEnd = range.to
    } else {
      // Default: today in venue timezone
      rangeStart = venueStartOfDay()
    }

    // Get venues (filtered or all). An explicit empty scopedVenueIds array means
    // the caller has no active venue assignments and must receive no events.
    const venueIdFilter = scopedVenueIds !== undefined ? { in: scopedVenueIds } : filterVenueId
    const venues = await prisma.venue.findMany({
      where: {
        organizationId: orgId,
        status: 'ACTIVE',
        ...(venueIdFilter !== undefined ? { id: venueIdFilter } : {}),
      },
      select: { id: true, name: true },
    })
    const venueIds = venues.map(v => v.id)

    if (venueIds.length === 0) {
      return { events: [], total: 0 }
    }

    const events: ActivityEvent[] = []
    const timeFilter = rangeEnd ? { gte: rangeStart, lte: rangeEnd } : { gte: rangeStart }

    // Fetch recent sales (completed orders in range)
    // Include items → serializedItem → category to get ICCID and category name
    const recentOrders = await prisma.order.findMany({
      where: {
        venueId: { in: venueIds },
        status: 'COMPLETED',
        createdAt: timeFilter,
      },
      include: {
        venue: { select: { id: true, name: true } },
        servedBy: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
        items: {
          take: 1,
          include: {
            serializedItem: {
              select: { serialNumber: true, category: { select: { name: true, color: true } } },
            },
          },
        },
        payments: {
          take: 1,
          orderBy: { createdAt: 'desc' as const },
          select: {
            method: true,
            cardBrand: true,
            saleVerification: { select: { photos: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit, // Fetch up to full limit for sales
    })

    for (const order of recentOrders) {
      const firstItem = order.items?.[0]
      const categoryName = firstItem?.serializedItem?.category?.name || firstItem?.categoryName || undefined
      const categoryColor = firstItem?.serializedItem?.category?.color || undefined
      const iccid = firstItem?.serializedItem?.serialNumber || undefined

      const firstPayment = order.payments?.[0]
      const photos = firstPayment?.saleVerification?.photos ?? []

      events.push({
        id: `sale-${order.id}`,
        type: 'sale',
        title: `Venta: ${order.total ? `$${Number(order.total).toFixed(2)}` : 'Sin monto'}`,
        subtitle: `${order.servedBy ? `${order.servedBy.firstName} ${order.servedBy.lastName}` : 'Staff desconocido'} • ${order.venue.name}`,
        timestamp: order.createdAt,
        severity: 'normal',
        venueId: order.venueId,
        venueName: order.venue.name,
        staffId: order.servedById || undefined,
        staffName: order.servedBy ? `${order.servedBy.firstName} ${order.servedBy.lastName}` : undefined,
        staffEmployeeCode: order.servedBy?.employeeCode ?? null,
        metadata: {
          orderId: order.id,
          total: order.total ? Number(order.total) : 0,
          categoryName,
          categoryColor,
          iccid,
          paymentMethod: firstPayment?.method || undefined,
          cardBrand: firstPayment?.cardBrand || undefined,
          tags: order.tags?.length ? order.tags : undefined,
          photos: photos.length ? photos : undefined,
        },
      })
    }

    // Fetch recent check-ins and checkouts (TimeEntry in range)
    const recentTimeEntries = await prisma.timeEntry.findMany({
      where: {
        venueId: { in: venueIds },
        clockInTime: timeFilter,
      },
      include: {
        venue: { select: { id: true, name: true } },
        staff: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
      },
      orderBy: { clockInTime: 'desc' },
      take: limit, // Fetch up to full limit for time entries
    })

    for (const entry of recentTimeEntries) {
      // Add check-in event
      events.push({
        id: `checkin-${entry.id}`,
        type: 'checkin',
        title: `Check-in: ${entry.staff.firstName} ${entry.staff.lastName}`,
        subtitle: `${entry.jobRole || 'CASHIER'} • ${entry.venue.name}`,
        timestamp: entry.clockInTime,
        severity: 'normal',
        venueId: entry.venueId,
        venueName: entry.venue.name,
        staffId: entry.staffId,
        staffName: `${entry.staff.firstName} ${entry.staff.lastName}`,
        staffEmployeeCode: entry.staff.employeeCode ?? null,
        metadata: {
          timeEntryId: entry.id,
          role: entry.jobRole,
        },
      })

      // Add checkout event if it exists
      if (entry.clockOutTime) {
        events.push({
          id: `checkout-${entry.id}`,
          type: 'checkout',
          title: `Check-out: ${entry.staff.firstName} ${entry.staff.lastName}`,
          subtitle: `${entry.jobRole || 'CASHIER'} • ${entry.venue.name}`,
          timestamp: entry.clockOutTime,
          severity: 'normal',
          venueId: entry.venueId,
          venueName: entry.venue.name,
          staffId: entry.staffId,
          staffName: `${entry.staff.firstName} ${entry.staff.lastName}`,
          staffEmployeeCode: entry.staff.employeeCode ?? null,
          metadata: {
            timeEntryId: entry.id,
            role: entry.jobRole,
          },
        })
      }
    }

    // Sort all events by timestamp descending
    events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

    // Limit to requested size
    const limitedEvents = events.slice(0, limit)

    return {
      events: limitedEvents,
      total: events.length,
    }
  }

  /**
   * Get or create daily goals for current week
   */
  async getOrCreateWeeklyGoals(orgId: string): Promise<OrganizationGoalData[]> {
    // Use venue timezone for date calculations
    // Default to Mexico City if organization doesn't have timezone set
    const timezone = 'America/Mexico_City' // TODO: Get from organization settings

    const today = new Date()
    // Get current time in venue timezone
    const nowVenue = toZonedTime(today, timezone)

    // Calculate week start (Sunday) in venue timezone
    const weekStartVenue = new Date(nowVenue)
    weekStartVenue.setDate(nowVenue.getDate() - nowVenue.getDay()) // Sunday
    weekStartVenue.setHours(0, 0, 0, 0)

    // Convert back to UTC for database query
    const weekStart = fromZonedTime(weekStartVenue, timezone)

    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekStart.getDate() + 7)

    const monthStartVenue = new Date(weekStartVenue)
    monthStartVenue.setDate(1)
    monthStartVenue.setHours(0, 0, 0, 0)
    const monthStartUtc = new Date(Date.UTC(weekStartVenue.getFullYear(), weekStartVenue.getMonth(), 1))
    const monthEndUtc = new Date(Date.UTC(weekStartVenue.getFullYear(), weekStartVenue.getMonth() + 1, 1))
    const daysInMonth = new Date(monthStartVenue.getFullYear(), monthStartVenue.getMonth() + 1, 0).getDate()

    // Fetch all daily goals for the week in one query
    const existingGoals = await prisma.organizationGoal.findMany({
      where: {
        organizationId: orgId,
        period: 'daily',
        periodDate: {
          gte: weekStart,
          lt: weekEnd,
        },
      },
    })

    const weekStartUtc = new Date(Date.UTC(weekStartVenue.getFullYear(), weekStartVenue.getMonth(), weekStartVenue.getDate()))
    const weekEndUtc = new Date(weekStartUtc)
    weekEndUtc.setUTCDate(weekEndUtc.getUTCDate() + 7)

    const weeklyGoal = await prisma.organizationGoal.findFirst({
      where: {
        organizationId: orgId,
        period: 'weekly',
        periodDate: {
          gte: weekStartUtc,
          lt: weekEndUtc,
        },
      },
      orderBy: { periodDate: 'asc' },
    })

    const monthlyGoal = await prisma.organizationGoal.findFirst({
      where: {
        organizationId: orgId,
        period: 'monthly',
        periodDate: {
          gte: monthStartUtc,
          lt: monthEndUtc,
        },
      },
      orderBy: { periodDate: 'asc' },
    })

    const defaultSalesTarget = 19285.71
    const defaultVolumeTarget = 71

    const baseSalesTarget = weeklyGoal
      ? Number(weeklyGoal.salesTarget) / 7
      : monthlyGoal
        ? Number(monthlyGoal.salesTarget) / daysInMonth
        : defaultSalesTarget

    const baseVolumeTarget = weeklyGoal
      ? Math.round(weeklyGoal.volumeTarget / 7)
      : monthlyGoal
        ? Math.round(monthlyGoal.volumeTarget / daysInMonth)
        : defaultVolumeTarget

    const dailySalesTarget = Math.round(baseSalesTarget * 100) / 100

    const goals: OrganizationGoalData[] = []

    // Create/fetch goals for each day of the week
    for (let i = 0; i < 7; i++) {
      const dayDate = new Date(weekStart)
      dayDate.setUTCDate(weekStart.getUTCDate() + i)

      // Find existing goal by comparing date strings (avoids timezone issues)
      let goal = existingGoals.find(g => g.periodDate.toDateString() === dayDate.toDateString())

      const shouldNormalizeDailyGoal =
        !!goal &&
        (weeklyGoal || monthlyGoal) &&
        (Math.abs(Number(goal.salesTarget) - dailySalesTarget) > 0.01 || goal.volumeTarget !== baseVolumeTarget)

      if (!goal) {
        goal = await prisma.organizationGoal.create({
          data: {
            organizationId: orgId,
            period: 'daily',
            periodDate: dayDate,
            salesTarget: dailySalesTarget,
            volumeTarget: baseVolumeTarget,
          },
        })
      } else if (shouldNormalizeDailyGoal) {
        goal = await prisma.organizationGoal.update({
          where: { id: goal.id },
          data: {
            salesTarget: dailySalesTarget,
            volumeTarget: baseVolumeTarget,
          },
        })
      }

      goals.push({
        id: goal.id,
        organizationId: goal.organizationId,
        period: goal.period,
        periodDate: goal.periodDate,
        salesTarget: Number(goal.salesTarget),
        volumeTarget: goal.volumeTarget,
      })
    }

    return goals
  }

  /**
   * Get revenue vs target chart data for current week
   */
  async getRevenueVsTarget(
    orgId: string,
    venueId?: string,
  ): Promise<{ days: RevenueVsTargetData[]; weekTotal: { actual: number; target: number } }> {
    // IMPORTANT: Database timestamps are stored in UTC (timestamp without time zone treated as UTC)
    // We calculate dates in venue timezone, then convert to UTC for queries
    const timezone = 'America/Mexico_City' // TODO: Get from organization settings

    const today = new Date()
    const nowVenue = toZonedTime(today, timezone)

    // Calculate week start (Sunday) in venue timezone
    const weekStartVenue = new Date(nowVenue)
    weekStartVenue.setDate(nowVenue.getDate() - nowVenue.getDay()) // Sunday
    weekStartVenue.setHours(0, 0, 0, 0)

    // Convert to UTC for database query (timestamps in DB are UTC)
    const _weekStart = fromZonedTime(weekStartVenue, timezone)

    // Get venues
    const venues = await prisma.venue.findMany({
      where: {
        organizationId: orgId,
        status: 'ACTIVE',
        ...(venueId ? { id: venueId } : {}),
      },
      select: { id: true },
    })
    const venueIds = venues.map(v => v.id)

    // Get goals for the week
    const goals = await this.getOrCreateWeeklyGoals(orgId)

    const days: RevenueVsTargetData[] = []
    const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']
    let totalActual = 0
    let totalTarget = 0

    for (let i = 0; i < 7; i++) {
      // Calculate each day in venue timezone
      const dayStartVenue = new Date(weekStartVenue)
      dayStartVenue.setDate(weekStartVenue.getDate() + i)

      const dayEndVenue = new Date(dayStartVenue)
      dayEndVenue.setDate(dayStartVenue.getDate() + 1)

      // Convert to UTC for database query (timestamps in DB are UTC)
      const dayStart = fromZonedTime(dayStartVenue, timezone)
      const dayEnd = fromZonedTime(dayEndVenue, timezone)

      // Get actual revenue for this day
      const orders = await prisma.order.aggregate({
        where: {
          venueId: { in: venueIds },
          status: 'COMPLETED',
          createdAt: { gte: dayStart, lt: dayEnd },
        },
        _sum: { total: true },
      })

      const goal = goals.find(g => g.periodDate.toDateString() === dayStart.toDateString())
      const actual = Math.round((Number(orders._sum?.total) || 0) * 100) / 100
      const target = goal ? goal.salesTarget : 0

      totalActual += actual
      totalTarget += target

      days.push({
        day: dayNames[i],
        actual: actual,
        target: target,
        date: dayStart.toISOString(),
      })
    }

    return {
      days,
      weekTotal: {
        actual: Math.round(totalActual * 100) / 100,
        target: Math.round(totalTarget * 100) / 100,
      },
    }
  }

  /**
   * Get volume vs target chart data for current week
   */
  async getVolumeVsTarget(
    orgId: string,
    venueId?: string,
  ): Promise<{ days: VolumeVsTargetData[]; weekTotal: { actual: number; target: number } }> {
    // IMPORTANT: Database timestamps are stored in UTC (timestamp without time zone treated as UTC)
    // We calculate dates in venue timezone, then convert to UTC for queries
    const timezone = 'America/Mexico_City' // TODO: Get from organization settings

    const today = new Date()
    const nowVenue = toZonedTime(today, timezone)

    // Calculate week start (Sunday) in venue timezone
    const weekStartVenue = new Date(nowVenue)
    weekStartVenue.setDate(nowVenue.getDate() - nowVenue.getDay()) // Sunday
    weekStartVenue.setHours(0, 0, 0, 0)

    // Convert to UTC for database query (timestamps in DB are UTC)
    const _weekStart = fromZonedTime(weekStartVenue, timezone)

    // Get venues
    const venues = await prisma.venue.findMany({
      where: {
        organizationId: orgId,
        status: 'ACTIVE',
        ...(venueId ? { id: venueId } : {}),
      },
      select: { id: true },
    })
    const venueIds = venues.map(v => v.id)

    // Get goals for the week
    const goals = await this.getOrCreateWeeklyGoals(orgId)

    const days: VolumeVsTargetData[] = []
    const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']
    let totalActual = 0
    let totalTarget = 0

    for (let i = 0; i < 7; i++) {
      // Calculate each day in venue timezone
      const dayStartVenue = new Date(weekStartVenue)
      dayStartVenue.setDate(weekStartVenue.getDate() + i)

      const dayEndVenue = new Date(dayStartVenue)
      dayEndVenue.setDate(dayStartVenue.getDate() + 1)

      // Convert to UTC for database query (timestamps in DB are UTC)
      const dayStart = fromZonedTime(dayStartVenue, timezone)
      const dayEnd = fromZonedTime(dayEndVenue, timezone)

      // Get actual order count for this day
      const orderCount = await prisma.order.count({
        where: {
          venueId: { in: venueIds },
          status: 'COMPLETED',
          createdAt: { gte: dayStart, lt: dayEnd },
        },
      })

      const goal = goals.find(g => g.periodDate.toDateString() === dayStart.toDateString())
      const target = goal ? goal.volumeTarget : 0

      totalActual += orderCount
      totalTarget += target

      days.push({
        day: dayNames[i],
        actual: orderCount,
        target: target,
        date: dayStart.toISOString(),
      })
    }

    return {
      days,
      weekTotal: {
        actual: totalActual,
        target: totalTarget,
      },
    }
  }

  /**
   * Update goals for a specific period
   */
  async updateOrganizationGoal(
    orgId: string,
    period: string,
    periodDate: Date,
    salesTarget: number,
    volumeTarget: number,
  ): Promise<OrganizationGoalData> {
    const goal = await prisma.organizationGoal.upsert({
      where: {
        organizationId_period_periodDate: {
          organizationId: orgId,
          period,
          periodDate,
        },
      },
      update: {
        salesTarget,
        volumeTarget,
      },
      create: {
        organizationId: orgId,
        period,
        periodDate,
        salesTarget,
        volumeTarget,
      },
    })

    logAction({
      action: 'ORG_GOAL_UPDATED',
      entity: 'OrganizationGoal',
      entityId: goal.id,
      data: { period, salesTarget, volumeTarget },
    })

    return {
      id: goal.id,
      organizationId: goal.organizationId,
      period: goal.period,
      periodDate: goal.periodDate,
      salesTarget: Number(goal.salesTarget),
      volumeTarget: goal.volumeTarget,
    }
  }

  /**
   * Get list of managers in organization ("ventas de hoy" = día civil del venue)
   */
  async getOrgManagers(
    orgId: string,
    timezone: string = DEFAULT_TIMEZONE,
  ): Promise<
    Array<{
      id: string
      name: string
      email: string | null
      storeCount: number
      activeStores: number
      todaySales: number
    }>
  > {
    const todayStart = venueStartOfDay(timezone)

    // Get all staff with ADMIN or MANAGER role in any venue
    const managers = await prisma.staffVenue.findMany({
      where: {
        venue: { organizationId: orgId },
        role: { in: ['ADMIN', 'MANAGER'] },
        active: true,
      },
      include: {
        staff: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        venue: {
          select: {
            id: true,
          },
        },
      },
    })

    // Group by staff ID
    const managerMap = new Map<
      string,
      {
        staff: (typeof managers)[0]['staff']
        venues: string[]
      }
    >()

    for (const m of managers) {
      const existing = managerMap.get(m.staffId) || { staff: m.staff, venues: [] }
      existing.venues.push(m.venueId)
      managerMap.set(m.staffId, existing)
    }

    // Single bulk query for all managers' venues (avoids 2M queries)
    const allVenueIds = Array.from(managerMap.values()).flatMap(d => d.venues)

    const salesByVenue = await prisma.order.groupBy({
      by: ['venueId'],
      where: {
        venueId: { in: allVenueIds },
        status: 'COMPLETED',
        createdAt: { gte: todayStart },
      },
      _sum: { total: true },
    })

    const venueSalesMap = new Map(salesByVenue.map(s => [s.venueId, Number(s._sum.total) || 0]))

    // Distribute results per manager based on their venues
    const results = Array.from(managerMap.entries()).map(([staffId, data]) => {
      let todaySales = 0
      let activeStores = 0

      for (const venueId of data.venues) {
        const sales = venueSalesMap.get(venueId)
        if (sales && sales > 0) {
          todaySales += sales
          activeStores++
        }
      }

      return {
        id: staffId,
        name: `${data.staff.firstName} ${data.staff.lastName}`.trim(),
        email: data.staff.email,
        storeCount: data.venues.length,
        activeStores,
        todaySales: Math.round(todaySales * 100) / 100,
      }
    })

    // Sort by today's sales descending
    return results.sort((a, b) => b.todaySales - a.todaySales)
  }

  /**
   * Get top promoter by sales count (completed orders today, día civil del venue)
   */
  async getTopPromoter(
    orgId: string,
    timezone: string = DEFAULT_TIMEZONE,
  ): Promise<{
    staffId: string
    staffName: string
    venueId: string
    venueName: string
    salesCount: number
  } | null> {
    const todayStart = venueStartOfDay(timezone)

    // Get all venues in organization
    const venues = await prisma.venue.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true },
    })

    if (venues.length === 0) return null

    const venueIds = venues.map(v => v.id)

    // Ventas de hoy por vendedor, contadas en Postgres (antes: todas las órdenes de hoy
    // de la org con su vendedor y su tienda materializadas para contarlas en Node). La
    // tienda es la de su PRIMERA venta de hoy y el empate lo gana quien empezó a vender
    // primero — antes lo decidía el orden en que la base devolviera las filas.
    const todayScope = Prisma.sql`o."venueId" IN (${Prisma.join(venueIds)}) AND o."status" = 'COMPLETED' AND o."createdAt" >= ${utcTs(todayStart)} AND o."createdById" IS NOT NULL`
    const rows = await prisma.$queryRaw<
      Array<{
        staffId: string
        salesCount: number
        firstName: string | null
        lastName: string | null
        venueId: string
        venueName: string | null
      }>
    >`
      WITH ranked AS (
        SELECT o."createdById" AS "staffId", COUNT(*)::int AS "salesCount", MIN(o."createdAt") AS "firstAt"
        FROM "Order" o
        WHERE ${todayScope}
        GROUP BY o."createdById"
        ORDER BY COUNT(*) DESC, MIN(o."createdAt") ASC, o."createdById" ASC
        LIMIT 1
      )
      SELECT r."staffId", r."salesCount", s."firstName", s."lastName", first_sale."venueId", v."name" AS "venueName"
      FROM ranked r
      LEFT JOIN "Staff" s ON s."id" = r."staffId"
      JOIN LATERAL (
        SELECT o."venueId"
        FROM "Order" o
        WHERE ${todayScope} AND o."createdById" = r."staffId"
        ORDER BY o."createdAt" ASC, o."id" ASC
        LIMIT 1
      ) first_sale ON TRUE
      LEFT JOIN "Venue" v ON v."id" = first_sale."venueId"
    `
    const top = rows[0]
    if (!top) return null

    return {
      staffId: top.staffId,
      staffName: `${top.firstName || ''} ${top.lastName || ''}`.trim(),
      venueId: top.venueId,
      venueName: top.venueName || '',
      salesCount: top.salesCount,
    }
  }

  /**
   * Get worst attendance (store with lowest percentage of active staff today, día civil del venue)
   */
  async getWorstAttendance(
    orgId: string,
    timezone: string = DEFAULT_TIMEZONE,
  ): Promise<{
    venueId: string
    venueName: string
    totalStaff: number
    activeStaff: number
    absences: number
    attendanceRate: number
  } | null> {
    const todayStart = venueStartOfDay(timezone)

    // Get all venues in organization
    const venues = await prisma.venue.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true },
    })

    if (venues.length === 0) return null

    // Bulk queries: staff count and active entries per venue (avoids 2V queries)
    const venueIds = venues.map(v => v.id)

    const [staffByVenue, activeByVenue] = await Promise.all([
      prisma.staffVenue.groupBy({
        by: ['venueId'],
        where: { venueId: { in: venueIds }, active: true },
        _count: true,
      }),
      prisma.timeEntry.groupBy({
        by: ['venueId'],
        where: {
          venueId: { in: venueIds },
          clockInTime: { gte: todayStart },
          clockOutTime: null,
        },
        _count: true,
      }),
    ])

    const staffMap = new Map(staffByVenue.map(s => [s.venueId, s._count]))
    const activeMap = new Map(activeByVenue.map(a => [a.venueId, a._count]))

    const venueAttendance = venues.map(venue => {
      const totalStaff = staffMap.get(venue.id) || 0
      if (totalStaff === 0) return null

      const activeStaff = activeMap.get(venue.id) || 0
      const absences = totalStaff - activeStaff
      const attendanceRate = totalStaff > 0 ? (activeStaff / totalStaff) * 100 : 0

      return {
        venueId: venue.id,
        venueName: venue.name,
        totalStaff,
        activeStaff,
        absences,
        attendanceRate: Math.round(attendanceRate * 10) / 10,
      }
    })

    // Filter out nulls and find worst attendance
    const validVenues = venueAttendance.filter(v => v !== null)
    if (validVenues.length === 0) return null

    const worstAttendance = validVenues.sort((a, b) => a.attendanceRate - b.attendanceRate)[0]

    return worstAttendance || null
  }

  /**
   * Get staff attendance with TimeEntry data for promoter audit
   * Returns all staff with their TimeEntry for the specified date
   */
  async getStaffAttendance(
    orgId: string,
    dateStr?: string,
    venueId?: string,
    statusFilter?: string,
    startDateStr?: string,
    endDateStr?: string,
  ): Promise<{
    staff: Array<{
      id: string
      name: string
      email: string
      // White-label org internal ID (e.g. PlayTelecom employee number).
      employeeCode: string | null
      avatar?: string | null
      venueId: string
      venueName: string
      status: 'ACTIVE' | 'INACTIVE'
      validationStatus: 'PENDING' | 'APPROVED' | 'REJECTED'
      checkInTime?: string | null
      checkInLocation?: { lat: number; lng: number } | null
      checkInPhotoUrl?: string | null
      checkOutTime?: string | null
      checkOutLocation?: { lat: number; lng: number } | null
      checkOutPhotoUrl?: string | null
      break: boolean
      breakMinutes: number
      sales: number
      attendancePercent: number
    }>
  }> {
    // Parse date range — convert venue-local dates to UTC for Prisma queries.
    // DB stores UTC (Prisma sends JS Date as UTC). Frontend sends YYYY-MM-DD venue-local dates.
    // We convert venue midnight/end-of-day to real UTC boundaries using fromZonedTime.
    let dayStart: Date
    let dayEnd: Date
    if (startDateStr && endDateStr) {
      dayStart = fromZonedTime(new Date(`${startDateStr}T00:00:00`), DEFAULT_TIMEZONE)
      dayEnd = fromZonedTime(new Date(`${endDateStr}T23:59:59.999`), DEFAULT_TIMEZONE)
    } else if (dateStr) {
      dayStart = fromZonedTime(new Date(`${dateStr}T00:00:00`), DEFAULT_TIMEZONE)
      dayEnd = fromZonedTime(new Date(`${dateStr}T23:59:59.999`), DEFAULT_TIMEZONE)
    } else {
      // No date specified → today in venue timezone
      const nowVenue = toZonedTime(new Date(), DEFAULT_TIMEZONE)
      dayStart = fromZonedTime(startOfDay(nowVenue), DEFAULT_TIMEZONE)
      dayEnd = fromZonedTime(endOfDay(nowVenue), DEFAULT_TIMEZONE)
    }

    // Get all venues in organization
    const venues = await prisma.venue.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true },
    })

    // A caller-supplied venueId must belong to THIS org — using it verbatim would let a
    // caller read another tenant's attendance (staff PII, GPS, photos, sales) by id.
    const orgVenueIds = venues.map(v => v.id)
    const venueIds = venueId ? orgVenueIds.filter(id => id === venueId) : orgVenueIds

    // Get all staff in these venues
    const staffVenues = await prisma.staffVenue.findMany({
      where: {
        venueId: { in: venueIds },
        active: true,
      },
      include: {
        staff: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            photoUrl: true,
            employeeCode: true,
          },
        },
        venue: { select: { name: true, timezone: true } },
      },
    })

    // Load attendance settings (venue > org > defaults) for lateness calculation
    const [venueSettingsList, orgAttendanceConfig] = await Promise.all([
      prisma.venueSettings.findMany({
        where: { venueId: { in: venueIds } },
        select: { venueId: true, expectedCheckInTime: true, latenessThresholdMinutes: true },
      }),
      prisma.organizationAttendanceConfig.findUnique({
        where: { organizationId: orgId },
      }),
    ])
    const attendanceSettingsMap = new Map(
      venueSettingsList.map(s => [
        s.venueId,
        {
          expectedCheckInTime: s.expectedCheckInTime ?? orgAttendanceConfig?.expectedCheckInTime ?? '09:00',
          latenessThresholdMinutes: s.latenessThresholdMinutes ?? orgAttendanceConfig?.latenessThresholdMinutes ?? 30,
        },
      ]),
    )
    const defaultAttendanceSettings = {
      expectedCheckInTime: orgAttendanceConfig?.expectedCheckInTime ?? '09:00',
      latenessThresholdMinutes: orgAttendanceConfig?.latenessThresholdMinutes ?? 30,
    }

    // Get TimeEntry for the specified date
    const timeEntries = await prisma.timeEntry.findMany({
      where: {
        venueId: { in: venueIds },
        clockInTime: { gte: dayStart, lte: dayEnd },
      },
      select: {
        id: true,
        staffId: true,
        venueId: true,
        clockInTime: true,
        clockOutTime: true,
        clockInLatitude: true,
        clockInLongitude: true,
        clockOutLatitude: true,
        clockOutLongitude: true,
        checkInPhotoUrl: true,
        facadePhotoUrl: true,
        checkOutPhotoUrl: true,
        depositPhotoUrl: true,
        status: true,
        validationStatus: true,
      },
    })

    // Get sales for each staff member per venue from completed payments
    const salesData = await prisma.payment.groupBy({
      by: ['processedById', 'venueId'],
      where: {
        venueId: { in: venueIds },
        createdAt: { gte: dayStart, lte: dayEnd },
        status: 'COMPLETED',
        processedById: { not: null },
      },
      _sum: { amount: true },
    })

    // Get CASH-only sales per staff (for deposit verification)
    const cashSalesData = await prisma.payment.groupBy({
      by: ['processedById', 'venueId'],
      where: {
        venueId: { in: venueIds },
        createdAt: { gte: dayStart, lte: dayEnd },
        status: 'COMPLETED',
        processedById: { not: null },
        method: 'CASH',
      },
      _sum: { amount: true },
    })

    // Efectivo por checada (ventana [clockIn, clockOut] inclusiva), agregado en Postgres.
    const cashByEntry = await cashSalesPerTimeEntry(venueIds, dayStart, dayEnd)

    // Key: staffId:venueId -> sales amount
    const salesByStaffVenue: Record<string, number> = {}
    salesData.forEach(s => {
      if (s.processedById) {
        const key = `${s.processedById}:${s.venueId}`
        salesByStaffVenue[key] = Number(s._sum.amount) || 0
      }
    })

    // Key: staffId:venueId -> cash sales amount
    const cashSalesByStaffVenue: Record<string, number> = {}
    cashSalesData.forEach(s => {
      if (s.processedById) {
        const key = `${s.processedById}:${s.venueId}`
        cashSalesByStaffVenue[key] = Number(s._sum.amount) || 0
      }
    })

    // Calculate attendance percentage for last 30 days
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    const attendanceData = await prisma.timeEntry.groupBy({
      by: ['staffId'],
      where: {
        venueId: { in: venueIds },
        clockInTime: { gte: thirtyDaysAgo },
      },
      _count: { id: true },
    })

    const attendanceByStaff: Record<string, number> = {}
    attendanceData.forEach(a => {
      // Simplified: count / 30 days * 100
      attendanceByStaff[a.staffId] = Math.round((a._count.id / 30) * 100)
    })

    // Build response
    const staffData = staffVenues.map(sv => {
      // Get ALL TimeEntries for this staff member at this venue (sorted most recent first)
      const staffTimeEntries = timeEntries
        .filter(te => te.staffId === sv.staffId && te.venueId === sv.venueId)
        .sort((a, b) => b.clockInTime.getTime() - a.clockInTime.getTime())

      const mostRecentEntry = staffTimeEntries[0] // Most recent for status
      const isActive = mostRecentEntry && !mostRecentEntry.clockOutTime
      const status = isActive ? 'ACTIVE' : 'INACTIVE'

      // Apply status filter
      if (statusFilter && status !== statusFilter) {
        return null
      }

      const fullName = `${sv.staff.firstName} ${sv.staff.lastName}`

      // Lateness calculation for this venue
      const venueTz = sv.venue.timezone || DEFAULT_TIMEZONE
      const aSetting = attendanceSettingsMap.get(sv.venueId) || defaultAttendanceSettings
      const [expH, expM] = aSetting.expectedCheckInTime.split(':').map(Number)
      const deadlineMin = expH * 60 + expM + aSetting.latenessThresholdMinutes

      // Transform all time entries for this staff member
      const allTimeEntries = staffTimeEntries.map(te => {
        // Cash sales for this specific time entry (clockIn → clockOut), from Postgres
        const teCashSales = cashByEntry.get(te.id) ?? 0

        // Lateness: convert clockIn to venue timezone and compare
        const localClockIn = toZonedTime(te.clockInTime, venueTz)
        const clockInMin = localClockIn.getHours() * 60 + localClockIn.getMinutes()
        const isLate = clockInMin > deadlineMin

        return {
          id: te.id,
          clockInTime: te.clockInTime.toISOString(),
          clockInLocation: te.clockInLatitude && te.clockInLongitude ? { lat: te.clockInLatitude, lng: te.clockInLongitude } : null,
          checkInPhotoUrl: te.checkInPhotoUrl,
          facadePhotoUrl: te.facadePhotoUrl,
          clockOutTime: te.clockOutTime?.toISOString() || null,
          clockOutLocation: te.clockOutLatitude && te.clockOutLongitude ? { lat: te.clockOutLatitude, lng: te.clockOutLongitude } : null,
          checkOutPhotoUrl: te.checkOutPhotoUrl,
          depositPhotoUrl: te.depositPhotoUrl,
          status: te.status,
          validationStatus: te.validationStatus,
          cashSales: teCashSales,
          isLate,
        }
      })

      // Calculate break time (time between clock out of one entry and clock in of next)
      let breakMinutes = 0
      const sortedEntriesAsc = [...staffTimeEntries].reverse() // Oldest first for break calculation
      for (let i = 0; i < sortedEntriesAsc.length - 1; i++) {
        const currentEntry = sortedEntriesAsc[i]
        const nextEntry = sortedEntriesAsc[i + 1]
        if (currentEntry.clockOutTime && nextEntry.clockInTime) {
          const breakMs = nextEntry.clockInTime.getTime() - currentEntry.clockOutTime.getTime()
          if (breakMs > 0) {
            breakMinutes += Math.round(breakMs / 60000) // Convert to minutes
          }
        }
      }

      return {
        id: sv.staffId,
        timeEntryId: mostRecentEntry?.id || null,
        validationStatus: mostRecentEntry?.validationStatus || 'PENDING',
        name: fullName,
        email: sv.staff.email,
        employeeCode: sv.staff.employeeCode ?? null,
        avatar: sv.staff.photoUrl,
        venueId: sv.venueId,
        venueName: sv.venue.name,
        status,
        // Most recent entry info for table display
        checkInTime: mostRecentEntry?.clockInTime?.toISOString() || null,
        checkInLocation:
          mostRecentEntry?.clockInLatitude && mostRecentEntry?.clockInLongitude
            ? { lat: mostRecentEntry.clockInLatitude, lng: mostRecentEntry.clockInLongitude }
            : null,
        checkInPhotoUrl: mostRecentEntry?.checkInPhotoUrl || null,
        facadePhotoUrl: mostRecentEntry?.facadePhotoUrl || null,
        checkOutTime: mostRecentEntry?.clockOutTime?.toISOString() || null,
        checkOutLocation:
          mostRecentEntry?.clockOutLatitude && mostRecentEntry?.clockOutLongitude
            ? { lat: mostRecentEntry.clockOutLatitude, lng: mostRecentEntry.clockOutLongitude }
            : null,
        checkOutPhotoUrl: mostRecentEntry?.checkOutPhotoUrl || null,
        depositPhotoUrl: mostRecentEntry?.depositPhotoUrl || null,
        break: mostRecentEntry?.status === 'ON_BREAK',
        breakMinutes,
        sales: salesByStaffVenue[`${sv.staffId}:${sv.venueId}`] || 0,
        cashSales: cashSalesByStaffVenue[`${sv.staffId}:${sv.venueId}`] || 0,
        attendancePercent: attendanceByStaff[sv.staffId] || 0,
        // Lateness from first check-in of the day (oldest entry)
        isLate: allTimeEntries.length > 0 ? allTimeEntries[allTimeEntries.length - 1].isLate : false,
        // All time entries for the day
        allTimeEntries,
      }
    })

    return {
      // Only return staff with actual activity (check-in or sales) for the day
      staff: staffData.filter(s => s !== null && (s.checkInTime !== null || s.sales > 0)) as any,
    }
  }

  /**
   * Get sales trend for a staff member (last 7 days)
   */
  async getStaffSalesTrend(orgId: string, staffId: string, timezone: string = DEFAULT_TIMEZONE) {
    await this.assertStaffInOrg(orgId, staffId)
    // Ventana y día de la semana en la zona del VENUE (decisión de producto 2026-09-01).
    // Antes era la del host, que en producción es UTC: una venta de las 20:00 de México
    // caía en el día siguiente y la ventana arrancaba a las 18:00 de la víspera.
    const sevenDaysAgo = venueStartOfDayOffset(timezone, -7)
    const todayVenue = toZonedTime(new Date(), timezone)

    // Ventas de los últimos 7 días agrupadas por día de la semana (del venue) en Postgres.
    const rows = await prisma.$queryRaw<Array<{ dow: number; sales: Prisma.Decimal | null }>>`
      SELECT EXTRACT(DOW FROM ${localWallClock(timezone, Prisma.raw('o."createdAt"'))})::int AS "dow", SUM(o."total") AS "sales"
      FROM "Order" o
      WHERE o."venueId" IN (${orgVenueIdsSql(orgId)})
        AND o."createdById" = ${staffId} AND o."status" = 'COMPLETED' AND o."createdAt" >= ${utcTs(sevenDaysAgo)}
      GROUP BY 1
    `

    // Group by day
    const salesByDay: Record<string, number> = {}
    const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']

    // Initialize last 7 days (día de la semana del venue)
    for (let i = 6; i >= 0; i--) {
      const dayName = dayNames[subDays(todayVenue, i).getDay()]
      salesByDay[dayName] = 0
    }

    // Aggregate sales (DOW de Postgres: 0 = domingo … 6 = sábado, igual que getDay())
    for (const row of rows) {
      const dayName = dayNames[row.dow]
      if (salesByDay[dayName] !== undefined) {
        salesByDay[dayName] += Number(row.sales) || 0
      }
    }

    const salesData = Object.entries(salesByDay).map(([day, sales]) => ({
      day,
      sales,
    }))

    return { salesData }
  }

  /**
   * Get sales mix by category for a staff member
   */
  async getStaffSalesMix(orgId: string, staffId: string) {
    await this.assertStaffInOrg(orgId, staffId)
    // Importe por categoría de catálogo, agregado en Postgres (antes: TODO el historial
    // de órdenes del vendedor con items, producto y categoría materializado en Node —
    // sin rango de fechas, el peor de los quince). Sin producto o sin nombre → «Sin categoría».
    const rows = await prisma.$queryRaw<Array<{ category: string; amount: Prisma.Decimal | null }>>`
      SELECT COALESCE(NULLIF(mc."name", ''), 'Sin categoría') AS "category", SUM(oi."total") AS "amount"
      FROM "OrderItem" oi
      JOIN "Order" o ON o."id" = oi."orderId"
      LEFT JOIN "Product" p ON p."id" = oi."productId" AND p."venueId" IN (${orgVenueIdsSql(orgId)})
      LEFT JOIN "MenuCategory" mc ON mc."id" = p."categoryId" AND mc."venueId" IN (${orgVenueIdsSql(orgId)})
      WHERE o."venueId" IN (${orgVenueIdsSql(orgId)}) AND o."createdById" = ${staffId} AND o."status" = 'COMPLETED'
      GROUP BY 1
      ORDER BY SUM(oi."total") DESC, 1
    `
    const categoryTotals = rows.map(r => ({ category: r.category, amount: Number(r.amount) || 0 }))
    const totalSales = categoryTotals.reduce((sum, c) => sum + c.amount, 0)

    // Convert to percentages — top 4 categories; el porcentaje es sobre el total de todas
    const salesMix = categoryTotals
      .map(({ category, amount }) => ({
        category,
        percentage: totalSales > 0 ? Math.round((amount / totalSales) * 100) : 0,
        amount,
      }))
      .slice(0, 4)

    return { salesMix }
  }

  /**
   * Get attendance calendar for current month
   */
  async getStaffAttendanceCalendar(orgId: string, staffId: string, timezone: string = DEFAULT_TIMEZONE) {
    await this.assertStaffInOrg(orgId, staffId)
    // Mes, "hoy" y el día de cada checada en la zona del VENUE. Antes: medianoche del host
    // (UTC en producción, 6 h corrida) y el día de la checada por su fecha UTC, así que
    // una entrada a las 19:00 de México se pintaba en el día siguiente.
    const now = new Date()
    const nowVenue = toZonedTime(now, timezone)
    const monthStart = venueStartOfMonth(timezone)
    const monthEnd = fromZonedTime(endOfMonth(nowVenue), timezone)
    const monthPrefix = formatInTimeZone(now, timezone, 'yyyy-MM')

    // Get all TimeEntry for this month with full details for dialog
    const timeEntries = await prisma.timeEntry.findMany({
      where: {
        staffId,
        venue: { organizationId: orgId },
        clockInTime: {
          gte: monthStart,
          lte: monthEnd,
        },
      },
      select: {
        clockInTime: true,
        clockOutTime: true,
        clockInLatitude: true,
        clockInLongitude: true,
        clockOutLatitude: true,
        clockOutLongitude: true,
        checkInPhotoUrl: true,
        checkOutPhotoUrl: true,
        status: true,
      },
      orderBy: {
        clockInTime: 'desc',
      },
    })

    // Transform entries to include location objects for frontend compatibility
    const transformedEntries = timeEntries.map(entry => ({
      clockInTime: entry.clockInTime,
      clockOutTime: entry.clockOutTime,
      clockInLocation: entry.clockInLatitude && entry.clockInLongitude ? { lat: entry.clockInLatitude, lng: entry.clockInLongitude } : null,
      clockOutLocation:
        entry.clockOutLatitude && entry.clockOutLongitude ? { lat: entry.clockOutLatitude, lng: entry.clockOutLongitude } : null,
      checkInPhotoUrl: entry.checkInPhotoUrl,
      checkOutPhotoUrl: entry.checkOutPhotoUrl,
      status: entry.status,
    }))

    // Create calendar array with attendance info (días civiles del venue)
    const daysInMonth = endOfMonth(nowVenue).getDate()
    const todayNumber = nowVenue.getDate()
    const entriesByVenueDay = new Map<string, typeof transformedEntries>()
    for (const entry of transformedEntries) {
      const key = formatInTimeZone(entry.clockInTime, timezone, 'yyyy-MM-dd')
      entriesByVenueDay.set(key, [...(entriesByVenueDay.get(key) ?? []), entry])
    }
    const calendar = Array.from({ length: daysInMonth }, (_, idx) => {
      const dayNumber = idx + 1
      const dateString = `${monthPrefix}-${String(dayNumber).padStart(2, '0')}`

      // Get all TimeEntry for this specific day
      const dayTimeEntries = entriesByVenueDay.get(dateString) ?? []

      const hasAttendance = dayTimeEntries.length > 0
      const isToday = dayNumber === todayNumber
      const isFutureDay = dayNumber > todayNumber

      return {
        day: dayNumber,
        date: dateString,
        isPresent: hasAttendance,
        isToday,
        isFutureDay,
        timeEntries: dayTimeEntries, // Include full time entries for the dialog
      }
    })

    // Calculate stats
    const presentDays = calendar.filter(d => !d.isFutureDay && d.isPresent).length
    const absentDays = calendar.filter(d => !d.isFutureDay && !d.isPresent).length

    return {
      calendar,
      stats: {
        present: presentDays,
        absent: absentDays,
      },
    }
  }

  /**
   * Candado de tenant de los endpoints por empleado del dashboard de organización. Lanza 404
   * si el empleado no tiene StaffVenue ACTIVO en un venue de la org ni StaffOrganization con
   * ella: checkOrgAccess sólo valida que QUIEN PREGUNTA sea de la org, no que el staffId de la
   * URL lo sea, y con eso un OWNER de la org A leía ventas, mezcla y checadas de un empleado
   * de la org B (IDOR cross-tenant, 2026-09-01). Las consultas que siguen se acotan ADEMÁS a
   * los venues de la org dentro del propio SQL (`orgVenueIdsSql`) o por la relación
   * `venue.organizationId`, para que la defensa no dependa sólo de este chequeo ni de una
   * foto de ids tomada antes de consultar.
   */
  private async assertStaffInOrg(orgId: string, staffId: string): Promise<void> {
    const member = await prisma.staff.findFirst({
      where: {
        id: staffId,
        OR: [
          { venues: { some: { active: true, venue: { organizationId: orgId } } } },
          { organizations: { some: { organizationId: orgId } } },
        ],
      },
      select: { id: true },
    })
    if (!member) {
      throw new NotFoundError('El empleado no pertenece a esta organización')
    }
  }

  // ==========================================
  // TIME ENTRY VALIDATION
  // ==========================================

  async validateTimeEntry(
    timeEntryId: string,
    orgId: string,
    validatedById: string,
    status: 'APPROVED' | 'REJECTED',
    note?: string,
    depositAmount?: number,
  ) {
    // Verify the time entry belongs to a venue in this org
    const timeEntry = await prisma.timeEntry.findFirst({
      where: {
        id: timeEntryId,
        venue: { organizationId: orgId },
      },
    })

    if (!timeEntry) {
      throw new Error('Time entry not found in this organization')
    }

    const result = await prisma.$transaction(async tx => {
      const updated = await tx.timeEntry.update({
        where: { id: timeEntryId },
        data: {
          validationStatus: status,
          validatedBy: validatedById,
          validatedAt: new Date(),
          validationNote: note || null,
        },
      })

      // Create CashDeposit when approving with a deposit amount
      if (status === 'APPROVED' && depositAmount != null && depositAmount > 0) {
        await tx.cashDeposit.create({
          data: {
            staffId: timeEntry.staffId,
            venueId: timeEntry.venueId,
            amount: new Prisma.Decimal(depositAmount),
            method: 'BANK_TRANSFER',
            status: 'APPROVED',
            approvedById: validatedById,
            approvedAt: new Date(),
          },
        })
      }

      return updated
    })

    logAction({
      staffId: validatedById,
      venueId: timeEntry.venueId,
      action: `TIME_ENTRY_${status}`,
      entity: 'TimeEntry',
      entityId: timeEntryId,
      data: { note, depositAmount },
    })

    return result
  }

  /**
   * Reset a time entry validation back to PENDING
   * Also deletes any associated CashDeposit created during approval
   */
  async resetTimeEntryValidation(timeEntryId: string, orgId: string) {
    const timeEntry = await prisma.timeEntry.findFirst({
      where: {
        id: timeEntryId,
        venue: { organizationId: orgId },
      },
    })

    if (!timeEntry) {
      throw new Error('Time entry not found in this organization')
    }

    const result = await prisma.$transaction(async tx => {
      // Delete any CashDeposit created around the same time as validation
      if (timeEntry.validatedAt) {
        const windowStart = new Date(timeEntry.validatedAt.getTime() - 5000)
        const windowEnd = new Date(timeEntry.validatedAt.getTime() + 5000)
        await tx.cashDeposit.deleteMany({
          where: {
            staffId: timeEntry.staffId,
            venueId: timeEntry.venueId,
            status: 'APPROVED',
            createdAt: { gte: windowStart, lte: windowEnd },
          },
        })
      }

      return tx.timeEntry.update({
        where: { id: timeEntryId },
        data: {
          validationStatus: 'PENDING',
          validatedBy: null,
          validatedAt: null,
          validationNote: null,
        },
      })
    })

    logAction({
      venueId: timeEntry.venueId,
      action: 'TIME_ENTRY_VALIDATION_RESET',
      entity: 'TimeEntry',
      entityId: timeEntryId,
    })

    return result
  }

  // ==========================================
  // ZONES CRUD
  // ==========================================

  async getZones(orgId: string) {
    return prisma.zone.findMany({
      where: { organizationId: orgId },
      include: {
        venues: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { name: 'asc' },
    })
  }

  async createZone(orgId: string, name: string, slug: string) {
    const zone = await prisma.zone.create({
      data: { organizationId: orgId, name, slug },
    })

    logAction({
      action: 'ZONE_CREATED',
      entity: 'Zone',
      entityId: zone.id,
      data: { name, slug },
    })

    return zone
  }

  async updateZone(orgId: string, zoneId: string, data: { name?: string; slug?: string }) {
    await this.assertZoneInOrg(orgId, zoneId)
    const zone = await prisma.zone.update({
      where: { id: zoneId },
      data,
    })

    logAction({
      action: 'ZONE_UPDATED',
      entity: 'Zone',
      entityId: zoneId,
      data: { changes: Object.keys(data) },
    })

    return zone
  }

  async deleteZone(orgId: string, zoneId: string) {
    await this.assertZoneInOrg(orgId, zoneId)
    // Set null on venues referencing this zone, then delete
    await prisma.venue.updateMany({
      where: { zoneId, organizationId: orgId },
      data: { zoneId: null },
    })
    const zone = await prisma.zone.delete({ where: { id: zoneId } })

    logAction({
      action: 'ZONE_DELETED',
      entity: 'Zone',
      entityId: zoneId,
    })

    return zone
  }

  /**
   * Candado de tenant de las zonas: la ruta sólo valida que QUIEN PREGUNTA sea de la org y el
   * zoneId de la URL entraba tal cual — cualquier miembro de una org renombraba o borraba zonas
   * de OTRA org (IDOR cross-tenant, 2026-09-01). 404 para no confirmar la existencia del id.
   */
  private async assertZoneInOrg(orgId: string, zoneId: string): Promise<void> {
    const zone = await prisma.zone.findFirst({ where: { id: zoneId, organizationId: orgId }, select: { id: true } })
    if (!zone) {
      throw new NotFoundError('La zona no pertenece a esta organización')
    }
  }

  // ==========================================
  // CLOSING REPORT
  // ==========================================

  async getClosingReportData(orgId: string, dateStr?: string, venueId?: string) {
    const timezone = 'America/Mexico_City'
    // Un `YYYY-MM-DD` es un día civil del venue y se abre en su zona. Antes pasaba por
    // `new Date('YYYY-MM-DD')` = medianoche UTC = 18:00 del día ANTERIOR en México, y el
    // reporte del día D salía con las ventas del D−1 (verificado con datos reales el
    // 2026-09-01). Un instante ISO completo conserva lo de siempre: el día del venue que lo contiene.
    const isBareDay = !!dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
    const targetDate = dateStr ? new Date(dateStr) : new Date()
    const startOfDayDb = isBareDay ? fromZonedTime(`${dateStr}T00:00:00.000`, timezone) : venueStartOfDay(timezone, targetDate)
    const endOfDayDb = isBareDay ? fromZonedTime(`${dateStr}T23:59:59.999`, timezone) : venueEndOfDay(timezone, targetDate)

    const startUtc = startOfDayDb
    const endUtc = endOfDayDb

    const venueWhere = venueId ? { id: venueId, organizationId: orgId } : { organizationId: orgId }

    // Get completed orders with serialized items + sale verification (back-office review status)
    const orders = await prisma.order.findMany({
      where: {
        venue: venueWhere,
        createdAt: { gte: startUtc, lte: endUtc },
        status: 'COMPLETED',
      },
      // Select quirúrgico: la fila del reporte usa fecha, etiquetas, tienda, promotor,
      // pagos e items — no la orden entera (antes: todas las columnas de cada orden del día).
      select: {
        id: true,
        createdAt: true,
        tags: true,
        venue: { select: { name: true, city: true, state: true } },
        createdBy: { select: { firstName: true, lastName: true } },
        payments: {
          select: {
            amount: true,
            status: true,
            saleVerification: {
              select: { status: true, isPortabilidad: true },
            },
          },
        },
        items: { select: { productName: true, productSku: true, unitPrice: true } },
      },
      orderBy: { createdAt: 'asc' },
    })

    const rows = orders.map((order: any, idx: number) => {
      const totalPaid = (order.payments || [])
        .filter((p: any) => p.status === 'COMPLETED')
        .reduce((sum: number, p: any) => sum + Number(p.amount), 0)

      // Try to extract ICCID from product SKU (serialized items)
      const iccid = order.items?.[0]?.productSku || ''
      const productName = order.items?.[0]?.productName || 'Venta'

      // Pull back-office review status from the most recent payment with a SaleVerification.
      // SaleVerification is the source of truth for both portabilidad and review status —
      // it's what the promoter captured at the TPV and what back-office acts on.
      const verification = (order.payments || []).map((p: any) => p.saleVerification).find((v: any) => v != null) as
        | { status: string; isPortabilidad: boolean }
        | undefined

      const isPortabilidad: boolean = verification?.isPortabilidad ?? (Array.isArray(order.tags) && order.tags.includes('portabilidad'))

      // Map verification status → human-readable label expected by back-office (per Asana spec):
      //   COMPLETED → "Aprobada"
      //   PENDING   → "En revisión por administración"
      //   FAILED    → "Revisar por promotor"
      //   REJECTED  → "Rechazada" (terminal — sale lost, couldn't link/port)
      //   null      → "Sin verificación" (no photos uploaded — separate from FAILED)
      const saleStatus =
        verification == null
          ? 'Sin verificación'
          : verification.status === 'COMPLETED'
            ? 'Aprobada'
            : verification.status === 'FAILED'
              ? 'Revisar por promotor'
              : verification.status === 'REJECTED'
                ? 'Rechazada'
                : 'En revisión por administración'

      return {
        row: idx + 1,
        city: order.venue?.city || order.venue?.state || '',
        store: order.venue?.name || '',
        iccid,
        saleType: productName,
        promoter: order.createdBy ? `${order.createdBy.firstName} ${order.createdBy.lastName}` : 'N/A',
        date: order.createdAt.toISOString().split('T')[0],
        amount: totalPaid,
        // Back-office review columns (PlayTelecom / Walmart documentation flow)
        isPortabilidad,
        saleStatus,
      }
    })

    const totalAmount = rows.reduce((sum, r) => sum + r.amount, 0)

    return { rows, totalAmount, date: dateStr || startOfDayDb.toISOString().split('T')[0] }
  }

  async exportClosingReport(orgId: string, dateStr?: string, venueId?: string): Promise<Buffer> {
    const XLSX = await import('xlsx')
    const data = await this.getClosingReportData(orgId, dateStr, venueId)

    const worksheetData = [
      ['#', 'Ciudad', 'Tienda', 'ICCID', 'Tipo Venta', 'Es Portabilidad', 'Status de Venta', 'Promotor', 'Fecha', 'Monto Cobrado'],
      ...data.rows.map(r => [
        r.row,
        r.city,
        r.store,
        r.iccid,
        r.saleType,
        r.isPortabilidad ? 'Si' : 'No',
        r.saleStatus,
        r.promoter,
        r.date,
        r.amount,
      ]),
      [],
      ['', '', '', '', '', '', '', '', 'TOTAL COBRADO:', data.totalAmount],
    ]

    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet(worksheetData)
    XLSX.utils.book_append_sheet(wb, ws, 'Reporte de Cierre')

    return Buffer.from(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }))
  }

  // ==========================================
  // ADMIN PASSWORD RESET
  // ==========================================

  async resetUserPassword(orgId: string, userId: string, performedBy?: string) {
    // Verify user belongs to org
    const staffOrg = await prisma.staffOrganization.findFirst({
      where: { staffId: userId, organizationId: orgId },
    })

    if (!staffOrg) {
      throw new Error('User not found in this organization')
    }

    // Generate a temp password
    const tempPassword = Math.random().toString(36).slice(-8)
    const bcrypt = await import('bcryptjs')
    const hashedPassword = await bcrypt.hash(tempPassword, 12)

    await prisma.staff.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        // 🔴 Sella el cambio para que las sesiones abiertas de esa persona se
        // caigan (ver passwordChangeGuard). Este es JUSTO el caso que motivo el
        // guard: el dueno le resetea la contrasena a un empleado que acaba de
        // correr. Sin este sello el empleado se queda dentro desde su celular
        // hasta que venza su refresh token — hasta 90 dias.
        lastPasswordReset: new Date(),
      },
    })

    // 🔴 Same reset, second lever (Task 7): also close the new `Session` rows
    // (T1-T6), so a token carrying `sid` dies the same way as one that
    // doesn't. Best-effort — see `cerrarSesionesNuevasPorCambioDeContrasena`.
    await cerrarSesionesNuevasPorCambioDeContrasena(userId)

    // Audit WHO reset WHOM. `performedBy` (the caller's staffId) is required for a
    // meaningful trail — a password reset without it is unattributable. Authorization
    // is enforced at the route layer (owner-only), never here.
    logAction({
      staffId: performedBy || null,
      action: 'USER_PASSWORD_RESET',
      entity: 'Staff',
      entityId: userId,
      data: { organizationId: orgId },
    })

    return { tempPassword, message: 'Password reset successfully. Share the temporary password securely.' }
  }

  // ==========================================
  // HEATMAPS (Attendance & Sales)
  // ==========================================

  /**
   * Get scoped staff/venues for heatmap queries based on requesting user's role.
   * - SUPERADMIN/OWNER: All staff in org
   * - ADMIN: All staff with role < ADMIN
   * - MANAGER: Only staff in their assigned venues with role < MANAGER
   */
  private async getHeatmapScope(orgId: string, requestingRole: string, requestingStaffId: string, filterVenueId?: string) {
    const roleHierarchyValue = ROLE_HIERARCHY[requestingRole as StaffRole] ?? 0

    // Determine which venues this user can see
    let allowedVenueIds: string[]

    if (roleHierarchyValue >= ROLE_HIERARCHY.OWNER) {
      // OWNER/SUPERADMIN: all venues in org
      const venues = await prisma.venue.findMany({
        where: { organizationId: orgId },
        select: { id: true },
      })
      allowedVenueIds = venues.map(v => v.id)
    } else if (requestingRole === 'ADMIN') {
      // ADMIN: all venues in org
      const venues = await prisma.venue.findMany({
        where: { organizationId: orgId },
        select: { id: true },
      })
      allowedVenueIds = venues.map(v => v.id)
    } else {
      // MANAGER or below: only their assigned venues
      const myVenues = await prisma.staffVenue.findMany({
        where: { staffId: requestingStaffId, venue: { organizationId: orgId }, active: true },
        select: { venueId: true },
      })
      allowedVenueIds = myVenues.map(v => v.venueId)
    }

    // Apply venue filter if provided
    if (filterVenueId) {
      allowedVenueIds = allowedVenueIds.filter(id => id === filterVenueId)
    }

    if (allowedVenueIds.length === 0) {
      return { staffVenues: [], venueSettingsMap: new Map(), orgAttendanceConfig: null }
    }

    // Fetch staff in allowed venues, filtering by role hierarchy
    const staffVenues = await prisma.staffVenue.findMany({
      where: {
        venueId: { in: allowedVenueIds },
        active: true,
        // MANAGER: only see staff with lower role
        ...(roleHierarchyValue < ROLE_HIERARCHY.OWNER
          ? { role: { in: Object.keys(ROLE_HIERARCHY).filter(r => ROLE_HIERARCHY[r as StaffRole] < roleHierarchyValue) as StaffRole[] } }
          : {}),
      },
      select: {
        staffId: true,
        venueId: true,
        role: true,
        staff: { select: { firstName: true, lastName: true, employeeCode: true } },
        venue: { select: { name: true, state: true, timezone: true } },
      },
    })

    // Fetch venue settings + org attendance config for lateness thresholds
    const [settings, orgAttendanceConfig] = await Promise.all([
      prisma.venueSettings.findMany({
        where: { venueId: { in: allowedVenueIds } },
        select: { venueId: true, expectedCheckInTime: true, latenessThresholdMinutes: true },
      }),
      prisma.organizationAttendanceConfig.findUnique({
        where: { organizationId: orgId },
      }),
    ])
    // Resolve: venue config > org config > hardcoded defaults
    const venueSettingsMap = new Map(
      settings.map(s => [
        s.venueId,
        {
          expectedCheckInTime: s.expectedCheckInTime ?? orgAttendanceConfig?.expectedCheckInTime ?? '09:00',
          latenessThresholdMinutes: s.latenessThresholdMinutes ?? orgAttendanceConfig?.latenessThresholdMinutes ?? 30,
        },
      ]),
    )

    const mapped = staffVenues.map(sv => ({
      staffId: sv.staffId,
      staffName: `${sv.staff.firstName} ${sv.staff.lastName}`,
      staffEmployeeCode: sv.staff.employeeCode ?? null,
      venueId: sv.venueId,
      venueName: sv.venue.name,
      venueState: sv.venue.state || '',
      venueTimezone: sv.venue.timezone || DEFAULT_TIMEZONE,
    }))

    return { staffVenues: mapped, venueSettingsMap, orgAttendanceConfig }
  }

  /**
   * Attendance Heatmap — matrix of staff × day showing present/late/absent
   */
  async getAttendanceHeatmap(
    orgId: string,
    startDateStr: string,
    endDateStr: string,
    requestingRole: string,
    requestingStaffId: string,
    filterVenueId?: string,
  ) {
    // Guard: max 90 days
    const start = new Date(startDateStr)
    const end = new Date(endDateStr)
    const diffDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
    if (diffDays > 90) {
      throw new Error('Date range cannot exceed 90 days')
    }

    const { staffVenues, venueSettingsMap, orgAttendanceConfig } = await this.getHeatmapScope(
      orgId,
      requestingRole,
      requestingStaffId,
      filterVenueId,
    )

    if (staffVenues.length === 0) {
      return { staff: [], summary: { byDay: [] } }
    }

    const staffIds = [...new Set(staffVenues.map(sv => sv.staffId))]
    const venueIds = [...new Set(staffVenues.map(sv => sv.venueId))]

    // Convert date range to UTC for query (use DEFAULT_TIMEZONE for the range boundaries)
    const rangeStart = fromZonedTime(new Date(`${startDateStr}T00:00:00`), DEFAULT_TIMEZONE)
    const rangeEnd = fromZonedTime(new Date(`${endDateStr}T23:59:59.999`), DEFAULT_TIMEZONE)

    // Una fila por persona × tienda × día del venue con la checada MÁS TEMPRANA de ese
    // día, resuelta en Postgres (antes: todas las checadas del rango materializadas, y
    // "la primera" era la primera que devolviera la base, sin orden garantizado).
    const firstEntries = await prisma.$queryRaw<
      Array<{ staffId: string; venueId: string; localDate: string; clockInTime: Date; clockOutTime: Date | null }>
    >`
      SELECT DISTINCT ON (x."staffId", x."venueId", x."localDate")
             x."staffId", x."venueId", x."localDate", x."clockInTime", x."clockOutTime"
      FROM (
        SELECT te."id", te."staffId", te."venueId", te."clockInTime", te."clockOutTime",
               ${venueLocalDay(Prisma.raw('te."clockInTime"'))} AS "localDate"
        FROM ${TIME_ENTRIES} te
        JOIN "Venue" v ON v."id" = te."venueId"
        WHERE te."staffId" IN (${Prisma.join(staffIds)})
          AND te."venueId" IN (${Prisma.join(venueIds)})
          AND ${rangeSql(Prisma.raw('te."clockInTime"'), rangeStart, rangeEnd)}
      ) x
      ORDER BY x."staffId", x."venueId", x."localDate", x."clockInTime" ASC, x."id" ASC
    `

    // Enumerate all days in the range (cadenas civiles: no pasan por la zona del host)
    const dayStrings = calendarDayStrings(startDateStr, endDateStr)

    // Index time entries by staffId:venueId:date
    const entryIndex = new Map<string, { clockInTime: Date; clockOutTime: Date | null }>()
    for (const te of firstEntries) {
      entryIndex.set(`${te.staffId}:${te.venueId}:${te.localDate}`, { clockInTime: te.clockInTime, clockOutTime: te.clockOutTime })
    }

    // Today in venue timezone (to detect future days)
    const todayStr = format(toZonedTime(new Date(), DEFAULT_TIMEZONE), 'yyyy-MM-dd')

    // Build staff rows
    const staffRows = staffVenues.map(sv => {
      const settings = venueSettingsMap.get(sv.venueId) || {
        expectedCheckInTime: orgAttendanceConfig?.expectedCheckInTime ?? '09:00',
        latenessThresholdMinutes: orgAttendanceConfig?.latenessThresholdMinutes ?? 30,
      }
      const [expectedHour, expectedMin] = settings.expectedCheckInTime.split(':').map(Number)
      const thresholdMinutes = settings.latenessThresholdMinutes

      const days = dayStrings.map(dateStr => {
        const key = `${sv.staffId}:${sv.venueId}:${dateStr}`
        const entry = entryIndex.get(key)

        // Future day
        if (dateStr > todayStr) {
          return { date: dateStr, status: 'future' as const, clockInTime: null, clockOutTime: null }
        }

        if (!entry) {
          return { date: dateStr, status: 'absent' as const, clockInTime: null, clockOutTime: null }
        }

        // Determine lateness: convert clockInTime to venue local time
        const localClockIn = toZonedTime(entry.clockInTime, sv.venueTimezone)
        const clockInMinutes = localClockIn.getHours() * 60 + localClockIn.getMinutes()
        const deadlineMinutes = expectedHour * 60 + expectedMin + thresholdMinutes

        const status = clockInMinutes > deadlineMinutes ? ('late' as const) : ('present' as const)

        return {
          date: dateStr,
          status,
          clockInTime: entry.clockInTime.toISOString(),
          clockOutTime: entry.clockOutTime?.toISOString() || null,
        }
      })

      return {
        staffId: sv.staffId,
        staffName: sv.staffName,
        staffEmployeeCode: sv.staffEmployeeCode,
        venueId: sv.venueId,
        venueName: sv.venueName,
        venueState: sv.venueState,
        days,
      }
    })

    // Build summary by day
    const byDay = dayStrings.map(dateStr => {
      let present = 0
      let late = 0
      let absent = 0
      for (const row of staffRows) {
        const day = row.days.find(d => d.date === dateStr)
        if (day?.status === 'present') present++
        else if (day?.status === 'late') late++
        else if (day?.status === 'absent') absent++
      }
      return { date: dateStr, present, late, absent }
    })

    return { staff: staffRows, summary: { byDay } }
  }

  /**
   * Sales Heatmap — matrix of staff × day showing sales count & amount
   */
  async getSalesHeatmap(
    orgId: string,
    startDateStr: string,
    endDateStr: string,
    requestingRole: string,
    requestingStaffId: string,
    filterVenueId?: string,
  ) {
    // Guard: max 90 days
    const start = new Date(startDateStr)
    const end = new Date(endDateStr)
    const diffDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
    if (diffDays > 90) {
      throw new Error('Date range cannot exceed 90 days')
    }

    const { staffVenues } = await this.getHeatmapScope(orgId, requestingRole, requestingStaffId, filterVenueId)

    if (staffVenues.length === 0) {
      return { staff: [], summary: { byDay: [], byVenue: [] } }
    }

    const staffIds = [...new Set(staffVenues.map(sv => sv.staffId))]
    const venueIds = [...new Set(staffVenues.map(sv => sv.venueId))]

    // Convert date range to UTC
    const rangeStart = fromZonedTime(new Date(`${startDateStr}T00:00:00`), DEFAULT_TIMEZONE)
    const rangeEnd = fromZonedTime(new Date(`${endDateStr}T23:59:59.999`), DEFAULT_TIMEZONE)

    // Conteo e importe por vendedor × tienda × día del venue, agregados en Postgres
    // (antes: todos los pagos del rango materializados para sumarlos en Node).
    const salesRows = await prisma.$queryRaw<
      Array<{ staffId: string; venueId: string; localDate: string; count: number; amount: Prisma.Decimal | null }>
    >`
      SELECT p."processedById" AS "staffId", p."venueId",
             ${venueLocalDay(Prisma.raw('p."createdAt"'))} AS "localDate",
             COUNT(*)::int AS "count", SUM(p."amount") AS "amount"
      FROM "Payment" p
      JOIN "Venue" v ON v."id" = p."venueId"
      WHERE p."processedById" IN (${Prisma.join(staffIds)})
        AND p."venueId" IN (${Prisma.join(venueIds)})
        AND p."status" = 'COMPLETED'
        AND ${rangeSql(Prisma.raw('p."createdAt"'), rangeStart, rangeEnd)}
      GROUP BY 1, 2, 3
    `

    // Enumerate days (cadenas civiles: no pasan por la zona del host)
    const dayStrings = calendarDayStrings(startDateStr, endDateStr)

    // Index sales by staffId:venueId:date
    const salesIndex = new Map<string, { count: number; amount: number }>()
    for (const r of salesRows) {
      salesIndex.set(`${r.staffId}:${r.venueId}:${r.localDate}`, { count: r.count, amount: Number(r.amount) || 0 })
    }

    // Build staff rows
    const staffRows = staffVenues.map(sv => {
      const days = dayStrings.map(dateStr => {
        const key = `${sv.staffId}:${sv.venueId}:${dateStr}`
        const sales = salesIndex.get(key) || { count: 0, amount: 0 }
        return { date: dateStr, salesCount: sales.count, salesAmount: sales.amount }
      })

      const totalSales = days.reduce((sum, d) => sum + d.salesAmount, 0)
      const totalCount = days.reduce((sum, d) => sum + d.salesCount, 0)
      const workingDays = days.filter(d => d.salesCount > 0).length
      const avgDailySales = workingDays > 0 ? totalSales / workingDays : 0

      return {
        staffId: sv.staffId,
        staffName: sv.staffName,
        staffEmployeeCode: sv.staffEmployeeCode,
        venueId: sv.venueId,
        venueName: sv.venueName,
        venueState: sv.venueState,
        days,
        totalSales,
        totalCount,
        avgDailySales,
      }
    })

    // Summary by day
    const byDay = dayStrings.map(dateStr => {
      let totalCount = 0
      let totalAmount = 0
      for (const row of staffRows) {
        const day = row.days.find(d => d.date === dateStr)
        if (day) {
          totalCount += day.salesCount
          totalAmount += day.salesAmount
        }
      }
      return { date: dateStr, totalCount, totalAmount }
    })

    // Summary by venue
    const venueMap = new Map<
      string,
      { venueId: string; venueName: string; total: number; byDay: Array<{ date: string; totalCount: number; totalAmount: number }> }
    >()
    for (const row of staffRows) {
      if (!venueMap.has(row.venueId)) {
        venueMap.set(row.venueId, {
          venueId: row.venueId,
          venueName: row.venueName,
          total: 0,
          byDay: dayStrings.map(d => ({ date: d, totalCount: 0, totalAmount: 0 })),
        })
      }
      const venue = venueMap.get(row.venueId)!
      venue.total += row.totalSales
      for (const day of row.days) {
        const vDay = venue.byDay.find(vd => vd.date === day.date)
        if (vDay) {
          vDay.totalCount += day.salesCount
          vDay.totalAmount += day.salesAmount
        }
      }
    }

    return {
      staff: staffRows,
      summary: {
        byDay,
        byVenue: Array.from(venueMap.values()),
      },
    }
  }
  // ==========================================================================
  // ORG ATTENDANCE CONFIG (9 individual columns — backward compat for PlayTelecom)
  // ==========================================================================

  async getOrgAttendanceConfig(orgId: string) {
    return prisma.organizationAttendanceConfig.findUnique({
      where: { organizationId: orgId },
    })
  }

  async upsertOrgAttendanceConfig(
    orgId: string,
    data: {
      expectedCheckInTime?: string
      latenessThresholdMinutes?: number
      geofenceRadiusMeters?: number
      attendanceTracking?: boolean
      requireFacadePhoto?: boolean
      requireDepositPhoto?: boolean
      enableCashPayments?: boolean
      enableCardPayments?: boolean
      enableBarcodeScanner?: boolean
      trackPromoterLocation?: boolean
      promoterLocationStartHour?: number
      promoterLocationEndHour?: number
    },
  ) {
    // Venue-local capture window for promoter geolocation pings. start inclusive,
    // end exclusive, 0/24 = full 24h. Validate whichever of the pair is provided —
    // a partial update still needs a sane resulting window, so we validate each
    // bound independently and the ordering only when both happen to be present.
    if (data.promoterLocationStartHour !== undefined) {
      if (!Number.isInteger(data.promoterLocationStartHour) || data.promoterLocationStartHour < 0 || data.promoterLocationStartHour > 23) {
        throw new BadRequestError('El horario de captura no es válido (inicio 0–23, fin 1–24, inicio < fin)')
      }
    }
    if (data.promoterLocationEndHour !== undefined) {
      if (!Number.isInteger(data.promoterLocationEndHour) || data.promoterLocationEndHour < 1 || data.promoterLocationEndHour > 24) {
        throw new BadRequestError('El horario de captura no es válido (inicio 0–23, fin 1–24, inicio < fin)')
      }
    }
    if (data.promoterLocationStartHour !== undefined && data.promoterLocationEndHour !== undefined) {
      if (data.promoterLocationStartHour >= data.promoterLocationEndHour) {
        throw new BadRequestError('El horario de captura no es válido (inicio 0–23, fin 1–24, inicio < fin)')
      }
    }

    // Also sync individual columns → settings JSON for consistency
    const existing = await prisma.organizationAttendanceConfig.findUnique({
      where: { organizationId: orgId },
      select: { settings: true },
    })
    const existingSettings = (existing?.settings as Record<string, any>) || {}
    const settingsSync: Record<string, any> = { ...existingSettings }

    if (data.attendanceTracking !== undefined) {
      settingsSync.attendanceTracking = data.attendanceTracking
      settingsSync.requireClockInPhoto = data.attendanceTracking
      settingsSync.requireClockInToLogin = data.attendanceTracking
    }
    if (data.requireFacadePhoto !== undefined) settingsSync.requireFacadePhoto = data.requireFacadePhoto
    if (data.requireDepositPhoto !== undefined) settingsSync.requireDepositPhoto = data.requireDepositPhoto
    if (data.enableCashPayments !== undefined) settingsSync.enableCashPayments = data.enableCashPayments
    if (data.enableCardPayments !== undefined) settingsSync.enableCardPayments = data.enableCardPayments
    if (data.enableBarcodeScanner !== undefined) settingsSync.enableBarcodeScanner = data.enableBarcodeScanner
    if (data.trackPromoterLocation !== undefined) settingsSync.trackPromoterLocation = data.trackPromoterLocation
    if (data.promoterLocationStartHour !== undefined) settingsSync.promoterLocationStartHour = data.promoterLocationStartHour
    if (data.promoterLocationEndHour !== undefined) settingsSync.promoterLocationEndHour = data.promoterLocationEndHour

    const config = await prisma.organizationAttendanceConfig.upsert({
      where: { organizationId: orgId },
      create: {
        organizationId: orgId,
        ...data,
        settings: settingsSync,
      },
      update: {
        ...data,
        settings: settingsSync,
      },
    })

    // Cambaceo is the ONE set of org defaults that cascade PHYSICALLY: the promoter-ping
    // gate (recordPromoterPing) reads VenueSettings.trackPromoterLocation with no org
    // fallback, and the TPV self-gates its capture window off VenueSettings.promoterLocation{Start,End}Hour
    // (via getTerminalConfig) with no org fallback either — so saving any of the 3 fields
    // here must propagate to every venue's VenueSettings row.
    const cascadeData: { trackPromoterLocation?: boolean; promoterLocationStartHour?: number; promoterLocationEndHour?: number } = {}
    if (data.trackPromoterLocation !== undefined) cascadeData.trackPromoterLocation = data.trackPromoterLocation
    if (data.promoterLocationStartHour !== undefined) cascadeData.promoterLocationStartHour = data.promoterLocationStartHour
    if (data.promoterLocationEndHour !== undefined) cascadeData.promoterLocationEndHour = data.promoterLocationEndHour

    if (Object.keys(cascadeData).length > 0) {
      const venues = await prisma.venue.findMany({
        where: { organizationId: orgId },
        select: { id: true },
      })
      const venueIds = venues.map(v => v.id)
      if (venueIds.length > 0) {
        await prisma.venueSettings.updateMany({
          where: { venueId: { in: venueIds } },
          data: cascadeData,
        })
        const existingVs = await prisma.venueSettings.findMany({
          where: { venueId: { in: venueIds } },
          select: { venueId: true },
        })
        const have = new Set(existingVs.map(v => v.venueId))
        const missing = venueIds.filter(id => !have.has(id))
        if (missing.length > 0) {
          await prisma.venueSettings.createMany({
            data: missing.map(venueId => ({ venueId, ...cascadeData })),
          })
        }
      }
    }

    logAction({
      action: 'ORG_ATTENDANCE_CONFIG_UPDATED',
      entity: 'OrganizationAttendanceConfig',
      entityId: config.id,
      data: { changes: Object.keys(data) },
    })

    return config
  }

  // ==========================================================================
  // ORG PROMOTER-LOCATION SETTINGS (per-venue capture flag + window, org-scoped)
  // ==========================================================================

  /**
   * Per-venue promoter geolocation tracking settings for the org OWNER's
   * "capture window" screen. LEFT JOIN semantics: a venue with no VenueSettings
   * row yet reports the schema defaults (false / 11 / 18), never null/undefined.
   */
  async getOrgPromoterLocationSettings(orgId: string) {
    const venues = await prisma.venue.findMany({
      where: { organizationId: orgId },
      select: {
        id: true,
        name: true,
        settings: {
          select: { trackPromoterLocation: true, promoterLocationStartHour: true, promoterLocationEndHour: true },
        },
      },
      orderBy: { name: 'asc' },
    })

    return {
      venues: venues.map(v => ({
        venueId: v.id,
        name: v.name,
        trackPromoterLocation: v.settings?.trackPromoterLocation ?? false,
        promoterLocationStartHour: v.settings?.promoterLocationStartHour ?? 11,
        promoterLocationEndHour: v.settings?.promoterLocationEndHour ?? 18,
      })),
    }
  }

  /**
   * Org-scoped per-venue override: lets the org OWNER carve out one venue from
   * the org default cascade (e.g. a store with different opening hours).
   * Validates the venue belongs to the org, validates the window the same way
   * as the org-level default, then upserts only the provided fields.
   */
  async updateVenuePromoterLocationSettings(
    orgId: string,
    venueId: string,
    data: { trackPromoterLocation?: boolean; promoterLocationStartHour?: number; promoterLocationEndHour?: number },
  ) {
    const venue = await prisma.venue.findFirst({
      where: { id: venueId, organizationId: orgId },
      select: { id: true },
    })
    if (!venue) {
      throw new NotFoundError('El venue no pertenece a esta organización')
    }

    if (data.promoterLocationStartHour !== undefined) {
      if (!Number.isInteger(data.promoterLocationStartHour) || data.promoterLocationStartHour < 0 || data.promoterLocationStartHour > 23) {
        throw new BadRequestError('El horario de captura no es válido (inicio 0–23, fin 1–24, inicio < fin)')
      }
    }
    if (data.promoterLocationEndHour !== undefined) {
      if (!Number.isInteger(data.promoterLocationEndHour) || data.promoterLocationEndHour < 1 || data.promoterLocationEndHour > 24) {
        throw new BadRequestError('El horario de captura no es válido (inicio 0–23, fin 1–24, inicio < fin)')
      }
    }
    if (data.promoterLocationStartHour !== undefined && data.promoterLocationEndHour !== undefined) {
      if (data.promoterLocationStartHour >= data.promoterLocationEndHour) {
        throw new BadRequestError('El horario de captura no es válido (inicio 0–23, fin 1–24, inicio < fin)')
      }
    }

    const updated = await prisma.venueSettings.upsert({
      where: { venueId },
      create: { venueId, ...data },
      update: { ...data },
      select: { venueId: true, trackPromoterLocation: true, promoterLocationStartHour: true, promoterLocationEndHour: true },
    })

    logAction({
      action: 'VENUE_PROMOTER_LOCATION_SETTINGS_UPDATED',
      entity: 'VenueSettings',
      entityId: venueId,
      data: { orgId, changes: Object.keys(data) },
    })

    return updated
  }

  async deleteOrgAttendanceConfig(orgId: string) {
    await prisma.organizationAttendanceConfig.deleteMany({
      where: { organizationId: orgId },
    })

    logAction({
      action: 'ORG_ATTENDANCE_CONFIG_DELETED',
      entity: 'OrganizationAttendanceConfig',
    })
  }

  // ==========================================================================
  // ORG TPV DEFAULTS (full TpvSettings JSON — all 35 fields)
  // ==========================================================================

  /**
   * Get org-level TPV defaults (full settings JSON)
   */
  async getOrgTpvDefaults(orgId: string) {
    const config = await prisma.organizationAttendanceConfig.findUnique({
      where: { organizationId: orgId },
      select: { settings: true },
    })
    return (config?.settings as Record<string, any>) || null
  }

  /**
   * Save org-level TPV defaults and push to ALL terminals in the org.
   * This overwrites terminal settings with the merged result (system defaults + org defaults).
   * kioskDefaultMerchantId is preserved per-terminal (not overwritten by org push).
   */
  async upsertOrgTpvDefaults(
    orgId: string,
    settings: Record<string, any>,
  ): Promise<{ config: Record<string, any>; terminalsUpdated: number }> {
    // 1. Get existing settings to merge
    const existing = await prisma.organizationAttendanceConfig.findUnique({
      where: { organizationId: orgId },
      select: { settings: true },
    })
    const existingSettings = (existing?.settings as Record<string, any>) || {}
    const mergedSettings = { ...existingSettings, ...settings }

    // 2. Sync attendance-related fields: attendanceTracking → requireClockInPhoto + requireClockInToLogin
    if (settings.attendanceTracking !== undefined) {
      mergedSettings.requireClockInPhoto = settings.attendanceTracking
      mergedSettings.requireClockInToLogin = settings.attendanceTracking
    }

    // 3. Sync individual columns for backward compatibility (PlayTelecom reads these)
    const columnSync: Record<string, any> = {}
    if (mergedSettings.attendanceTracking !== undefined) columnSync.attendanceTracking = Boolean(mergedSettings.attendanceTracking)
    if (mergedSettings.requireFacadePhoto !== undefined) columnSync.requireFacadePhoto = Boolean(mergedSettings.requireFacadePhoto)
    if (mergedSettings.requireDepositPhoto !== undefined) columnSync.requireDepositPhoto = Boolean(mergedSettings.requireDepositPhoto)
    if (mergedSettings.enableCashPayments !== undefined) columnSync.enableCashPayments = Boolean(mergedSettings.enableCashPayments)
    if (mergedSettings.enableCardPayments !== undefined) columnSync.enableCardPayments = Boolean(mergedSettings.enableCardPayments)
    if (mergedSettings.enableBarcodeScanner !== undefined) columnSync.enableBarcodeScanner = Boolean(mergedSettings.enableBarcodeScanner)
    if (mergedSettings.expectedCheckInTime !== undefined) columnSync.expectedCheckInTime = String(mergedSettings.expectedCheckInTime)
    if (mergedSettings.latenessThresholdMinutes !== undefined)
      columnSync.latenessThresholdMinutes = Number(mergedSettings.latenessThresholdMinutes)
    if (mergedSettings.geofenceRadiusMeters !== undefined) columnSync.geofenceRadiusMeters = Number(mergedSettings.geofenceRadiusMeters)

    // 4. Upsert the org config
    await prisma.organizationAttendanceConfig.upsert({
      where: { organizationId: orgId },
      create: {
        organizationId: orgId,
        settings: mergedSettings,
        ...columnSync,
      },
      update: {
        settings: mergedSettings,
        ...columnSync,
      },
    })

    // 5. Push to all terminals in the org (cascade: orgDefaults + per-terminal overrides)
    const terminals = await prisma.terminal.findMany({
      where: { venue: { organizationId: orgId } },
      select: { id: true, config: true, configOverrides: true },
    })

    if (terminals.length > 0) {
      const BATCH_SIZE = 50
      for (let i = 0; i < terminals.length; i += BATCH_SIZE) {
        const batch = terminals.slice(i, i + BATCH_SIZE)
        await prisma.$transaction(
          batch.map(terminal => {
            const existingConfig = (terminal.config as Record<string, any>) || {}
            const overrides = (terminal.configOverrides as Record<string, any>) || {}

            // Cascade merge: org defaults → per-terminal overrides
            // Terminals with no overrides (null) get full org defaults
            // Terminals with overrides keep their customized fields
            const pushSettings = {
              ...mergedSettings,
              ...overrides,
              // kioskDefaultMerchantId is always per-terminal (from overrides or existing)
              kioskDefaultMerchantId:
                overrides.kioskDefaultMerchantId ?? (existingConfig.settings as Record<string, any>)?.kioskDefaultMerchantId ?? null,
            }

            return prisma.terminal.update({
              where: { id: terminal.id },
              data: {
                config: { ...existingConfig, settings: pushSettings },
                updatedAt: new Date(),
              },
            })
          }),
        )
      }
    }

    logAction({
      action: 'ORG_TPV_DEFAULTS_UPDATED',
      entity: 'OrganizationAttendanceConfig',
      data: { settingsKeys: Object.keys(settings), terminalsUpdated: terminals.length },
    })

    return { config: mergedSettings, terminalsUpdated: terminals.length }
  }

  /**
   * Get stats: how many terminals per venue, total in org
   */
  /**
   * Get all terminals across organization venues with filters and pagination.
   * Read-only view for org-level terminal fleet monitoring.
   */
  async getOrgTerminals(
    orgId: string,
    filters?: {
      page?: number
      pageSize?: number
      venueIds?: string[]
      statuses?: string[]
      types?: string[]
      versionStatuses?: string[]
      search?: string
      sortBy?: string
      sortOrder?: 'asc' | 'desc'
    },
  ) {
    const page = filters?.page || 1
    const pageSize = filters?.pageSize || 20
    const skip = (page - 1) * pageSize

    // Get all venue IDs in the organization
    const venues = await prisma.venue.findMany({
      where: { organizationId: orgId, status: 'ACTIVE' },
      select: { id: true },
    })
    const venueIds = venues.map(v => v.id)

    if (venueIds.length === 0) {
      return {
        terminals: [],
        pagination: { page, pageSize, total: 0, totalPages: 0 },
        summary: { total: 0, online: 0, offline: 0, byStatus: {}, byType: {}, latestVersion: null as string | null },
      }
    }

    // Latest version = highest version string present across the org's terminal
    // fleet. Self-contained reference (no config): a terminal is "outdated" once
    // any sibling reports a newer version.
    const versionRows = await prisma.terminal.findMany({
      where: { venueId: { in: venueIds }, version: { not: null } },
      select: { version: true },
      distinct: ['version'],
    })
    const latestVersion = versionRows
      .map(r => r.version as string)
      .reduce<string | null>((max, v) => (max == null || compareVersions(v, max) > 0 ? v : max), null)

    // Build where clause. Venue filter is intersected with org venue scope.
    const requestedVenueIds = (filters?.venueIds ?? []).filter(id => venueIds.includes(id))
    const where: Prisma.TerminalWhereInput = {
      venueId: requestedVenueIds.length > 0 ? { in: requestedVenueIds } : { in: venueIds },
    }

    if (filters?.statuses && filters.statuses.length > 0) {
      where.status = { in: filters.statuses as any }
    }

    if (filters?.types && filters.types.length > 0) {
      where.type = { in: filters.types as any }
    }

    // Version status filter: upToDate | outdated | unknown. Combined via AND so
    // it composes with the search OR group without colliding.
    const versionStatuses = (filters?.versionStatuses ?? []).filter(s => ['upToDate', 'outdated', 'unknown'].includes(s))
    if (versionStatuses.length > 0 && versionStatuses.length < 3) {
      const versionOr: Prisma.TerminalWhereInput[] = []
      for (const status of versionStatuses) {
        if (status === 'unknown') {
          versionOr.push({ version: null })
        } else if (status === 'upToDate' && latestVersion) {
          versionOr.push({ version: latestVersion })
        } else if (status === 'outdated' && latestVersion) {
          versionOr.push({ AND: [{ version: { not: null } }, { version: { not: latestVersion } }] })
        }
      }
      // If only upToDate/outdated were requested but no fleet version exists,
      // versionOr is empty → return nothing (matches "no terminal qualifies").
      where.AND = [{ OR: versionOr.length > 0 ? versionOr : [{ id: '__none__' }] }]
    }

    if (filters?.search) {
      const q = filters.search
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { serialNumber: { contains: q, mode: 'insensitive' } },
        { brand: { contains: q, mode: 'insensitive' } },
        { model: { contains: q, mode: 'insensitive' } },
        { venue: { name: { contains: q, mode: 'insensitive' } } },
      ]
    }

    // Sort: whitelist accepted columns. Default = lastHeartbeat desc.
    // venue.name uses Prisma's nested relation orderBy. Nullable scalar fields
    // accept the { sort, nulls } object form; NON-nullable fields (enums and
    // required scalars) must use the plain 'asc' | 'desc' string — Prisma
    // rejects the object form on them with "Expected SortOrder, provided Object".
    const sortOrder: 'asc' | 'desc' = filters?.sortOrder === 'asc' ? 'asc' : 'desc'
    const sortByRaw = filters?.sortBy ?? 'lastHeartbeat'
    const NULLABLE_SORTS = new Set(['lastHeartbeat', 'brand', 'latestHealthScore'])
    const NON_NULLABLE_SORTS = new Set(['name', 'status', 'type', 'createdAt'])
    let orderBy: Prisma.TerminalOrderByWithRelationInput
    if (sortByRaw === 'venue.name') {
      orderBy = { venue: { name: sortOrder } }
    } else if (NULLABLE_SORTS.has(sortByRaw)) {
      orderBy = { [sortByRaw]: { sort: sortOrder, nulls: 'last' } } as Prisma.TerminalOrderByWithRelationInput
    } else if (NON_NULLABLE_SORTS.has(sortByRaw)) {
      orderBy = { [sortByRaw]: sortOrder } as Prisma.TerminalOrderByWithRelationInput
    } else {
      orderBy = { lastHeartbeat: { sort: 'desc', nulls: 'last' } }
    }

    // Fetch terminals + count in parallel
    const [terminals, total] = await prisma.$transaction([
      prisma.terminal.findMany({
        where,
        include: {
          venue: { select: { id: true, name: true, slug: true } },
        },
        orderBy,
        skip,
        take: pageSize,
      }),
      prisma.terminal.count({ where }),
    ])

    // ---------------------------------------------------------------------------
    // Migration badge ("Migrando…") — mirrors getAllTerminals (superadmin list).
    // ---------------------------------------------------------------------------
    // One batched query (no N+1) for the in-flight migration FACTORY_RESET commands
    // of the terminals on this page. A migration wipe never ACKs (it lingers until
    // it EXPIRES), so we filter in-flight statuses + not-expired, keep only the
    // latest such command per terminal whose payload carries a `migration` object,
    // and compute `inProgress` from the device's post-wipe rebound timestamp via
    // the shared computeTerminalMigration helper.
    const pageTerminalIds = terminals.map(t => t.id)
    const latestMigrationByTerminal = new Map<string, MigrationCommandLike>()

    if (pageTerminalIds.length > 0) {
      const migrationCommands = await prisma.tpvCommandQueue.findMany({
        where: {
          terminalId: { in: pageTerminalIds },
          commandType: 'FACTORY_RESET',
          status: { in: ['PENDING', 'QUEUED', 'SENT', 'RECEIVED', 'EXECUTING'] },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { id: true, terminalId: true, createdAt: true, payload: true },
        orderBy: { createdAt: 'desc' },
      })

      for (const cmd of migrationCommands) {
        if (latestMigrationByTerminal.has(cmd.terminalId)) continue
        if (!(cmd.payload as any)?.migration) continue
        latestMigrationByTerminal.set(cmd.terminalId, cmd)
      }
    }

    // Summary stats (all terminals in org, unfiltered by search/pagination)
    const allWhere: Prisma.TerminalWhereInput = { venueId: { in: venueIds } }
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000)

    const [allTerminals, onlineCount] = await prisma.$transaction([
      prisma.terminal.groupBy({
        by: ['status', 'type'],
        where: allWhere,
        orderBy: { status: 'asc' },
        _count: true,
      }),
      prisma.terminal.count({
        where: { ...allWhere, lastHeartbeat: { gte: fiveMinAgo } },
      }),
    ])

    const totalAll = allTerminals.reduce((sum, g) => sum + (typeof g._count === 'number' ? g._count : 0), 0)

    const byStatus: Record<string, number> = {}
    const byType: Record<string, number> = {}
    for (const g of allTerminals) {
      const count = typeof g._count === 'number' ? g._count : 0
      byStatus[g.status] = (byStatus[g.status] || 0) + count
      byType[g.type] = (byType[g.type] || 0) + count
    }

    return {
      terminals: terminals.map(t => ({
        id: t.id,
        name: t.name,
        serialNumber: t.serialNumber,
        type: t.type,
        status: t.status,
        brand: t.brand,
        model: t.model,
        version: t.version,
        lastHeartbeat: t.lastHeartbeat,
        ipAddress: t.ipAddress,
        healthScore: (t as any).latestHealthScore ?? null,
        isLocked: (t as any).isLocked ?? false,
        assignedMerchantIds: (t as any).assignedMerchantIds ?? [],
        activatedAt: (t as any).activatedAt ?? null,
        activationCode: (t as any).activationCode ?? null,
        activationCodeExpiry: (t as any).activationCodeExpiry ?? null,
        // El identificador que el propio aparato reporta (`X-Device-Id`), no el serial impreso.
        // Es lo que ata una terminal a sus SESIONES, y por tanto lo que permite «sacar esta
        // tablet»: una PAX se identifica por serial, pero una tablet Android sólo por esto.
        deviceUid: (t as any).deviceUid ?? null,
        venue: t.venue,
        migration: computeTerminalMigration(latestMigrationByTerminal.get(t.id), (t as any).lastActivationStatusCheckAt ?? null),
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
      summary: {
        total: totalAll,
        online: onlineCount,
        offline: totalAll - onlineCount,
        byStatus,
        byType,
        latestVersion,
      },
    }
  }

  async getOrgTpvStats(orgId: string) {
    const venues = await prisma.venue.findMany({
      where: { organizationId: orgId },
      select: {
        id: true,
        name: true,
        slug: true,
        _count: { select: { terminals: true } },
      },
    })

    const totalTerminals = venues.reduce((sum, v) => sum + v._count.terminals, 0)

    return {
      totalTerminals,
      venues: venues.map(v => ({
        id: v.id,
        name: v.name,
        slug: v.slug,
        terminalCount: v._count.terminals,
      })),
    }
  }
}

export const organizationDashboardService = new OrganizationDashboardService()
