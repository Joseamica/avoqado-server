/**
 * CFDI Global Job (Flow C)
 *
 * Daily cron job that issues a factura global to "Público en General" (RFC XAXX010101000)
 * for each active FiscalEmisor, covering all PAID orders in the most-recently closed period
 * (per the emisor's globalPeriodicity) that were NOT individually invoiced (Flow A/B).
 *
 * C1 (Tarea 8, «ningún periodo se pierde»): per emisor it runs `emitirGlobalesPendientes`:
 *   (1) one page (10) of its unstamped globals of ANY period, resumed with a cursor `(updatedAt, id)` kept here per emisor;
 *   (2) the recent closed periods (`PERIODOS_A_REVISAR`) that still have no principal global, oldest first.
 * Each row / period is isolated inside the service; the summary has one line per result. Emisores are read by id, 100 per page.
 *
 * Schedule: 0 4 * * * (04:00 AM Mexico City — after day-close, before opening hours)
 *
 * Rules:
 *   - Entry DB read MUST be wrapped with retry(fn, shouldRetryDbConnectionError) per
 *     .claude/rules/cron-jobs.md (prevents P1001 stampede deaths at top-of-hour).
 *   - Per-emisor try/catch: one emisor's failure must not abort the rest.
 *   - Job does NOT start in test environments (NODE_ENV guard in server.ts).
 */

import { CronJob } from 'cron'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { emitirGlobalesPendientes, type CursorDePendientes, type IssueGlobalResult } from '../services/fiscal/cfdiGlobal.service'
import { NODE_ENV } from '../config/env'
import { scheduleJob } from '../observability/jobContext'

/** Emisores leídos por página (por `id`). */
const EMISORES_POR_PAGINA = 100

export class CfdiGlobalJob {
  private job: CronJob | null = null
  private isRunning = false
  /** C1 (C1-15): dónde se quedó la pasada de pendientes de cada emisor (en memoria; si el proceso reinicia, vuelve a empezar desde el inicio). */
  private cursores = new Map<string, CursorDePendientes | null>()

  constructor() {
    // 04:00 AM Mexico City — offset from hour boundary to reduce stampede overlap
    this.job = scheduleJob(
      'cfdi-global',
      '0 4 * * *',
      async () => {
        await this.run()
      },
      null,
      false, // Don't start automatically — server.ts calls .start()
      'America/Mexico_City',
    )
  }

  start(): void {
    this.job?.start()
    logger.info('[cfdiGlobal] job started — daily at 04:00 AM Mexico City')
  }

  stop(): void {
    this.job?.stop()
    logger.info('[cfdiGlobal] job stopped')
  }

  /** Manual trigger (for testing / ad-hoc execution). */
  async runNow(): Promise<void> {
    await this.run()
  }

  private async run(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[cfdiGlobal] tick skipped — previous run still in progress')
      return
    }
    this.isRunning = true
    const startTime = Date.now()

    try {
      logger.info('[cfdiGlobal] tick started')

      const sandbox = NODE_ENV !== 'production'
      const now = new Date()
      const summary: Array<{
        emisorId: string
        status: string
        period?: string
        count?: number
        excluidas?: IssueGlobalResult['excluidas']
        reason?: string
      }> = []
      let emisoresVistos = 0
      let after: string | undefined

      // ── Emisores con CSD activo, de 100 en 100 por id ────────────────────
      // MANDATORY per .claude/rules/cron-jobs.md: each page read is wrapped with retry to prevent
      // P1001 stampede deaths when many crons fire at the same top-of-hour.
      for (;;) {
        const pagina = await retry(
          () =>
            prisma.fiscalEmisor.findMany({
              where: { csdStatus: 'ACTIVE', ...(after ? { id: { gt: after } } : {}) },
              select: { id: true },
              orderBy: { id: 'asc' },
              take: EMISORES_POR_PAGINA,
            }),
          {
            retries: 2,
            initialDelay: 1500,
            shouldRetry: shouldRetryDbConnectionError,
            context: 'cfdiGlobal.findActiveEmisores',
          },
        )
        emisoresVistos += pagina.length

        // ── Per-emisor processing — isolated try/catch ──────────────────────
        for (const { id: emisorId } of pagina) {
          try {
            const { resultados, cursor } = await emitirGlobalesPendientes({
              emisorId,
              now,
              sandbox,
              cursor: this.cursores.get(emisorId) ?? null,
            })
            this.cursores.set(emisorId, cursor)
            for (const r of resultados) {
              const periodLabel = r.period
                ? `${r.period.periodStart.toISOString().slice(0, 10)} (${r.period.meses}/${r.period.anio})`
                : 'n/a'
              const reason = r.reason ?? r.reasons?.join(' | ')
              // C1 (Tarea 10): qué quedó fuera, por motivo (configuración y contenido), en el renglón de cada resultado; vacío, no se escribe.
              const fuera = r.excluidas && Object.keys(r.excluidas).length ? ` excluidas=${JSON.stringify(r.excluidas)}` : ''
              logger.info(
                `[cfdiGlobal] emisor=${emisorId} status=${r.status} period=${periodLabel} candidates=${r.candidateCount ?? 0}${fuera}${reason ? ` reason=${reason}` : ''}`,
              )
              summary.push({ emisorId, status: r.status, period: periodLabel, count: r.candidateCount, excluidas: r.excluidas, reason })
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            logger.error(`[cfdiGlobal] unhandled error for emisor=${emisorId}: ${message}`)
            summary.push({ emisorId, status: 'ERROR', reason: message })
          }
        }
        if (pagina.length < EMISORES_POR_PAGINA) break
        after = pagina[pagina.length - 1].id
      }
      logger.info(`[cfdiGlobal] found ${emisoresVistos} active emisor(s)`)

      const durationMs = Date.now() - startTime
      // m3 (ronda 1 de la T8): conteos por estado y sólo los renglones que piden atención (los demás ya salieron en su `logger.info`); con
      // cientos de emisores diarios, el resumen entero en una línea se truncaría en Better Stack.
      const porEstado: Record<string, number> = {}
      for (const r of summary) porEstado[r.status] = (porEstado[r.status] ?? 0) + 1
      const atencion = summary.filter(r => r.status !== 'STAMPED' && r.status !== 'NOTHING_TO_INVOICE')
      logger.info(`[cfdiGlobal] tick complete — ${emisoresVistos} emisor(s) in ${durationMs}ms`, { porEstado, atencion })
    } catch (err) {
      logger.error('[cfdiGlobal] tick failed (top-level)', err)
    } finally {
      this.isRunning = false
    }
  }
}

// Export singleton instance — server.ts calls .start() and .stop()
export const cfdiGlobalJob = new CfdiGlobalJob()
