import { LowStockAlert, AlertStatus, AlertType, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import AppError from '../../errors/AppError'
import { sendLowStockAlertNotification } from './notification.service'

/**
 * Get all alerts for a venue
 */
export async function getAlerts(
  venueId: string,
  filters?: {
    status?: AlertStatus
    alertType?: AlertType
    rawMaterialId?: string
  },
): Promise<LowStockAlert[]> {
  const where: Prisma.LowStockAlertWhereInput = {
    venueId,
    ...(filters?.status && { status: filters.status }),
    ...(filters?.alertType && { alertType: filters.alertType }),
    ...(filters?.rawMaterialId && { rawMaterialId: filters.rawMaterialId }),
  }

  const alerts = await prisma.lowStockAlert.findMany({
    where,
    include: {
      rawMaterial: {
        select: {
          id: true,
          name: true,
          sku: true,
          unit: true,
          currentStock: true,
          reorderPoint: true,
          category: true,
        },
      },
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
  })

  return alerts as any
}

/**
 * Get active alerts count
 */
export async function getActiveAlertsCount(venueId: string): Promise<number> {
  return prisma.lowStockAlert.count({
    where: {
      venueId,
      status: AlertStatus.ACTIVE,
    },
  })
}

/**
 * Get alerts by category
 */
export async function getAlertsByCategory(venueId: string) {
  const alerts = await prisma.lowStockAlert.findMany({
    where: {
      venueId,
      status: AlertStatus.ACTIVE,
    },
    include: {
      rawMaterial: {
        select: {
          category: true,
        },
      },
    },
  })

  const categoryBreakdown = alerts.reduce(
    (acc, alert) => {
      const category = alert.rawMaterial.category
      if (!acc[category]) {
        acc[category] = {
          category,
          count: 0,
          outOfStock: 0,
          lowStock: 0,
        }
      }
      acc[category].count++
      if (alert.alertType === AlertType.OUT_OF_STOCK) {
        acc[category].outOfStock++
      } else {
        acc[category].lowStock++
      }
      return acc
    },
    {} as Record<
      string,
      {
        category: string
        count: number
        outOfStock: number
        lowStock: number
      }
    >,
  )

  return Object.values(categoryBreakdown)
}

/**
 * Acknowledge an alert (mark as seen but not resolved)
 */
export async function acknowledgeAlert(venueId: string, alertId: string, staffId?: string): Promise<LowStockAlert> {
  const alert = await prisma.lowStockAlert.findFirst({
    where: {
      id: alertId,
      venueId,
    },
  })

  if (!alert) {
    throw new AppError(`Alert with ID ${alertId} not found`, 404)
  }

  if (alert.status !== AlertStatus.ACTIVE) {
    throw new AppError(`Alert is already ${alert.status.toLowerCase()}`, 400)
  }

  const updatedAlert = await prisma.lowStockAlert.update({
    where: { id: alertId },
    data: {
      status: AlertStatus.ACKNOWLEDGED,
      acknowledgedBy: staffId,
      acknowledgedAt: new Date(),
    },
    include: {
      rawMaterial: true,
    },
  })

  return updatedAlert as any
}

/**
 * Resolve an alert (mark as resolved when stock is replenished)
 */
export async function resolveAlert(venueId: string, alertId: string, staffId?: string): Promise<LowStockAlert> {
  const alert = await prisma.lowStockAlert.findFirst({
    where: {
      id: alertId,
      venueId,
    },
    include: {
      rawMaterial: true,
    },
  })

  if (!alert) {
    throw new AppError(`Alert with ID ${alertId} not found`, 404)
  }

  if (alert.status === AlertStatus.RESOLVED) {
    throw new AppError(`Alert is already resolved`, 400)
  }

  // Check if stock is now above reorder point
  if (alert.rawMaterial.currentStock.lessThanOrEqualTo(alert.rawMaterial.reorderPoint)) {
    throw new AppError(
      `Cannot resolve alert: current stock (${alert.rawMaterial.currentStock}) is still at or below reorder point (${alert.rawMaterial.reorderPoint})`,
      400,
    )
  }

  const updatedAlert = await prisma.lowStockAlert.update({
    where: { id: alertId },
    data: {
      status: AlertStatus.RESOLVED,
      resolvedBy: staffId,
      resolvedAt: new Date(),
    },
    include: {
      rawMaterial: true,
    },
  })

  return updatedAlert as any
}

/**
 * Auto-resolve alerts when stock is replenished
 * This should be called after stock adjustments
 */
export async function autoResolveAlerts(venueId: string, rawMaterialId: string): Promise<number> {
  const rawMaterial = await prisma.rawMaterial.findFirst({
    where: {
      id: rawMaterialId,
      venueId,
    },
  })

  if (!rawMaterial) {
    return 0
  }

  // If stock is now above reorder point, resolve all active alerts
  if (rawMaterial.currentStock.greaterThan(rawMaterial.reorderPoint)) {
    const result = await prisma.lowStockAlert.updateMany({
      where: {
        rawMaterialId,
        venueId,
        status: {
          in: [AlertStatus.ACTIVE, AlertStatus.ACKNOWLEDGED],
        },
      },
      data: {
        status: AlertStatus.RESOLVED,
        resolvedAt: new Date(),
      },
    })

    return result.count
  }

  return 0
}

/**
 * Dismiss an alert (mark as dismissed without resolving)
 */
export async function dismissAlert(venueId: string, alertId: string, _reason?: string, staffId?: string): Promise<LowStockAlert> {
  const alert = await prisma.lowStockAlert.findFirst({
    where: {
      id: alertId,
      venueId,
    },
  })

  if (!alert) {
    throw new AppError(`Alert with ID ${alertId} not found`, 404)
  }

  if (alert.status === AlertStatus.RESOLVED || alert.status === AlertStatus.DISMISSED) {
    throw new AppError(`Alert is already ${alert.status.toLowerCase()}`, 400)
  }

  const updatedAlert = await prisma.lowStockAlert.update({
    where: { id: alertId },
    data: {
      status: AlertStatus.DISMISSED,
      resolvedBy: staffId,
      resolvedAt: new Date(),
    },
    include: {
      rawMaterial: true,
    },
  })

  return updatedAlert as any
}

/**
 * Get alert history for a raw material
 */
export async function getAlertHistory(venueId: string, rawMaterialId: string): Promise<LowStockAlert[]> {
  const alerts = await prisma.lowStockAlert.findMany({
    where: {
      venueId,
      rawMaterialId,
    },
    include: {
      rawMaterial: {
        select: {
          id: true,
          name: true,
          sku: true,
          unit: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  })

  return alerts as any
}

/**
 * Get alert statistics
 */
export async function getAlertStats(venueId: string, startDate?: Date, endDate?: Date) {
  const dateFilter = {
    ...(startDate && { gte: startDate }),
    ...(endDate && { lte: endDate }),
  }

  const alerts = await prisma.lowStockAlert.findMany({
    where: {
      venueId,
      ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
    },
  })

  const totalAlerts = alerts.length
  const activeAlerts = alerts.filter(a => a.status === AlertStatus.ACTIVE).length
  const acknowledgedAlerts = alerts.filter(a => a.status === AlertStatus.ACKNOWLEDGED).length
  const resolvedAlerts = alerts.filter(a => a.status === AlertStatus.RESOLVED).length
  const dismissedAlerts = alerts.filter(a => a.status === AlertStatus.DISMISSED).length
  const outOfStockAlerts = alerts.filter(a => a.alertType === AlertType.OUT_OF_STOCK).length
  const lowStockAlerts = alerts.filter(a => a.alertType === AlertType.LOW_STOCK).length

  // Calculate average resolution time for resolved alerts
  const resolvedAlertsWithTimes = alerts.filter(a => a.status === AlertStatus.RESOLVED && a.resolvedAt)
  const averageResolutionTimeMs =
    resolvedAlertsWithTimes.length > 0
      ? resolvedAlertsWithTimes.reduce((sum, alert) => {
          const resolutionTime = alert.resolvedAt!.getTime() - alert.createdAt.getTime()
          return sum + resolutionTime
        }, 0) / resolvedAlertsWithTimes.length
      : 0

  const averageResolutionHours = Math.round((averageResolutionTimeMs / (1000 * 60 * 60)) * 10) / 10

  return {
    period: { startDate, endDate },
    totalAlerts,
    statusBreakdown: {
      active: activeAlerts,
      acknowledged: acknowledgedAlerts,
      resolved: resolvedAlerts,
      dismissed: dismissedAlerts,
    },
    typeBreakdown: {
      outOfStock: outOfStockAlerts,
      lowStock: lowStockAlerts,
    },
    averageResolutionHours,
    resolutionRate: totalAlerts > 0 ? Math.round((resolvedAlerts / totalAlerts) * 100 * 10) / 10 : 0,
  }
}

/**
 * Create manual alert
 */
export async function createManualAlert(
  venueId: string,
  data: {
    rawMaterialId: string
    alertType: AlertType
    notes?: string
  },
  _staffId?: string,
): Promise<LowStockAlert> {
  const rawMaterial = await prisma.rawMaterial.findFirst({
    where: {
      id: data.rawMaterialId,
      venueId,
    },
  })

  if (!rawMaterial) {
    throw new AppError(`Raw material not found`, 404)
  }

  // Check if active alert already exists
  const existingAlert = await prisma.lowStockAlert.findFirst({
    where: {
      venueId,
      rawMaterialId: data.rawMaterialId,
      status: AlertStatus.ACTIVE,
    },
  })

  if (existingAlert) {
    throw new AppError(`An active alert already exists for this raw material`, 400)
  }

  const alert = await prisma.lowStockAlert.create({
    data: {
      venueId,
      rawMaterialId: data.rawMaterialId,
      alertType: data.alertType,
      threshold: rawMaterial.reorderPoint,
      currentLevel: rawMaterial.currentStock,
    },
    include: {
      rawMaterial: true,
    },
  })

  // Send notification to relevant staff
  await sendLowStockAlertNotification(
    venueId,
    data.rawMaterialId,
    data.alertType,
    rawMaterial.currentStock.toNumber(),
    rawMaterial.unit,
    rawMaterial.reorderPoint.toNumber(),
  )

  return alert as any
}
