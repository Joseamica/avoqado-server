// jobs/abandoned-orders-cleanup.job.ts

import { CronJob } from 'cron'
import { Prisma } from '@prisma/client'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { lockExistingOrderForPayment } from '../services/shared/paymentShiftClaim'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { utcTs } from '../utils/sqlDates'

/**
 * Qué es una orden abandonada — UNA sola definición, evaluada dos veces: al elegir candidatas y otra vez bajo el candado
 * de la orden, justo antes de borrarla. `Payment` y `OrderItem` cuelgan de la orden con `onDelete: Cascade`, así que sin
 * la segunda lectura un cobro o un renglón que entrara entre las dos se iba con la orden, sin rastro.
 *
 * Una solicitud de cobro a la terminal nombra la orden SIN llave foránea: la protege (una aprobación tardía tiene que
 * encontrarla), salvo que sea una LÁPIDA de admisión (`FAILED` + `REJECTED_…`, ver `terminal-payment.service.ts`), que
 * prueba que ese cobro nunca se creó. Va DENTRO de la selección: una orden protegida no puede ocupar el lote y atorar para
 * siempre a las que sí están abandonadas. El `IS NOT NULL` no es adorno: un FAILED sin código debe proteger, y sin él el
 * `NOT (…)` de un NULL la dejaría pasar.
 */
const abandonada = (threshold: Date): Prisma.Sql => Prisma.sql`
  o.type = 'TAKEOUT' AND o.status = 'PENDING' AND o."paymentStatus" = 'PENDING'
  AND o."createdAt" < ${utcTs(threshold)} AND o."updatedAt" < ${utcTs(threshold)}
  AND NOT EXISTS (SELECT 1 FROM "OrderItem" i WHERE i."orderId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM "Payment" p WHERE p."orderId" = o.id)
  AND NOT EXISTS (
    SELECT 1 FROM "TerminalPaymentRequest" r
    WHERE r."venueId" = o."venueId" AND r."orderId" = o.id
      AND NOT (r.status = 'FAILED' AND r."failureCode" IS NOT NULL AND left(r."failureCode", 9) = 'REJECTED_')
  )`

/** Candidatas por pasada: la limpieza corre cada 15 min y alcanza el resto en las siguientes. */
const LOTE = 200

/** Lo que hizo una pasada. `kept` = cambió o empezó a usarse después de elegirla; `failed` = no se pudo borrar. */
export interface ResultadoDeLimpieza {
  selected: number
  deleted: number
  kept: number
  failed: number
}

interface Candidata {
  id: string
  venueId: string
  orderNumber: string
  type: string
  createdAt: Date
  tableNumber: string | null
}

/**
 * Job que limpia órdenes abandonadas (vacías sin items)
 *
 * **Problema**: Cuando el usuario hace "Pedido rápido" pero presiona Atrás,
 * la orden queda creada en estado PENDING sin items, acumulándose en el sistema.
 *
 * **Solución**: Auto-eliminar órdenes que:
 * - ✅ Tienen 0 items y 0 cobros (de cualquier estado)
 * - ✅ Status = PENDING (no han sido pagadas)
 * - ✅ Creadas Y tocadas por última vez hace > 30 minutos
 * - ✅ Type = TAKEOUT (no eliminar órdenes de mesas)
 * - ✅ Sin una solicitud de cobro a la terminal que la mencione (salvo una lápida de admisión)
 * Cada una se vuelve a comprobar bajo su candado antes de borrarla (ver `abandonada`).
 *
 * **Frecuencia**: Cada 15 minutos
 *
 * **Inspiración**: Toast POS usa auto-cleanup cada 30 min para "draft orders"
 */
export class AbandonedOrdersCleanupJob {
  private job: CronJob | null = null
  private readonly ABANDONMENT_THRESHOLD_MINUTES = 30
  private readonly CRON_PATTERN = '*/15 * * * *' // Every 15 minutes
  private readonly lote: number

