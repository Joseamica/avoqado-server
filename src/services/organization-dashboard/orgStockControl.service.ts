import prisma from '../../utils/prismaClient'
import { utcTs } from '../../utils/sqlDates'
import { Prisma } from '@prisma/client'
import type {
  OrgStockBulkGroup,
  OrgStockBulkGroupsPage,
  OrgStockBulkGroupsPageOptions,
  OrgStockCategoriaAggregate,
  OrgStockCustodyPage,
  OrgStockCustodyPageOptions,
  OrgStockLastActivity,
  OrgStockItemsPage,
  OrgStockItemsPageOptions,
  OrgStockOverview,
  OrgStockOverviewItem,
  OrgStockOverviewOptions,
  OrgStockSucursalAggregate,
  OrgStockSummary,
  OrgStockSummaryData,
} from './orgStockControl.types'

const BULK_WINDOW_MS = 2 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Tope duro de `items` del overview LEGACY (`/stock-control/overview`). El query-guard
 * lo cazó en producción el 2026-09-01: 20,288 SIMs de PlayTelecom con 6 relaciones,
 * 92 veces en 6 h, y disparó «Server congelado ≥3 s». El dashboard ya usa los endpoints
 * paginados; este sólo lo llaman pestañas viejas sin recargar — y mientras existan, no
 * pueden tumbar el server. Los totales siguen saliendo de SQL sobre TODA la organización.
 */
export const LEGACY_OVERVIEW_ITEMS_CAP = 500

function numeric(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  return Number(value ?? 0)
}

function percentage(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 10000) / 100 : 0
}

