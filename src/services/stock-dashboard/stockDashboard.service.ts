/**
 * Stock Dashboard Service
 * Provides stock metrics, charts, alerts, and bulk upload for
 * the PlayTelecom/White-Label dashboard.
 */
import prisma from '../../utils/prismaClient'
import { venueStartOfDay, venueStartOfDayOffset } from '../../utils/datetime'

// Types for the service responses
export interface StockMetrics {
  totalPieces: number
  totalValue: number
  availablePieces: number
  soldToday: number
  soldThisWeek: number
}

export interface CategoryStockInfo {
  id: string
  name: string
  color: string | null
  available: number
  sold7d: number
  suggestedPrice: number | null
  coverage: number | null // Days of stock based on 7-day sales average
  alertLevel: 'CRITICAL' | 'WARNING' | 'OK'
  minimumStock: number | null
}

export interface StockVsSalesPoint {
  date: string
  stockLevel: number
  salesCount: number
}

export interface StockAlert {
  categoryId: string
  categoryName: string
  categoryColor: string | null
  currentStock: number
  minimumStock: number
  alertLevel: 'CRITICAL' | 'WARNING'
}

export interface BulkUploadResult {
  success: boolean
  created: number
  duplicates: string[]
  errors: string[]
  total: number
}

class StockDashboardService {
  /**
   * Build Prisma where clauses that cover both venue-specific items AND
   * org-level items (uploaded with venueId: null, organizationId: set).
   * This ensures "Registrar a nivel organización" uploads are visible in
   * every venue of the organization.
   */
  private async getItemScope(venueId: string) {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { organizationId: true },
    })
    const orgId = venue?.organizationId ?? null
    const scopeFilter: Record<string, any> = orgId ? { OR: [{ venueId }, { organizationId: orgId, venueId: null }] } : { venueId }
    return { orgId, itemWhere: scopeFilter, categoryWhere: scopeFilter }
  }

  /**
   * Get stock metrics summary for a venue
   */
  async getStockMetrics(venueId: string): Promise<StockMetrics> {
    const todayStart = venueStartOfDay()
    const weekStart = venueStartOfDayOffset(undefined, -7)
    const { itemWhere, categoryWhere } = await this.getItemScope(venueId)

    // Count totals — includes org-level items (venueId: null) via itemWhere OR clause
    const [totalPieces, availablePieces, soldToday, soldThisWeek] = await Promise.all([
      prisma.serializedItem.count({ where: { ...itemWhere } }),
      prisma.serializedItem.count({ where: { ...itemWhere, status: 'AVAILABLE' } }),
      prisma.serializedItem.count({
        where: { ...itemWhere, status: 'SOLD', soldAt: { gte: todayStart } },
      }),
      prisma.serializedItem.count({
        where: { ...itemWhere, status: 'SOLD', soldAt: { gte: weekStart } },
      }),
    ])

    // Calculate total value (sum of suggested prices for available items)
    const categories = await prisma.itemCategory.findMany({
      where: { ...categoryWhere, active: true },
      select: { id: true, suggestedPrice: true },
    })

    let totalValue = 0
    for (const cat of categories) {
      if (cat.suggestedPrice) {
        const count = await prisma.serializedItem.count({
          where: { ...itemWhere, categoryId: cat.id, status: 'AVAILABLE' },
        })
        totalValue += count * Number(cat.suggestedPrice)
      }
    }

    return {
      totalPieces,
      totalValue: Math.round(totalValue * 100) / 100,
      availablePieces,
      soldToday,
      soldThisWeek,
    }
  }

  /**
   * Get stock info by category with coverage estimation
   */
  async getCategoryStock(venueId: string): Promise<CategoryStockInfo[]> {
    const weekStart = venueStartOfDayOffset(undefined, -7)
    const { itemWhere, categoryWhere } = await this.getItemScope(venueId)

    // Get categories with their alert configs — includes org-level categories
    const categories = await prisma.itemCategory.findMany({
      where: { ...categoryWhere, active: true },
      orderBy: { sortOrder: 'asc' },
    })

    // Get alert configs
    const alertConfigs = await prisma.stockAlertConfig.findMany({
      where: { venueId },
    })
    const alertMap = new Map(alertConfigs.map(a => [a.categoryId, a]))

    const results: CategoryStockInfo[] = []

    for (const category of categories) {
      // Count available and sold in last 7 days — includes org-level items
      const [available, sold7d] = await Promise.all([
        prisma.serializedItem.count({
          where: { ...itemWhere, categoryId: category.id, status: 'AVAILABLE' },
        }),
        prisma.serializedItem.count({
          where: {
            ...itemWhere,
            categoryId: category.id,
            status: 'SOLD',
            soldAt: { gte: weekStart },
          },
        }),
      ])

      // Calculate coverage (days of stock at current sales rate)
      const dailySales = sold7d / 7
      const coverage = dailySales > 0 ? Math.round(available / dailySales) : null

      // Determine alert level
      const alertConfig = alertMap.get(category.id)
      let alertLevel: 'CRITICAL' | 'WARNING' | 'OK' = 'OK'
      if (alertConfig && alertConfig.alertEnabled) {
        if (available === 0) {
          alertLevel = 'CRITICAL'
        } else if (available <= alertConfig.minimumStock) {
          alertLevel = 'WARNING'
        }
      } else if (available === 0) {
        alertLevel = 'CRITICAL'
      } else if (coverage !== null && coverage < 3) {
        alertLevel = 'WARNING'
      }

      results.push({
        id: category.id,
        name: category.name,
        color: category.color,
        available,
        sold7d,
        suggestedPrice: category.suggestedPrice ? Number(category.suggestedPrice) : null,
        coverage,
        alertLevel,
        minimumStock: alertConfig?.minimumStock ?? null,
      })
    }

    return results
  }

  /**
   * Get stock vs sales trend for charts
   */
  async getStockVsSales(venueId: string, days: number = 14): Promise<StockVsSalesPoint[]> {
    const data: StockVsSalesPoint[] = []
    const today = venueStartOfDay()
    const { itemWhere } = await this.getItemScope(venueId)

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(today)
      date.setDate(date.getDate() - i)
      const nextDate = new Date(date)
      nextDate.setDate(nextDate.getDate() + 1)

      // Count sales for this day — includes org-level items
      const salesCount = await prisma.serializedItem.count({
        where: {
          ...itemWhere,
          status: 'SOLD',
          soldAt: {
            gte: date,
            lt: nextDate,
          },
        },
      })

      // Get stock level at end of day — includes org-level items
      const stockLevel = await prisma.serializedItem.count({
        where: {
          ...itemWhere,
          status: 'AVAILABLE',
          createdAt: { lt: nextDate },
        },
      })

      data.push({
        date: date.toISOString().split('T')[0],
        stockLevel,
        salesCount,
      })
    }

    return data
  }

  /**
   * Get all low stock alerts
   */
  async getLowStockAlerts(venueId: string): Promise<StockAlert[]> {
    const alerts: StockAlert[] = []
    const { itemWhere, categoryWhere } = await this.getItemScope(venueId)

    // Get categories with alert configs — includes org-level categories
    const categories = await prisma.itemCategory.findMany({
      where: { ...categoryWhere, active: true },
    })

    const alertConfigs = await prisma.stockAlertConfig.findMany({
      where: { venueId, alertEnabled: true },
    })
    const alertMap = new Map(alertConfigs.map(a => [a.categoryId, a]))

    for (const category of categories) {
      const available = await prisma.serializedItem.count({
        where: { ...itemWhere, categoryId: category.id, status: 'AVAILABLE' },
      })

      const config = alertMap.get(category.id)
      if (config && available <= config.minimumStock) {
        alerts.push({
          categoryId: category.id,
          categoryName: category.name,
          categoryColor: category.color,
          currentStock: available,
          minimumStock: config.minimumStock,
          alertLevel: available === 0 ? 'CRITICAL' : 'WARNING',
        })
      }
    }

    // Sort by severity (critical first)
    alerts.sort((a, b) => {
      if (a.alertLevel === 'CRITICAL' && b.alertLevel !== 'CRITICAL') return -1
      if (a.alertLevel !== 'CRITICAL' && b.alertLevel === 'CRITICAL') return 1
      return a.currentStock - b.currentStock
    })

    return alerts
  }

  /**
   * Configure stock alert for a category
   */
  async configureStockAlert(
    venueId: string,
    categoryId: string,
    minimumStock: number,
    alertEnabled: boolean,
  ): Promise<{ success: boolean }> {
    await prisma.stockAlertConfig.upsert({
      where: {
        venueId_categoryId: {
          venueId,
          categoryId,
        },
      },
      create: {
        venueId,
        categoryId,
        minimumStock,
        alertEnabled,
      },
      update: {
        minimumStock,
        alertEnabled,
      },
    })

    return { success: true }
  }

  /**
   * Process CSV upload for bulk item registration
   * Expected format: serialNumber (one per line, or comma-separated)
   */
  async processBulkUpload(venueId: string, categoryId: string, csvContent: string, createdBy: string): Promise<BulkUploadResult> {
    // Parse CSV content
    const lines = csvContent
      .split(/[\r\n,]+/)
      .map(l => l.trim())
      .filter(l => l.length > 0)

    if (lines.length === 0) {
      return {
        success: false,
        created: 0,
        duplicates: [],
        errors: ['No serial numbers found in upload'],
        total: 0,
      }
    }

    // Validate category exists and belongs to venue or its org
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { organizationId: true },
    })

    const category = await prisma.itemCategory.findFirst({
      where: {
        id: categoryId,
        OR: [{ venueId }, { organizationId: venue?.organizationId, venueId: null }],
      },
    })

    if (!category) {
      return {
        success: false,
        created: 0,
        duplicates: [],
        errors: ['Invalid category'],
        total: lines.length,
      }
    }

    const duplicates: string[] = []
    const errors: string[] = []
    let created = 0

    // Pre-validate serial numbers
    const validSerials: string[] = []
    for (const serialNumber of lines) {
      if (serialNumber.length < 3 || serialNumber.length > 100) {
        errors.push(`Invalid serial number: ${serialNumber}`)
      } else {
        validSerials.push(serialNumber)
      }
    }

    // Batch duplicate check outside transaction (chunked for large volumes)
    const existingSet = new Set<string>()
    const chunkSize = 1000
    for (let i = 0; i < validSerials.length; i += chunkSize) {
      const chunk = validSerials.slice(i, i + chunkSize)
      const found = await prisma.serializedItem.findMany({
        where: { venueId, serialNumber: { in: chunk } },
        select: { serialNumber: true },
      })
      for (const f of found) existingSet.add(f.serialNumber)
    }
    const toCreate: string[] = []
    for (const sn of validSerials) {
      if (existingSet.has(sn)) {
        duplicates.push(sn)
      } else {
        toCreate.push(sn)
      }
    }

    // Insert in batches with createMany
    const batchSize = 500
    for (let i = 0; i < toCreate.length; i += batchSize) {
      const batch = toCreate.slice(i, i + batchSize)
      await prisma.serializedItem.createMany({
        data: batch.map(serialNumber => ({
          venueId,
          categoryId,
          serialNumber,
          createdBy,
          status: 'AVAILABLE' as const,
        })),
        skipDuplicates: true,
      })
      created += batch.length
    }

    return {
      success: created > 0 || (errors.length === 0 && duplicates.length === lines.length),
      created,
      duplicates,
      errors,
      total: lines.length,
    }
  }

  /**
   * Get recent stock movements (registrations and sales)
   */
  async getRecentMovements(
    venueId: string,
    limit: number = 20,
  ): Promise<
    Array<{
      id: string
      serialNumber: string
      categoryName: string
      type: 'REGISTERED' | 'SOLD' | 'RETURNED' | 'DAMAGED' | 'BULK_UPLOAD'
      timestamp: Date
      venueName: string | null
      userName: string | null
      itemCount?: number
      registeredFromVenueName?: string | null
      serialNumbers?: string[]
      soldByName?: string | null
      soldAtVenueName?: string | null
    }>
  > {
    const { itemWhere } = await this.getItemScope(venueId)
    // Get recent items — includes org-level items
    const recentItems = await prisma.serializedItem.findMany({
      where: { ...itemWhere },
      include: {
        category: true,
        venue: { select: { name: true } },
        sellingVenue: { select: { name: true } },
        registeredFromVenue: { select: { name: true } },
        orderItem: {
          select: {
            order: {
              select: {
                createdBy: { select: { id: true, firstName: true, lastName: true } },
                venue: { select: { name: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit * 4, // Get enough to group bulk uploads and still have events
    })

    // Resolve staff names
    const staffIds = Array.from(new Set(recentItems.map(i => i.createdBy).filter(Boolean)))
    const staffMap = new Map<string, string>()
    if (staffIds.length > 0) {
      const staffRecords = await prisma.staff.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, firstName: true, lastName: true },
      })
      for (const s of staffRecords) {
        staffMap.set(s.id, `${s.firstName} ${s.lastName}`.trim())
      }
    }

    type Movement = {
      id: string
      serialNumber: string
      categoryName: string
      type: 'REGISTERED' | 'SOLD' | 'RETURNED' | 'DAMAGED' | 'BULK_UPLOAD'
      timestamp: Date
      venueName: string | null
      userName: string | null
      itemCount?: number
      registeredFromVenueName?: string | null
      serialNumbers?: string[]
      soldByName?: string | null
      soldAtVenueName?: string | null
    }

    const movements: Movement[] = []

    // ── Group registrations to detect bulk uploads ──
    // Items created within a 2-minute window by the same person in the same
    // category are collapsed into a single BULK_UPLOAD event.
    const BULK_WINDOW_MS = 2 * 60 * 1000
    const regGroups = new Map<string, typeof recentItems>()

    for (const item of recentItems) {
      const bucket = Math.floor(item.createdAt.getTime() / BULK_WINDOW_MS)
      const key = `${item.createdBy}|${item.categoryId}|${bucket}`
      const group = regGroups.get(key) || []
      group.push(item)
      regGroups.set(key, group)
    }

    // Emit grouped registration events
    regGroups.forEach(group => {
      const first = group[0]
      const registeredByName = staffMap.get(first.createdBy) || null
      const itemVenueName = first.venueId ? first.venue?.name || null : 'Todas las tiendas'
      const regFromVenue = first.registeredFromVenue?.name || null

      if (group.length > 1) {
        // Bulk upload — single row with serial numbers for drill-down
        movements.push({
          id: `bulk-${first.id}`,
          serialNumber: `${group.length} seriales`,
          categoryName: first.category.name,
          type: 'BULK_UPLOAD',
          timestamp: first.createdAt,
          venueName: itemVenueName,
          userName: registeredByName,
          itemCount: group.length,
          registeredFromVenueName: regFromVenue,
          serialNumbers: group.map(i => i.serialNumber),
        })
      } else {
        // Single registration
        movements.push({
          id: `reg-${first.id}`,
          serialNumber: first.serialNumber,
          categoryName: first.category.name,
          type: 'REGISTERED',
          timestamp: first.createdAt,
          venueName: itemVenueName,
          userName: registeredByName,
          registeredFromVenueName: regFromVenue,
        })
      }
    })

    // ── Individual sale / return / damage events ──
    for (const item of recentItems) {
      const registeredByName = staffMap.get(item.createdBy) || null
      const itemVenueName = item.venueId ? item.venue?.name || null : 'Todas las tiendas'

      if (item.status === 'SOLD' && item.soldAt) {
        const orderStaff = item.orderItem?.order?.createdBy
        const soldByName = orderStaff ? `${orderStaff.firstName} ${orderStaff.lastName}`.trim() : null
        const soldAtVenue = item.orderItem?.order?.venue?.name || item.sellingVenue?.name || null
        movements.push({
          id: `sold-${item.id}`,
          serialNumber: item.serialNumber,
          categoryName: item.category.name,
          type: 'SOLD',
          timestamp: item.soldAt,
          venueName: item.sellingVenue?.name || itemVenueName,
          userName: registeredByName,
          soldByName,
          soldAtVenueName: soldAtVenue,
        })
      }

      if (item.status === 'RETURNED' || item.status === 'DAMAGED') {
        movements.push({
          id: `${item.status.toLowerCase()}-${item.id}`,
          serialNumber: item.serialNumber,
          categoryName: item.category.name,
          type: item.status as 'RETURNED' | 'DAMAGED',
          timestamp: item.soldAt || item.createdAt,
          venueName: item.sellingVenue?.name || itemVenueName,
          userName: registeredByName,
        })
      }
    }

    // Sort by timestamp descending and limit
    return movements.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()).slice(0, limit)
  }

  /**
   * Process CSV upload for org-level bulk item registration
   */
  async processBulkUploadOrg(venueId: string, categoryId: string, csvContent: string, createdBy: string): Promise<BulkUploadResult> {
    // Get org ID from venue
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { organizationId: true },
    })

    if (!venue) {
      return { success: false, created: 0, duplicates: [], errors: ['Venue not found'], total: 0 }
    }

    const organizationId = venue.organizationId

    // Validate category is org-level
    const category = await prisma.itemCategory.findFirst({
      where: { id: categoryId, organizationId, venueId: null },
    })

    if (!category) {
      return { success: false, created: 0, duplicates: [], errors: ['Invalid org-level category'], total: 0 }
    }

    // Parse CSV content
    const lines = csvContent
      .split(/[\r\n,]+/)
      .map(l => l.trim())
      .filter(l => l.length > 0)

    if (lines.length === 0) {
      return { success: false, created: 0, duplicates: [], errors: ['No serial numbers found'], total: 0 }
    }

    const duplicates: string[] = []
    const errors: string[] = []
    let created = 0

    // Pre-validate serial numbers
    const validSerials: string[] = []
    for (const serialNumber of lines) {
      if (serialNumber.length < 3 || serialNumber.length > 100) {
        errors.push(`Invalid serial number: ${serialNumber}`)
      } else {
        validSerials.push(serialNumber)
      }
    }

    // Batch duplicate check outside transaction (chunked for large volumes)
    const existingSet = new Set<string>()
    const chunkSize = 1000
    for (let i = 0; i < validSerials.length; i += chunkSize) {
      const chunk = validSerials.slice(i, i + chunkSize)
      const found = await prisma.serializedItem.findMany({
        where: {
          serialNumber: { in: chunk },
          OR: [{ organizationId }, { venue: { organizationId } }],
        },
        select: { serialNumber: true },
      })
      for (const f of found) existingSet.add(f.serialNumber)
    }
    const toCreate: string[] = []
    for (const sn of validSerials) {
      if (existingSet.has(sn)) {
        duplicates.push(sn)
      } else {
        toCreate.push(sn)
      }
    }

    // Insert in batches with createMany
    const batchSize = 500
    for (let i = 0; i < toCreate.length; i += batchSize) {
      const batch = toCreate.slice(i, i + batchSize)
      await prisma.serializedItem.createMany({
        data: batch.map(serialNumber => ({
          organizationId,
          venueId: null,
          categoryId,
          serialNumber,
          createdBy,
          registeredFromVenueId: venueId,
          status: 'AVAILABLE' as const,
        })),
        skipDuplicates: true,
      })
      created += batch.length
    }

    return {
      success: created > 0 || (errors.length === 0 && duplicates.length === lines.length),
      created,
      duplicates,
      errors,
      total: lines.length,
    }
  }
}

export const stockDashboardService = new StockDashboardService()