  constructor(opts: { lote?: number } = {}) {
    this.lote = opts.lote ?? LOTE
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
  async cleanupNow(): Promise<ResultadoDeLimpieza> {
    return this.runOnce()
  }

  /**
   * Main cleanup function
   * Deletes empty TAKEOUT orders older than threshold
   */
  /** What the scheduler runs: its tick type is `() => void | Promise<void>`, so the summary stays in `runOnce`. */
  private async cleanupAbandonedOrders(): Promise<void> {
    await this.runOnce()
  }

  private async runOnce(): Promise<ResultadoDeLimpieza> {
    const result: ResultadoDeLimpieza = { selected: 0, deleted: 0, kept: 0, failed: 0 }
    try {
      const thresholdDate = new Date()
      thresholdDate.setMinutes(thresholdDate.getMinutes() - this.ABANDONMENT_THRESHOLD_MINUTES)

      logger.debug(`🧹 [CLEANUP] Checking for abandoned orders (empty, PENDING, TAKEOUT, created before ${thresholdDate.toISOString()})`)

      // Find abandoned orders: the database applies the whole rule and caps the batch, oldest first with a unique tie-breaker.
      const emptyOrders = await retry(
        () =>
          prisma.$queryRaw<Candidata[]>`
            SELECT o.id, o."venueId", o."orderNumber", o.type::text AS type, o."createdAt", t.number AS "tableNumber"
            FROM "Order" o
            LEFT JOIN "Table" t ON t.id = o."tableId"
            WHERE ${abandonada(thresholdDate)}
            ORDER BY o."createdAt" ASC, o.id ASC
            LIMIT ${this.lote}`,
        { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'abandoned-orders-cleanup.findAbandoned' },
      )
      result.selected = emptyOrders.length

      if (emptyOrders.length === 0) {
        logger.debug('🧹 [CLEANUP] No abandoned orders found')
        return result
      }

      logger.info(`🧹 [CLEANUP] Found ${emptyOrders.length} abandoned empty orders to delete`)

      for (const order of emptyOrders) {
        try {
          // Lock the order, reread the SAME rule, and only then delete. A payment or item written concurrently holds the
          // order's foreign-key lock, so the lock waits for it and the reread sees it: the order is kept.
          const wasDeleted = await prisma.$transaction(
            async tx => {
              if (!(await lockExistingOrderForPayment(tx, { venueId: order.venueId, orderId: order.id }))) return false
              const still = await tx.$queryRaw<Array<{ id: string }>>`
                SELECT o.id FROM "Order" o WHERE o.id = ${order.id} AND o."venueId" = ${order.venueId} AND ${abandonada(thresholdDate)}`
              if (still.length === 0) return false
              await tx.order.delete({ where: { id: order.id } })
              return true
            },
            { timeout: 15_000, maxWait: 5_000 },
          )
          if (!wasDeleted) {
            result.kept += 1
            logger.info(`  ↩️  Kept order ${order.orderNumber}: it changed or is in use since it was selected`)
            continue
          }
          result.deleted += 1
          const age = Math.floor((Date.now() - new Date(order.createdAt).getTime()) / (1000 * 60))
          logger.info(
            `  🗑️  Deleted order ${order.orderNumber} (${order.type}, created ${age} min ago, table: ${order.tableNumber || 'N/A'})`,
          )
        } catch (error) {
          // One order that cannot go (for example, a restricted child) must not stop the rest of the batch.
          result.failed += 1
          logger.error(`❌ [CLEANUP] Could not delete abandoned order ${order.orderNumber}:`, error)
        }
      }

      logger.info(`✅ [CLEANUP] Deleted ${result.deleted} abandoned orders (kept ${result.kept}, failed ${result.failed})`)
    } catch (error) {
      result.failed += 1
      logger.error('❌ [CLEANUP] Error during abandoned orders cleanup:', error)
    }
    return result
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