export class OrgStockControlService {
  /**
   * Paginated operational view for the venue-level custody panel. The actor's
   * complete counters and promoter ranking are calculated with GROUP BY/count;
   * only the requested SIM rows are hydrated.
   */
  async getOrgCustodyPage(
    orgId: string,
    actorStaffId: string,
    options: OrgStockCustodyPageOptions,
    now: Date = new Date(),
  ): Promise<OrgStockCustodyPage> {
    const page = Math.max(1, Math.floor(options.page))
    const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize)))
    const search = options.search?.trim()
    const managedMemberships = await prisma.staffVenue.findMany({
      where: {
        staffId: actorStaffId,
        role: { in: ['MANAGER', 'ADMIN', 'OWNER'] },
        venue: { organizationId: orgId },
      },
      select: { venueId: true },
      take: 10_000,
    })
    const managedVenueIds = new Set<string>()
    if (options.targetVenueId) managedVenueIds.add(options.targetVenueId)
    for (const membership of managedMemberships) managedVenueIds.add(membership.venueId)

    const responsibilityScope: Prisma.SerializedItemWhereInput[] = [{ assignedSupervisorId: actorStaffId }]
    if (managedVenueIds.size > 0) {
      responsibilityScope.push({
        registeredFromVenueId: { in: Array.from(managedVenueIds) },
        assignedPromoterId: { not: null },
      })
    }
    const baseWhere: Prisma.SerializedItemWhereInput = {
      organizationId: orgId,
      ...(options.dateFrom || options.dateTo
        ? {
            createdAt: {
              ...(options.dateFrom && { gte: options.dateFrom }),
              ...(options.dateTo && { lte: options.dateTo }),
            },
          }
        : {}),
      OR: responsibilityScope,
    }

    const stuckCutoff = new Date(now.getTime() - 7 * DAY_MS)
    const stuckWhere: Prisma.SerializedItemWhereInput = {
      AND: [
        baseWhere,
        { status: { not: 'SOLD' }, custodyState: { in: ['PROMOTER_PENDING', 'PROMOTER_HELD'] } },
        {
          OR: [{ promoterAcceptedAt: { lt: stuckCutoff } }, { promoterAcceptedAt: null, createdAt: { lt: stuckCutoff } }],
        },
      ],
    }

    const filterWhere: Partial<Prisma.SerializedItemWhereInput> =
      options.filter === 'almacen'
        ? { custodyState: 'SUPERVISOR_HELD' }
        : options.filter === 'pendientes'
          ? { custodyState: 'PROMOTER_PENDING' }
          : options.filter === 'aceptados'
            ? { custodyState: 'PROMOTER_HELD' }
            : options.filter === 'rechazados'
              ? { custodyState: 'PROMOTER_REJECTED' }
              : options.filter === 'vendidos'
                ? { status: 'SOLD' }
                : {}
    const searchWhere: Prisma.SerializedItemWhereInput = search ? { serialNumber: { contains: search } } : {}
    const itemWhere: Prisma.SerializedItemWhereInput =
      options.filter === 'estancados' ? { AND: [stuckWhere, searchWhere] } : { ...baseWhere, ...filterWhere, ...searchWhere }

    const [grouped, stuckCount, total, items] = await Promise.all([
      prisma.serializedItem.groupBy({
        by: ['status', 'custodyState', 'assignedPromoterId'],
        where: baseWhere,
        _count: { _all: true },
      }),
      prisma.serializedItem.count({ where: stuckWhere }),
      prisma.serializedItem.count({ where: itemWhere }),
      prisma.serializedItem.findMany({
        where: itemWhere,
        include: {
          category: { select: { id: true, name: true } },
          venue: { select: { id: true, name: true } },
          sellingVenue: { select: { id: true, name: true } },
          registeredFromVenue: { select: { id: true, name: true } },
          assignedSupervisor: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
          assignedPromoter: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])

    const summary = { total: 0, almacen: 0, pendientes: 0, aceptados: 0, rechazados: 0, vendidos: 0, estancados: stuckCount }
    const promoterCounts = new Map<string, { pending: number; held: number; sold: number }>()
    for (const row of grouped) {
      const count = row._count._all
      summary.total += count
      if (row.status === 'SOLD') summary.vendidos += count
      else if (row.custodyState === 'SUPERVISOR_HELD') summary.almacen += count
      else if (row.custodyState === 'PROMOTER_PENDING') summary.pendientes += count
      else if (row.custodyState === 'PROMOTER_HELD') summary.aceptados += count
      else if (row.custodyState === 'PROMOTER_REJECTED') summary.rechazados += count

      if (row.assignedPromoterId) {
        const current = promoterCounts.get(row.assignedPromoterId) ?? { pending: 0, held: 0, sold: 0 }
        if (row.status === 'SOLD') current.sold += count
        else if (row.custodyState === 'PROMOTER_PENDING') current.pending += count
        else if (row.custodyState === 'PROMOTER_HELD') current.held += count
        promoterCounts.set(row.assignedPromoterId, current)
      }
    }

    const createdByIds = items.map(item => item.createdBy).filter((id): id is string => Boolean(id))
    const staffIds = Array.from(new Set([...createdByIds, ...promoterCounts.keys()]))
    const staffMap = new Map<string, string>()
    const employeeCodeMap = new Map<string, string | null>()
    if (staffIds.length > 0) {
      const staff = await prisma.staff.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, firstName: true, lastName: true, employeeCode: true },
        take: staffIds.length,
      })
      for (const member of staff) {
        staffMap.set(member.id, `${member.firstName ?? ''} ${member.lastName ?? ''}`.trim())
        employeeCodeMap.set(member.id, member.employeeCode ?? null)
      }
    }

    const promoterRanking = Array.from(promoterCounts, ([id, counts]) => ({
      id,
      name: staffMap.get(id) ?? 'Promotor desconocido',
      ...counts,
    })).sort((a, b) => b.pending + b.held + b.sold - (a.pending + a.held + a.sold))

    return {
      summary,
      promoterRanking,
      items: items.map(item => this.serializeItem(item, staffMap, employeeCodeMap)),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    }
  }

  /** Paginated bulk-upload events. ICCID search happens inside each complete group. */
  async getOrgBulkGroupsPage(orgId: string, options: OrgStockBulkGroupsPageOptions): Promise<OrgStockBulkGroupsPage> {
    const page = Math.max(1, Math.floor(options.page))
    const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize)))
    const search = options.search?.replace(/[^A-Za-z0-9]/g, '').slice(0, 128)
    const conditions: Prisma.Sql[] = [Prisma.sql`si."organizationId" = ${orgId}`]
    if (options.dateFrom) conditions.push(Prisma.sql`si."createdAt" >= ${utcTs(options.dateFrom)}`)
    if (options.dateTo) conditions.push(Prisma.sql`si."createdAt" <= ${utcTs(options.dateTo)}`)
    if (options.categoryId) conditions.push(Prisma.sql`si."categoryId" = ${options.categoryId}`)
    if (options.registeredFromVenueId) {
      conditions.push(Prisma.sql`si."registeredFromVenueId" = ${options.registeredFromVenueId}`)
    }
    const whereSql = Prisma.join(conditions, ' AND ')
    const searchHaving = search ? Prisma.sql`HAVING BOOL_OR(si."serialNumber" ILIKE ${`%${search}%`})` : Prisma.empty

    type TotalRow = { total: unknown }
    type GroupRow = {
      id: string
      firstCreatedAt: Date | string
      lastCreatedAt: Date | string
      categoryId: string
      categoryName: string
      registeredFromVenueId: string | null
      registeredFromVenueName: string | null
      createdById: string | null
      createdByName: string | null
      createdByEmployeeCode: string | null
      itemCount: unknown
      serialNumberFirst: string
      serialNumberLast: string
      availableCount: unknown
      soldCount: unknown
      damagedCount: unknown
      returnedCount: unknown
    }

    const [totalRows, rows] = await Promise.all([
      prisma.$queryRaw<TotalRow[]>(Prisma.sql`
        WITH grouped AS (
          SELECT 1
          FROM "SerializedItem" si
          WHERE ${whereSql}
          GROUP BY si."createdBy", si."categoryId", si."registeredFromVenueId", FLOOR(EXTRACT(EPOCH FROM si."createdAt") / 120)
          ${searchHaving}
        )
        SELECT COUNT(*)::int AS "total" FROM grouped
      `),
      prisma.$queryRaw<GroupRow[]>(Prisma.sql`
        WITH grouped AS (
          SELECT
            'bulk-' || (ARRAY_AGG(si."id" ORDER BY si."createdAt" DESC, si."id" DESC))[1] AS "id",
            MIN(si."createdAt") AS "firstCreatedAt",
            MAX(si."createdAt") AS "lastCreatedAt",
            si."categoryId" AS "categoryId",
            si."registeredFromVenueId" AS "registeredFromVenueId",
            si."createdBy" AS "createdById",
            COUNT(*)::int AS "itemCount",
            MIN(si."serialNumber") AS "serialNumberFirst",
            MAX(si."serialNumber") AS "serialNumberLast",
            COUNT(*) FILTER (WHERE si."status" = 'AVAILABLE')::int AS "availableCount",
            COUNT(*) FILTER (WHERE si."status" = 'SOLD')::int AS "soldCount",
            COUNT(*) FILTER (WHERE si."status" = 'DAMAGED')::int AS "damagedCount",
            COUNT(*) FILTER (WHERE si."status" = 'RETURNED')::int AS "returnedCount"
          FROM "SerializedItem" si
          WHERE ${whereSql}
          GROUP BY si."createdBy", si."categoryId", si."registeredFromVenueId", FLOOR(EXTRACT(EPOCH FROM si."createdAt") / 120)
          ${searchHaving}
        )
        SELECT
          g.*,
          COALESCE(c."name", 'Sin categoría') AS "categoryName",
          v."name" AS "registeredFromVenueName",
          NULLIF(TRIM(CONCAT_WS(' ', s."firstName", s."lastName")), '') AS "createdByName",
          s."employeeCode" AS "createdByEmployeeCode"
        FROM grouped g
        LEFT JOIN "ItemCategory" c ON c."id" = g."categoryId"
        LEFT JOIN "Venue" v ON v."id" = g."registeredFromVenueId"
        LEFT JOIN "Staff" s ON s."id" = g."createdById"
        ORDER BY g."firstCreatedAt" DESC, g."id" DESC
        LIMIT ${pageSize}
        OFFSET ${(page - 1) * pageSize}
      `),
    ])

    const total = numeric(totalRows[0]?.total)
    return {
      groups: rows.map(row => ({
        id: row.id,
        firstCreatedAt: new Date(row.firstCreatedAt).toISOString(),
        lastCreatedAt: new Date(row.lastCreatedAt).toISOString(),
        categoryId: row.categoryId,
        categoryName: row.categoryName,
        registeredFromVenueId: row.registeredFromVenueId,
        registeredFromVenueName: row.registeredFromVenueName,
        createdById: row.createdById,
        createdByName: row.createdByName,
        createdByEmployeeCode: row.createdByEmployeeCode,
        itemCount: numeric(row.itemCount),
        serialNumberFirst: row.serialNumberFirst,
        serialNumberLast: row.serialNumberLast,
        availableCount: numeric(row.availableCount),
        soldCount: numeric(row.soldCount),
        damagedCount: numeric(row.damagedCount),
        returnedCount: numeric(row.returnedCount),
      })),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    }
  }

  /**
   * Small, exact dashboard summary backed by database aggregates. This is the
   * replacement for deriving cards/charts from the unbounded legacy overview.
   */
  async getOrgSummary(orgId: string, options: OrgStockOverviewOptions, now: Date = new Date()): Promise<OrgStockSummaryData> {
    const conditions: Prisma.Sql[] = [Prisma.sql`si."organizationId" = ${orgId}`]
    if (options.dateFrom) conditions.push(Prisma.sql`si."createdAt" >= ${utcTs(options.dateFrom)}`)
    if (options.dateTo) conditions.push(Prisma.sql`si."createdAt" <= ${utcTs(options.dateTo)}`)
    const whereSql = Prisma.join(conditions, ' AND ')

    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const days = Array.from({ length: 7 }, (_, index) => new Date(startOfToday.getTime() - (6 - index) * DAY_MS))

    type SummaryRow = {
      totalSims: unknown
      available: unknown
      sold: unknown
      damaged: unknown
      returned: unknown
      totalCargas: unknown
      sucursalesInvolucradas: unknown
      categoriasActivas: unknown
    }
    type VenueRow = {
      venueId: string
      venueName: string
      totalSims: unknown
      available: unknown
      sold: unknown
      damaged: unknown
      returned: unknown
      soldDay0: unknown
      soldDay1: unknown
      soldDay2: unknown
      soldDay3: unknown
      soldDay4: unknown
      soldDay5: unknown
      soldDay6: unknown
      lastActivity: Date | string | null
    }
    type CategoryRow = {
      categoryId: string
      categoryName: string
      totalSims: unknown
      available: unknown
      sold: unknown
      sucursalesConStock: unknown
    }

    const [summaryRows, venueRows, categoryRows, lastUpload, lastSale] = await Promise.all([
      prisma.$queryRaw<SummaryRow[]>(Prisma.sql`
        WITH filtered AS MATERIALIZED (
          SELECT si."status", si."categoryId", si."registeredFromVenueId", si."createdBy", si."createdAt"
          FROM "SerializedItem" si
          WHERE ${whereSql}
        ), bulk_groups AS (
          SELECT 1
          FROM filtered
          GROUP BY "createdBy", "categoryId", "registeredFromVenueId", FLOOR(EXTRACT(EPOCH FROM "createdAt") / 120)
        )
        SELECT
          COUNT(*)::int AS "totalSims",
          COUNT(*) FILTER (WHERE "status" = 'AVAILABLE')::int AS "available",
          COUNT(*) FILTER (WHERE "status" = 'SOLD')::int AS "sold",
          COUNT(*) FILTER (WHERE "status" = 'DAMAGED')::int AS "damaged",
          COUNT(*) FILTER (WHERE "status" = 'RETURNED')::int AS "returned",
          (SELECT COUNT(*)::int FROM bulk_groups) AS "totalCargas",
          COUNT(DISTINCT "registeredFromVenueId")::int AS "sucursalesInvolucradas",
          COUNT(DISTINCT "categoryId")::int AS "categoriasActivas"
        FROM filtered
      `),
      prisma.$queryRaw<VenueRow[]>(Prisma.sql`
        WITH filtered AS MATERIALIZED (
          SELECT si."status", si."registeredFromVenueId", si."createdAt", si."soldAt"
          FROM "SerializedItem" si
          WHERE ${whereSql}
        )
        SELECT
          COALESCE(f."registeredFromVenueId", '__unassigned__') AS "venueId",
          CASE
            WHEN f."registeredFromVenueId" IS NULL THEN 'Sin sucursal asignada'
            ELSE COALESCE(MAX(v."name"), 'Unknown')
          END AS "venueName",
          COUNT(*)::int AS "totalSims",
          COUNT(*) FILTER (WHERE f."status" = 'AVAILABLE')::int AS "available",
          COUNT(*) FILTER (WHERE f."status" = 'SOLD')::int AS "sold",
          COUNT(*) FILTER (WHERE f."status" = 'DAMAGED')::int AS "damaged",
          COUNT(*) FILTER (WHERE f."status" = 'RETURNED')::int AS "returned",
          COUNT(*) FILTER (WHERE f."status" = 'SOLD' AND f."soldAt" >= ${utcTs(days[0])} AND f."soldAt" < ${utcTs(days[1])})::int AS "soldDay0",
          COUNT(*) FILTER (WHERE f."status" = 'SOLD' AND f."soldAt" >= ${utcTs(days[1])} AND f."soldAt" < ${utcTs(days[2])})::int AS "soldDay1",
          COUNT(*) FILTER (WHERE f."status" = 'SOLD' AND f."soldAt" >= ${utcTs(days[2])} AND f."soldAt" < ${utcTs(days[3])})::int AS "soldDay2",
          COUNT(*) FILTER (WHERE f."status" = 'SOLD' AND f."soldAt" >= ${utcTs(days[3])} AND f."soldAt" < ${utcTs(days[4])})::int AS "soldDay3",
          COUNT(*) FILTER (WHERE f."status" = 'SOLD' AND f."soldAt" >= ${utcTs(days[4])} AND f."soldAt" < ${utcTs(days[5])})::int AS "soldDay4",
          COUNT(*) FILTER (WHERE f."status" = 'SOLD' AND f."soldAt" >= ${utcTs(days[5])} AND f."soldAt" < ${utcTs(days[6])})::int AS "soldDay5",
          COUNT(*) FILTER (WHERE f."status" = 'SOLD' AND f."soldAt" >= ${utcTs(days[6])})::int AS "soldDay6",
          GREATEST(MAX(f."createdAt"), MAX(f."soldAt")) AS "lastActivity"
        FROM filtered f
        LEFT JOIN "Venue" v ON v."id" = f."registeredFromVenueId"
        GROUP BY f."registeredFromVenueId"
        ORDER BY COUNT(*) DESC
      `),
      prisma.$queryRaw<CategoryRow[]>(Prisma.sql`
        WITH filtered AS MATERIALIZED (
          SELECT si."status", si."categoryId", si."registeredFromVenueId"
          FROM "SerializedItem" si
          WHERE ${whereSql}
        )
        SELECT
          f."categoryId" AS "categoryId",
          COALESCE(MAX(c."name"), 'Sin categoría') AS "categoryName",
          COUNT(*)::int AS "totalSims",
          COUNT(*) FILTER (WHERE f."status" = 'AVAILABLE')::int AS "available",
          COUNT(*) FILTER (WHERE f."status" = 'SOLD')::int AS "sold",
          COUNT(DISTINCT f."registeredFromVenueId") FILTER (WHERE f."status" = 'AVAILABLE')::int AS "sucursalesConStock"
        FROM filtered f
        LEFT JOIN "ItemCategory" c ON c."id" = f."categoryId"
        GROUP BY f."categoryId"
        ORDER BY COUNT(*) DESC
      `),
      prisma.serializedItem.findFirst({
        where: {
          organizationId: orgId,
          ...(options.dateFrom || options.dateTo
            ? { createdAt: { ...(options.dateFrom && { gte: options.dateFrom }), ...(options.dateTo && { lte: options.dateTo }) } }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, registeredFromVenue: { select: { name: true } } },
      }),
      prisma.serializedItem.findFirst({
        where: {
          organizationId: orgId,
          soldAt: { not: null },
          ...(options.dateFrom || options.dateTo
            ? { createdAt: { ...(options.dateFrom && { gte: options.dateFrom }), ...(options.dateTo && { lte: options.dateTo }) } }
            : {}),
        },
        orderBy: { soldAt: 'desc' },
        select: { soldAt: true, sellingVenue: { select: { name: true } } },
      }),
    ])

    const counts = summaryRows[0]
    const totalSims = numeric(counts?.totalSims)
    const sold = numeric(counts?.sold)
    const uploadAt = lastUpload?.createdAt ? new Date(lastUpload.createdAt) : null
    const saleAt = lastSale?.soldAt ? new Date(lastSale.soldAt) : null
    const useSale = Boolean(saleAt && (!uploadAt || saleAt.getTime() >= uploadAt.getTime()))

    return {
      summary: {
        totalSims,
        available: numeric(counts?.available),
        sold,
        damaged: numeric(counts?.damaged),
        returned: numeric(counts?.returned),
        rotacionPct: percentage(sold, totalSims),
        totalCargas: numeric(counts?.totalCargas),
        sucursalesInvolucradas: numeric(counts?.sucursalesInvolucradas),
        categoriasActivas: numeric(counts?.categoriasActivas),
        dateRange: {
          from: options.dateFrom?.toISOString() ?? new Date(0).toISOString(),
          to: options.dateTo?.toISOString() ?? now.toISOString(),
        },
        generatedAt: now.toISOString(),
        lastActivity: useSale
          ? { timestamp: saleAt!.toISOString(), venueName: lastSale?.sellingVenue?.name ?? 'Unknown', action: 'SALE' }
          : uploadAt
            ? { timestamp: uploadAt.toISOString(), venueName: lastUpload?.registeredFromVenue?.name ?? 'Unknown', action: 'UPLOAD' }
            : null,
      },
      aggregatesBySucursal: venueRows.map(row => {
        const venueTotal = numeric(row.totalSims)
        const venueSold = numeric(row.sold)
        return {
          venueId: row.venueId,
          venueName: row.venueName,
          totalSims: venueTotal,
          available: numeric(row.available),
          sold: venueSold,
          damaged: numeric(row.damaged),
          returned: numeric(row.returned),
          rotacionPct: percentage(venueSold, venueTotal),
          salesLast7Days: [row.soldDay0, row.soldDay1, row.soldDay2, row.soldDay3, row.soldDay4, row.soldDay5, row.soldDay6].map(numeric),
          lastActivity: row.lastActivity ? new Date(row.lastActivity).toISOString() : null,
        }
      }),
      aggregatesByCategoria: categoryRows.map(row => {
        const categoryTotal = numeric(row.totalSims)
        const categorySold = numeric(row.sold)
        return {
          categoryId: row.categoryId,
          categoryName: row.categoryName,
          totalSims: categoryTotal,
          available: numeric(row.available),
          sold: categorySold,
          rotacionPct: percentage(categorySold, categoryTotal),
          pctOfTotal: percentage(categoryTotal, totalSims),
          sucursalesConStock: numeric(row.sucursalesConStock),
          estimatedCoverageDays: null,
        }
      }),
    }
  }

  /**
   * Returns one bounded page of SIM detail. Totals and filtering stay on the
   * database side so organizations with large inventories do not materialize
   * every serialized item in the Node process.
   */
  async getOrgItemsPage(orgId: string, options: OrgStockItemsPageOptions): Promise<OrgStockItemsPage> {
    const page = Math.max(1, Math.floor(options.page))
    const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize)))
    const search = options.search?.trim()
    const dateFilter =
      options.dateFrom || options.dateTo
        ? {
            createdAt: {
              ...(options.dateFrom && { gte: options.dateFrom }),
              ...(options.dateTo && { lte: options.dateTo }),
            },
          }
        : {}
    const where = {
      organizationId: orgId,
      ...dateFilter,
      ...(search && { serialNumber: { contains: search } }),
      ...(options.status && { status: options.status }),
      ...(options.custodyStates?.length
        ? { custodyState: { in: options.custodyStates } }
        : options.custodyState
          ? { custodyState: options.custodyState }
          : {}),
      ...(options.categoryId && { categoryId: options.categoryId }),
      ...(options.registeredFromVenueId && { registeredFromVenueId: options.registeredFromVenueId }),
    }

    const [total, items] = await Promise.all([
      prisma.serializedItem.count({ where }),
      prisma.serializedItem.findMany({
        where,
        include: {
          category: { select: { id: true, name: true } },
          venue: { select: { id: true, name: true } },
          sellingVenue: { select: { id: true, name: true } },
          registeredFromVenue: { select: { id: true, name: true } },
          assignedSupervisor: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
          assignedPromoter: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])

    const staffIds = Array.from(new Set(items.map(item => item.createdBy).filter(Boolean))) as string[]
    const staffMap = new Map<string, string>()
    const employeeCodeMap = new Map<string, string | null>()
    if (staffIds.length > 0) {
      const staff = await prisma.staff.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, firstName: true, lastName: true, employeeCode: true },
        take: staffIds.length,
      })
      for (const member of staff) {
        staffMap.set(member.id, `${member.firstName ?? ''} ${member.lastName ?? ''}`.trim())
        employeeCodeMap.set(member.id, member.employeeCode ?? null)
      }
    }

    return {
      items: items.map(item => this.serializeItem(item, staffMap, employeeCodeMap)),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    }
  }

  private serializeItem(item: any, staffMap: Map<string, string>, employeeCodeMap: Map<string, string | null>): OrgStockOverviewItem {
    const supervisor = item.assignedSupervisor as
      | { id: string; firstName: string; lastName: string; employeeCode: string | null }
      | null
      | undefined
    const promoter = item.assignedPromoter as
      | { id: string; firstName: string; lastName: string; employeeCode: string | null }
      | null
      | undefined

    return {
      id: item.id,
      serialNumber: item.serialNumber,
      status: item.status,
      categoryId: item.categoryId,
      categoryName: item.category?.name ?? 'Sin categoría',
      createdAt: item.createdAt.toISOString(),
      soldAt: item.soldAt?.toISOString() ?? null,
      registeredFromVenueId: item.registeredFromVenueId ?? null,
      registeredFromVenueName: item.registeredFromVenue?.name ?? null,
      sellingVenueId: item.sellingVenueId ?? null,
      sellingVenueName: item.sellingVenue?.name ?? null,
      currentVenueId: item.venueId ?? null,
      currentVenueName: item.venue?.name ?? null,
      createdById: item.createdBy ?? null,
      createdByName: item.createdBy ? (staffMap.get(item.createdBy) ?? null) : null,
      createdByEmployeeCode: item.createdBy ? (employeeCodeMap.get(item.createdBy) ?? null) : null,
      custodyState: item.custodyState,
      assignedSupervisorId: item.assignedSupervisorId ?? null,
      assignedSupervisorName: supervisor ? `${supervisor.firstName} ${supervisor.lastName}`.trim() : null,
      assignedSupervisorEmployeeCode: supervisor?.employeeCode ?? null,
      assignedPromoterId: item.assignedPromoterId ?? null,
      assignedPromoterName: promoter ? `${promoter.firstName} ${promoter.lastName}`.trim() : null,
      assignedPromoterEmployeeCode: promoter?.employeeCode ?? null,
      promoterAcceptedAt: item.promoterAcceptedAt?.toISOString() ?? null,
      promoterRejectedAt: item.promoterRejectedAt?.toISOString() ?? null,
    }
  }

  /**
   * Fetches serialized items for an organization, optionally filtered by createdAt range.
   * Uses organizationId scope (bulk uploads are stored at org level with null venueId).
   */
  async fetchSerializedItems(orgId: string, options: OrgStockOverviewOptions, take: number = LEGACY_OVERVIEW_ITEMS_CAP) {
    const { dateFrom, dateTo } = options
    const dateFilter =
      dateFrom || dateTo
        ? {
            createdAt: {
              ...(dateFrom && { gte: dateFrom }),
              ...(dateTo && { lte: dateTo }),
            },
          }
        : {}

    return prisma.serializedItem.findMany({
      where: {
        organizationId: orgId,
        ...dateFilter,
      },
      include: {
        category: { select: { id: true, name: true } },
        venue: { select: { id: true, name: true } },
        sellingVenue: { select: { id: true, name: true } },
        registeredFromVenue: { select: { id: true, name: true } },
        // Chain-of-custody relations (plan §2.2) — powers the Supervisor /
        // Promoter columns in the Detalle SIMs table without extra queries.
        // `employeeCode` surfaces org-internal IDs (white-label orgs like
        // PlayTelecom assign these to their supervisors and promoters).
        assignedSupervisor: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
        assignedPromoter: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
    })
  }

  /**
   * Groups items into bulk upload events using a 2-minute window + same creator + category + origin venue.
   * Mirrors the logic in stockDashboard.service.getRecentMovements but adapted for org-level items.
   */
  groupByBulkUpload(items: any[], staffMap?: Map<string, string>, employeeCodeMap?: Map<string, string | null>): OrgStockBulkGroup[] {
    const groups = new Map<string, any[]>()

    for (const item of items) {
      const bucket = Math.floor(item.createdAt.getTime() / BULK_WINDOW_MS)
      const key = [item.createdBy ?? 'unknown', item.categoryId, item.registeredFromVenueId ?? '', bucket].join('|')
      const group = groups.get(key) ?? []
      group.push(item)
      groups.set(key, group)
    }

    const result: OrgStockBulkGroup[] = []
    for (const group of groups.values()) {
      const first = group[0]
      const sortedSerials = [...group.map(i => i.serialNumber)].sort()
      const times = group.map(i => i.createdAt.getTime())

      result.push({
        id: `bulk-${first.id}`,
        firstCreatedAt: new Date(Math.min(...times)).toISOString(),
        lastCreatedAt: new Date(Math.max(...times)).toISOString(),
        categoryId: first.categoryId,
        categoryName: first.category?.name ?? 'Sin categoría',
        registeredFromVenueId: first.registeredFromVenueId ?? null,
        registeredFromVenueName: first.registeredFromVenue?.name ?? null,
        createdById: first.createdBy ?? null,
        createdByName: first.createdBy && staffMap ? (staffMap.get(first.createdBy) ?? null) : null,
        createdByEmployeeCode: first.createdBy && employeeCodeMap ? (employeeCodeMap.get(first.createdBy) ?? null) : null,
        itemCount: group.length,
        serialNumberFirst: sortedSerials[0] ?? '',
        serialNumberLast: sortedSerials[sortedSerials.length - 1] ?? '',
        serialNumbers: sortedSerials,
        availableCount: group.filter(i => i.status === 'AVAILABLE').length,
        soldCount: group.filter(i => i.status === 'SOLD').length,
        damagedCount: group.filter(i => i.status === 'DAMAGED').length,
        returnedCount: group.filter(i => i.status === 'RETURNED').length,
      })
    }

    return result.sort((a, b) => b.firstCreatedAt.localeCompare(a.firstCreatedAt))
  }

  aggregateBySucursal(items: any[], now: Date = new Date()): OrgStockSucursalAggregate[] {
    const byVenue = new Map<string, any[]>()

    for (const item of items) {
      // Items without registeredFromVenueId get grouped under a synthetic "unassigned" key
      const key = item.registeredFromVenueId ?? '__unassigned__'
      const list = byVenue.get(key) ?? []
      list.push(item)
      byVenue.set(key, list)
    }

    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const result: OrgStockSucursalAggregate[] = []

    for (const [venueKey, venueItems] of byVenue.entries()) {
      const first = venueItems[0]
      const isUnassigned = venueKey === '__unassigned__'
      const venueId = isUnassigned ? '__unassigned__' : venueKey
      const sold = venueItems.filter(i => i.status === 'SOLD').length
      const available = venueItems.filter(i => i.status === 'AVAILABLE').length
      const damaged = venueItems.filter(i => i.status === 'DAMAGED').length
      const returned = venueItems.filter(i => i.status === 'RETURNED').length
      const total = venueItems.length

      // 7-day sparkline: index 0 = 6 days ago, index 6 = today
      const salesLast7Days = Array(7).fill(0)
      for (const item of venueItems) {
        if (item.status !== 'SOLD' || !item.soldAt) continue
        const soldTime = item.soldAt.getTime()
        const diffDays = Math.floor((startOfToday - soldTime) / DAY_MS)
        if (diffDays >= 0 && diffDays < 7) {
          salesLast7Days[6 - diffDays]++
        } else if (diffDays < 0) {
          salesLast7Days[6]++
        }
      }

      const times = venueItems.flatMap(i => [i.createdAt, i.soldAt].filter(Boolean)).map(d => d.getTime())
      const lastActivity = times.length > 0 ? new Date(Math.max(...times)).toISOString() : null

      result.push({
        venueId,
        venueName: isUnassigned ? 'Sin sucursal asignada' : (first.registeredFromVenue?.name ?? 'Unknown'),
        totalSims: total,
        available,
        sold,
        damaged,
        returned,
        rotacionPct: total > 0 ? Math.round((sold / total) * 10000) / 100 : 0,
        salesLast7Days,
        lastActivity,
      })
    }

    return result.sort((a, b) => b.totalSims - a.totalSims)
  }

  aggregateByCategoria(items: any[]): OrgStockCategoriaAggregate[] {
    const byCat = new Map<string, any[]>()

    for (const item of items) {
      const list = byCat.get(item.categoryId) ?? []
      list.push(item)
      byCat.set(item.categoryId, list)
    }

    const grandTotal = items.length
    const result: OrgStockCategoriaAggregate[] = []

    for (const [categoryId, catItems] of byCat.entries()) {
      const first = catItems[0]
      const sold = catItems.filter(i => i.status === 'SOLD').length
      const available = catItems.filter(i => i.status === 'AVAILABLE').length
      const total = catItems.length

      const sucursalesConStock = new Set(
        catItems.filter(i => i.status === 'AVAILABLE' && i.registeredFromVenueId).map(i => i.registeredFromVenueId),
      ).size

      result.push({
        categoryId,
        categoryName: first.category?.name ?? 'Sin categoría',
        totalSims: total,
        available,
        sold,
        rotacionPct: total > 0 ? Math.round((sold / total) * 10000) / 100 : 0,
        pctOfTotal: grandTotal > 0 ? Math.round((total / grandTotal) * 10000) / 100 : 0,
        sucursalesConStock,
        estimatedCoverageDays: null,
      })
    }

    return result.sort((a, b) => b.totalSims - a.totalSims)
  }

  computeSummary(items: any[], bulkGroups: OrgStockBulkGroup[], options: OrgStockOverviewOptions): OrgStockSummary {
    const total = items.length
    const available = items.filter(i => i.status === 'AVAILABLE').length
    const sold = items.filter(i => i.status === 'SOLD').length
    const damaged = items.filter(i => i.status === 'DAMAGED').length
    const returned = items.filter(i => i.status === 'RETURNED').length

    const venueIds = new Set(items.map(i => i.registeredFromVenueId).filter(Boolean))
    const categoryIds = new Set(items.map(i => i.categoryId))

    let lastActivity: OrgStockLastActivity | null = null
    const allTimestamps: Array<{ time: number; venueName: string; action: 'UPLOAD' | 'SALE' }> = []
    for (const item of items) {
      if (item.createdAt) {
        allTimestamps.push({
          time: item.createdAt.getTime(),
          venueName: item.registeredFromVenue?.name ?? 'Unknown',
          action: 'UPLOAD',
        })
      }
      if (item.soldAt) {
        allTimestamps.push({
          time: item.soldAt.getTime(),
          venueName: item.sellingVenue?.name ?? 'Unknown',
          action: 'SALE',
        })
      }
    }
    if (allTimestamps.length > 0) {
      const most = allTimestamps.reduce((a, b) => (a.time > b.time ? a : b))
      lastActivity = {
        timestamp: new Date(most.time).toISOString(),
        venueName: most.venueName,
        action: most.action,
      }
    }

    return {
      totalSims: total,
      available,
      sold,
      damaged,
      returned,
      rotacionPct: total > 0 ? Math.round((sold / total) * 10000) / 100 : 0,
      totalCargas: bulkGroups.length,
      sucursalesInvolucradas: venueIds.size,
      categoriasActivas: categoryIds.size,
      dateRange: {
        from: options.dateFrom?.toISOString() ?? new Date(0).toISOString(),
        to: options.dateTo?.toISOString() ?? new Date().toISOString(),
      },
      generatedAt: new Date().toISOString(),
      lastActivity,
    }
  }

  /**
   * LEGACY. Conserva la forma de la respuesta para pestañas viejas, pero ya no
   * materializa la organización entera: `items`/`bulkGroups` salen de los
   * LEGACY_OVERVIEW_ITEMS_CAP más recientes y `summary`/agregados de `getOrgSummary`
   * (SQL sobre todas las SIMs) — así un cliente viejo ve totales correctos aunque su
   * tabla sea parcial. Guardia: orgStockControl.overviewAcotado.service.test.ts
   */
  async getOrgOverview(orgId: string, options: OrgStockOverviewOptions): Promise<OrgStockOverview> {
    const [items, summaryData] = await Promise.all([
      this.fetchSerializedItems(orgId, options, LEGACY_OVERVIEW_ITEMS_CAP),
      this.getOrgSummary(orgId, options),
    ])

    // Resolve staff names + employeeCodes in a batch (just for createdBy —
    // supervisor/promoter come back via Prisma `include`).
    const staffIds = Array.from(new Set(items.map(i => i.createdBy).filter(Boolean))) as string[]
    const staffMap = new Map<string, string>()
    const employeeCodeMap = new Map<string, string | null>()
    if (staffIds.length > 0) {
      const staff = await prisma.staff.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, firstName: true, lastName: true, employeeCode: true },
      })
      for (const s of staff) {
        staffMap.set(s.id, `${s.firstName ?? ''} ${s.lastName ?? ''}`.trim())
        employeeCodeMap.set(s.id, s.employeeCode ?? null)
      }
    }

    const serializedItems: OrgStockOverviewItem[] = items.map(item => this.serializeItem(item, staffMap, employeeCodeMap))

    const bulkGroups = this.groupByBulkUpload(items, staffMap, employeeCodeMap)

    return {
      summary: summaryData.summary,
      items: serializedItems,
      bulkGroups,
      aggregatesBySucursal: summaryData.aggregatesBySucursal,
      aggregatesByCategoria: summaryData.aggregatesByCategoria,
    }
  }
}

export const orgStockControlService = new OrgStockControlService()
