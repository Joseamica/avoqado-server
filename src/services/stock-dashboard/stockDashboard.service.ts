/**
 * Stock Dashboard Service
 * Provides stock metrics, charts, alerts, and bulk upload for
 * the PlayTelecom/White-Label dashboard.
 */
import prisma from '../../utils/prismaClient'

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
   * Get stock metrics summary for a venue
   */
  async getStockMetrics(venueId: string): Promise<StockMetrics> {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    const weekStart = new Date()
    weekStart.setDate(weekStart.getDate() - 7)
    weekStart.setHours(0, 0, 0, 0)

    // Count totals
    const [totalPieces, availablePieces, soldToday, soldThisWeek] = await Promise.all([
      prisma.serializedItem.count({
        where: { venueId },
      }),
      prisma.serializedItem.count({
        where: { venueId, status: 'AVAILABLE' },
      }),
      prisma.serializedItem.count({
        where: {
          venueId,
          status: 'SOLD',
          soldAt: { gte: todayStart },
        },
      }),
      prisma.serializedItem.count({
        where: {
          venueId,
          status: 'SOLD',
          soldAt: { gte: weekStart },
        },
      }),
    ])

    // Calculate total value (sum of suggested prices for available items)
    const categories = await prisma.itemCategory.findMany({
      where: { venueId, active: true },
      select: { id: true, suggestedPrice: true },
    })

    let totalValue = 0
    for (const cat of categories) {
      if (cat.suggestedPrice) {
        const count = await prisma.serializedItem.count({
          where: { venueId, categoryId: cat.id, status: 'AVAILABLE' },
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
    const weekStart = new Date()
    weekStart.setDate(weekStart.getDate() - 7)
    weekStart.setHours(0, 0, 0, 0)

    // Get categories with their alert configs
    const categories = await prisma.itemCategory.findMany({
      where: { venueId, active: true },
      orderBy: { sortOrder: 'asc' },
    })

    // Get alert configs
    const alertConfigs = await prisma.stockAlertConfig.findMany({
      where: { venueId },
    })
    const alertMap = new Map(alertConfigs.map(a => [a.categoryId, a]))

    const results: CategoryStockInfo[] = []

    for (const category of categories) {
      // Count available and sold in last 7 days
      const [available, sold7d] = await Promise.all([
        prisma.serializedItem.count({
          where: { venueId, categoryId: category.id, status: 'AVAILABLE' },
        }),
        prisma.serializedItem.count({
          where: {
            venueId,
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
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(today)
      date.setDate(date.getDate() - i)
      const nextDate = new Date(date)
      nextDate.setDate(nextDate.getDate() + 1)

      // Count sales for this day
      const salesCount = await prisma.serializedItem.count({
        where: {
          venueId,
          status: 'SOLD',
          soldAt: {
            gte: date,
            lt: nextDate,
          },
        },
      })

      // Get stock level at end of day
      // For past days, we calculate based on when items were created/sold
      const stockLevel = await prisma.serializedItem.count({
        where: {
          venueId,
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

    // Get categories with alert configs
    const categories = await prisma.itemCategory.findMany({
      where: { venueId, active: true },
    })

    const alertConfigs = await prisma.stockAlertConfig.findMany({
      where: { venueId, alertEnabled: true },
    })
    const alertMap = new Map(alertConfigs.map(a => [a.categoryId, a]))

    for (const category of categories) {
      const available = await prisma.serializedItem.count({
        where: { venueId, categoryId: category.id, status: 'AVAILABLE' },
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

    // Validate category exists
    const category = await prisma.itemCategory.findUnique({
      where: { id: categoryId },
    })

    if (!category || category.venueId !== venueId) {
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

    // Process in batches of 100
    const batchSize = 100
    for (let i = 0; i < lines.length; i += batchSize) {
      const batch = lines.slice(i, i + batchSize)

      await prisma.$transaction(async tx => {
        for (const serialNumber of batch) {
          // Validate serial number format (basic validation)
          if (serialNumber.length < 3 || serialNumber.length > 100) {
            errors.push(`Invalid serial number: ${serialNumber}`)
            continue
          }

          // Check for duplicates
          const existing = await tx.serializedItem.findUnique({
            where: { venueId_serialNumber: { venueId, serialNumber } },
          })

          if (existing) {
            duplicates.push(serialNumber)
            continue
          }

          // Create item
          await tx.serializedItem.create({
            data: {
              venueId,
              categoryId,
              serialNumber,
              createdBy,
              status: 'AVAILABLE',
            },
          })
          created++
        }
      })
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
      type: 'REGISTERED' | 'SOLD' | 'RETURNED' | 'DAMAGED'
      timestamp: Date
    }>
  > {
    // Get recent items by createdAt and soldAt
    const recentItems = await prisma.serializedItem.findMany({
      where: { venueId },
      include: { category: true },
      orderBy: { createdAt: 'desc' },
      take: limit * 2, // Get more to allow for filtering
    })

    const movements: Array<{
      id: string
      serialNumber: string
      categoryName: string
      type: 'REGISTERED' | 'SOLD' | 'RETURNED' | 'DAMAGED'
      timestamp: Date
    }> = []

    for (const item of recentItems) {
      // Add registration event
      movements.push({
        id: `reg-${item.id}`,
        serialNumber: item.serialNumber,
        categoryName: item.category.name,
        type: 'REGISTERED',
        timestamp: item.createdAt,
      })

      // Add sale event if sold
      if (item.status === 'SOLD' && item.soldAt) {
        movements.push({
          id: `sold-${item.id}`,
          serialNumber: item.serialNumber,
          categoryName: item.category.name,
          type: 'SOLD',
          timestamp: item.soldAt,
        })
      }

      // Add return/damage events (use soldAt if available, otherwise createdAt)
      if (item.status === 'RETURNED' || item.status === 'DAMAGED') {
        movements.push({
          id: `${item.status.toLowerCase()}-${item.id}`,
          serialNumber: item.serialNumber,
          categoryName: item.category.name,
          type: item.status as 'RETURNED' | 'DAMAGED',
          timestamp: item.soldAt || item.createdAt,
        })
      }
    }

    // Sort by timestamp descending and limit
    return movements.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()).slice(0, limit)
  }
}

export const stockDashboardService = new StockDashboardService()
