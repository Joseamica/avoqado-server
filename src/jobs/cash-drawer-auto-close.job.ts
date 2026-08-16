// src/jobs/cash-drawer-auto-close.job.ts

/**
 * Cierra las sesiones de caja que nadie cerró, en el corte del día de negocio.
 *
 * Toda la lógica (y el porqué de cada regla de seguridad) vive en
 * `services/shared/cashDrawerAutoClose.ts` — este archivo sólo es el reloj. Está
 * partido así a propósito: el script de producción
 * `scripts/close-stale-cash-drawer-sessions.ts` llama a la MISMA función, que es
 * la única forma de garantizar que las sesiones colgadas queden con exactamente
 * la misma marca que las que cierre el cron de aquí en adelante.
 *
 * 🔴 Este job NO toca `prisma` directamente: la lectura de entrada va envuelta en
 * `retry(..., shouldRetryDbConnectionError)` dentro del servicio
 * (`.claude/rules/cron-jobs.md`, y `tests/unit/jobs/jobDbRetryGuard.test.ts`
 * explícitamente exime a los jobs que delegan su acceso a DB en un servicio).
 *
 * **Cadencia: cada hora al minuto 26.** No una vez al día porque el corte se
 * calcula en el huso de CADA venue: México tiene varios husos y algún día habrá
 * venues fuera. Por hora, cada venue se barre dentro de la hora siguiente a su
 * propio corte. El minuto 26 está libre en `jobSchedules`/el resto de los jobs —
 * arrancar en :00 es lo que provocó la estampida de P1001 de 2026-05-26.
 */

import type { CronJob } from 'cron'

import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { autoCloseStaleDrawerSessions, type AutoCloseOptions, type AutoCloseSummary } from '../services/shared/cashDrawerAutoClose'
import prisma from '../utils/prismaClient'
import { retry } from '../utils/retry'

/** Cada hora al minuto 26 (offset deliberado: ver el encabezado). */
export const CASH_DRAWER_AUTO_CLOSE_CRON = '26 * * * *'

type CronHandle = Pick<CronJob, 'start' | 'stop'>

interface CashDrawerAutoCloseDependencies {
  prisma: typeof prisma
  cron?: CronHandle
  now: () => Date
  retryEntry: typeof retry
}

const defaults: CashDrawerAutoCloseDependencies = {
  prisma,
  now: () => new Date(),
  retryEntry: retry,
}

export class CashDrawerAutoCloseJob {
  private readonly dependencies: CashDrawerAutoCloseDependencies
  private readonly cron: CronHandle
  private running = false

  constructor(overrides: Partial<CashDrawerAutoCloseDependencies> = {}) {
    this.dependencies = { ...defaults, ...overrides }
    this.cron =
      overrides.cron ??
      scheduleJob(
        'cash-drawer-auto-close',
        CASH_DRAWER_AUTO_CLOSE_CRON,
        () => {
          void this.runNow().catch(error => logger.error('Cash drawer auto-close failed', { error }))
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    logger.info(`💵 Cash drawer auto-close started (${CASH_DRAWER_AUTO_CLOSE_CRON}) — cierra cajas al terminar el día de negocio`)
  }

  stop(): void {
    this.cron.stop()
    logger.info('💵 Cash drawer auto-close stopped')
  }

  async runNow(options: Pick<AutoCloseOptions, 'dryRun' | 'venueIds' | 'sessionIds'> = {}): Promise<AutoCloseSummary> {
    // Una pasada encimada volvería a leer las mismas sesiones. El CAS ya impide el
    // daño, pero el trabajo duplicado no aporta nada.
    if (this.running) {
      logger.warn('💵 Cash drawer auto-close: se omite una pasada encimada')
      return { scanned: 0, closed: 0, skipped: 1, errors: 0, dryRun: options.dryRun ?? false, closedSessions: [] }
    }
    this.running = true
    try {
      const summary = await autoCloseStaleDrawerSessions({
        ...options,
        prisma: this.dependencies.prisma,
        now: this.dependencies.now(),
        retryEntry: this.dependencies.retryEntry,
      })

      if (summary.closed > 0 || summary.errors > 0) {
        logger.info('💵 Cash drawer auto-close: pasada terminada', {
          scanned: summary.scanned,
          closed: summary.closed,
          skipped: summary.skipped,
          errors: summary.errors,
          dryRun: summary.dryRun,
        })
      }

      return summary
    } finally {
      this.running = false
    }
  }
}

export const cashDrawerAutoCloseJob = new CashDrawerAutoCloseJob()
