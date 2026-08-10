// jobs/abandoned-orders-cleanup.job.ts

import { CronJob } from 'cron'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'

/**
 * Job que limpia órdenes abandonadas (vacías sin items)
 *
 * **Problema**: Cuando el usuario hace "Pedido rápido" pero presiona Atrás,
 * la orden queda creada en estado PENDING sin items, acumulándose en el sistema.
 *
 * **Solución**: Auto-eliminar órdenes que:
 * - ✅ Tienen 0 items
 * - ✅ Status = PENDING (no han sido pagadas)
 * - ✅ Creadas hace > 30 minutos
 * - ✅ Type = TAKEOUT (no eliminar órdenes de mesas)
 *
 * **Frecuencia**: Cada 15 minutos
 *
 * **Inspiración**: Toast POS usa auto-cleanup cada 30 min para "draft orders"
 */
export class AbandonedOrdersCleanupJob {
  private job: CronJob | null = null
  private readonly ABANDONMENT_THRESHOLD_MINUTES = 30
  private readonly CRON_PATTERN = '*/15 * * * *' // Every 15 minutes

  constructor() {
    this.job = scheduleJob(
      'abandoned-orders-cleanup',
      this.CRON_PATTERN,
      this.cleanupAbandonedOrders.bind(this),
      null,
      false,
      'America/Mexico_City',
    )
  }

  /**
   * Start the cleanup job
   */
  start(): void {
    if (this.job) {
      this.job.start()
      logger.info(
        `🧹 Abandoned Orders Cleanup Job started - running every 15 minutes (deletes empty TAKEOUT orders older than ${this.ABANDONMENT_THRESHOLD_MINUTES} min)`,
      )
    }
  }

  /**
   * Stop the cleanup job
   */
  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('🧹 Abandoned Orders Cleanup Job stopped')
    }
  }

  /**
   * Manually trigger cleanup (for testing)
   */
  async cleanupNow(): Promise<void> {
    await this.cleanupAbandonedOrders()
  }

  /**
   * Main cleanup function
   * Deletes empty TAKEOUT orders older than threshold
   */
  private async cleanupAbandonedOrders(): Promise<void> {
    try {
      const thresholdDate = new Date()
      thresholdDate.setMinutes(thresholdDate.getMinutes() - this.ABANDONMENT_THRESHOLD_MINUTES)

      logger.debug(`🧹 [CLEANUP] Checking for abandoned orders (empty, PENDING, TAKEOUT, created before ${thresholdDate.toISOString()})`)

      // Find abandoned orders
      const abandonedOrders = await prisma.order.findMany({
        where: {
          type: 'TAKEOUT',
          status: 'PENDING',
          paymentStatus: 'PENDING',
          createdAt: {
            lt: thresholdDate,
          },
        },
        include: {
          items: true,
          table: {
            select: {
              number: true,
            },
          },
        },
      })

      // Filter to only orders with 0 items
      const emptyOrders = abandonedOrders.filter(order => order.items.length === 0)

      if (emptyOrders.length === 0) {
        logger.debug('🧹 [CLEANUP] No abandoned orders found')
        return
      }

      logger.info(`🧹 [CLEANUP] Found ${emptyOrders.length} abandoned empty orders to delete`)

      // Log details of orders being deleted
      emptyOrders.forEach(order => {
        const age = Math.floor((Date.now() - order.createdAt.getTime()) / (1000 * 60))
        logger.info(
          `  🗑️  Deleting order ${order.orderNumber} (${order.type}, created ${age} min ago, table: ${order.table?.number || 'N/A'})`,
        )
      })

      // Delete the orders (Prisma will cascade delete related records)
      const result = await prisma.order.deleteMany({
        where: {
          id: {
            in: emptyOrders.map(o => o.id),
          },
        },
      })

      logger.info(`✅ [CLEANUP] Deleted ${result.count} abandoned orders`)
    } catch (error) {
      logger.error('❌ [CLEANUP] Error during abandoned orders cleanup:', error)
    }
  }

  /**
   * Get job status information
   */
  getJobStatus(): {
    isRunning: boolean
    cronPattern: string
    thresholdMinutes: number
    nextRun: string | null
  } {
    return {
      isRunning: !!this.job,
      cronPattern: this.CRON_PATTERN,
      thresholdMinutes: this.ABANDONMENT_THRESHOLD_MINUTES,
      nextRun: this.job?.nextDate()?.toISO() || null,
    }
  }
}

// Export singleton instance
export const abandonedOrdersCleanupJob = new AbandonedOrdersCleanupJob()
