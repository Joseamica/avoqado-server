import prisma from '../../utils/prismaClient'
import type {
  OrgStockBulkGroup,
  OrgStockCategoriaAggregate,
  OrgStockLastActivity,
  OrgStockOverview,
  OrgStockOverviewItem,
  OrgStockOverviewOptions,
  OrgStockSucursalAggregate,
  OrgStockSummary,
} from './orgStockControl.types'

const BULK_WINDOW_MS = 2 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export class OrgStockControlService {
  /**
   * Fetches serialized items for an organization, optionally filtered by createdAt range.
   * Uses organizationId scope (bulk uploads are stored at org level with null venueId).
   */
  async fetchSerializedItems(orgId: string, options: OrgStockOverviewOptions) {
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
        assignedSupervisor: { select: { id: true, firstName: true, lastName: true } },
        assignedPromoter: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
  }

  /**
   * Groups items into bulk upload events using a 2-minute window + same creator + category + origin venue.
   * Mirrors the logic in stockDashboard.service.getRecentMovements but adapted for org-level items.
   */
  groupByBulkUpload(items: any[], staffMap?: Map<string, string>): OrgStockBulkGroup[] {
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

  async getOrgOverview(orgId: string, options: OrgStockOverviewOptions): Promise<OrgStockOverview> {
    const items = await this.fetchSerializedItems(orgId, options)

    // Resolve staff names in a batch
    const staffIds = Array.from(new Set(items.map(i => i.createdBy).filter(Boolean))) as string[]
    const staffMap = new Map<string, string>()
    if (staffIds.length > 0) {
      const staff = await prisma.staff.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, firstName: true, lastName: true },
      })
      for (const s of staff) {
        staffMap.set(s.id, `${s.firstName ?? ''} ${s.lastName ?? ''}`.trim())
      }
    }

    const serializedItems: OrgStockOverviewItem[] = items.map(item => {
      const supervisor = (item as any).assignedSupervisor as { id: string; firstName: string; lastName: string } | null | undefined
      const promoter = (item as any).assignedPromoter as { id: string; firstName: string; lastName: string } | null | undefined
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
        // Chain-of-custody fields (new)
        custodyState: item.custodyState,
        assignedSupervisorId: item.assignedSupervisorId ?? null,
        assignedSupervisorName: supervisor ? `${supervisor.firstName} ${supervisor.lastName}`.trim() : null,
        assignedPromoterId: item.assignedPromoterId ?? null,
        assignedPromoterName: promoter ? `${promoter.firstName} ${promoter.lastName}`.trim() : null,
        promoterAcceptedAt: item.promoterAcceptedAt?.toISOString() ?? null,
        promoterRejectedAt: item.promoterRejectedAt?.toISOString() ?? null,
      }
    })

    const bulkGroups = this.groupByBulkUpload(items, staffMap)
    const aggregatesBySucursal = this.aggregateBySucursal(items)
    const aggregatesByCategoria = this.aggregateByCategoria(items)
    const summary = this.computeSummary(items, bulkGroups, options)

    return {
      summary,
      items: serializedItems,
      bulkGroups,
      aggregatesBySucursal,
      aggregatesByCategoria,
    }
  }
}

export const orgStockControlService = new OrgStockControlService()
