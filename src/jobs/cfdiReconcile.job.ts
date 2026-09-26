/**
 * Cada cinco minutos: concilia intentos inciertos y repara archivos de timbres confirmados.
 * Consultas de entrada con retry de conexión, páginas acotadas y fallos aislados por CFDI.
 * RESET conserva versión/sellos; nunca autoriza un nuevo envío por el mero paso del tiempo.
 */

import { Prisma } from '@prisma/client'
import { completarArchivos } from '../services/fiscal/finalizadorCfdi'
import { resolveFiscalProvider } from '../services/fiscal/fiscalProvider.factory'
import { CronJob } from 'cron'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { reconcileStuckCfdi, StuckCfdi } from '../services/fiscal/cfdiReconcile.service'
import {
  CANCEL_SYNC_MAX_PER_TICK,
  refreshPendingCancellation,
  syncPendingCancellations,
  tocaRevisarCancelaciones,
} from '../services/fiscal/cfdi.service'
import { NODE_ENV } from '../config/env'
import { asegurarWebhooksFaltantes, defaultAsegurarFaltantesDeps } from '../services/fiscal/facturapiWebhook.service'
import { scheduleJob } from '../observability/jobContext'

// Antigüedad mínima; el CAS igualmente protege las respuestas concurrentes.
const STUCK_THRESHOLD_MS = 10 * 60_000

// Bound how many stuck rows a single tick processes (defensive — there should rarely be any).
const MAX_PER_TICK = 200

export class CfdiReconcileJob {
  private job: CronJob | null = null
  private isRunning = false
  // ponytail: cursores de una instancia, reinician con el proceso; persistir si reinicios/múltiples workers frenan el avance.
  private reconcileCursor: { updatedAt: Date; id: string } | null = null
  private artifactCursor: { stampedAt: Date; id: string } | null = null
  /** Última pasada del barrido de cancelaciones (en memoria: el server corre UNA instancia). */
  private ultimaRevisionDeCancelaciones: number | null = null

  constructor() {
    // Every 5 minutes at :02 offset — avoids aligning with top-of-hour / :00 / :05 cron bursts.
    this.job = scheduleJob(
      'cfdi-reconcile',
      '2-59/5 * * * *',
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
    logger.info('[cfdiReconcile] job started — every 5 minutes')
  }

  stop(): void {
    this.job?.stop()
    logger.info('[cfdiReconcile] job stopped')
  }

  /** Manual trigger (for testing / ad-hoc execution). */
  async runNow(): Promise<void> {
    await this.run()
  }

  private async run(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[cfdiReconcile] tick skipped — previous run still in progress')
      return
    }
    this.isRunning = true
    const startTime = Date.now()

    try {
      // Pase 1: cancelaciones que el SAT dejó «en trámite». Independiente del pase de STAMPING: si falla,
      // no impide conciliar timbres atorados (y viceversa).
      // Red de seguridad del webhook de Facturapi: una pasada por hora (ver CANCEL_SYNC_EVERY_MS).
      if (tocaRevisarCancelaciones(this.ultimaRevisionDeCancelaciones, startTime)) {
        this.ultimaRevisionDeCancelaciones = startTime
        await this.syncCancellations(startTime)
        await this.webhooksFaltantes()
      }

      const cutoff = new Date(startTime - STUCK_THRESHOLD_MS)

      // ── Entry read: stuck STAMPING rows older than the threshold ───────────
      // MANDATORY per .claude/rules/cron-jobs.md: wrap with retry to survive the
      // top-of-hour P1001 connection stampede. Pure read — safe to run twice.
      const stuck = (await retry(
        () =>
          prisma.cfdi.findMany({
            where: {
              OR: [{ status: 'STAMPING' }, { status: 'STAMP_FAILED', protocoloIva: 1, falloDefinitivo: false, enviadoAt: { not: null } }],
              updatedAt: { lt: cutoff },
              ...(this.reconcileCursor
                ? {
                    AND: [
                      {
                        OR: [
                          { updatedAt: { gt: this.reconcileCursor.updatedAt } },
                          { updatedAt: this.reconcileCursor.updatedAt, id: { gt: this.reconcileCursor.id } },
                        ],
                      },
                    ],
                  }
                : {}),
            },
            orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
            take: MAX_PER_TICK,
            select: {
              id: true,
              venueId: true,
              fiscalEmisorId: true,
              status: true,
              attempts: true,
              protocoloIva: true,
              falloDefinitivo: true,
              enviadoAt: true,
              isGlobal: true,
              orderId: true,
              facturapiId: true,
              idempotencyKey: true,
              receptorRfc: true,
              totalCents: true,
              createdAt: true,
              updatedAt: true,
            },
          }),
        {
          retries: 2,
          initialDelay: 1500,
          shouldRetry: shouldRetryDbConnectionError,
          context: 'cfdiReconcile.findStuck',
        },
      )) as StuckCfdi[]

      const last = stuck.at(-1)
      this.reconcileCursor = last ? { updatedAt: last.updatedAt, id: last.id } : null
      const sandbox = NODE_ENV !== 'production'
      const now = new Date()
      const tally: Record<string, number> = { COMPLETED: 0, RESET: 0, INCONCLUSIVE: 0, SKIPPED: 0, ERROR: 0 }

      // ── Per-row processing — isolated try/catch ───────────────────────────
      for (const cfdi of stuck) {
        try {
          const result = await reconcileStuckCfdi({ cfdi, now, sandbox })
          tally[result.outcome] = (tally[result.outcome] ?? 0) + 1
          logger.info(`[cfdiReconcile] cfdi=${cfdi.id} outcome=${result.outcome}${result.detail ? ` (${result.detail})` : ''}`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.error(`[cfdiReconcile] unhandled error for cfdi=${cfdi.id}: ${message}`)
          tally.ERROR += 1
        }
      }

      await this.repairArtifacts(cutoff)

      const durationMs = Date.now() - startTime
      if (stuck.length) logger.info(`[cfdiReconcile] tick complete — ${stuck.length} row(s) in ${durationMs}ms`, { tally })
    } catch (err) {
      logger.error('[cfdiReconcile] tick failed (top-level)', err)
    } finally {
      this.isRunning = false
    }
  }

  private async repairArtifacts(cutoff: Date): Promise<void> {
    const rows = await retry(
      () =>
        prisma.cfdi.findMany({
          where: {
            status: 'STAMPED',
            stampedAt: { lt: cutoff },
            OR: [{ taxBreakdown: { equals: Prisma.DbNull } }, { xmlUrl: null }],
            ...(this.artifactCursor
              ? {
                  AND: [
                    {
                      OR: [
                        { stampedAt: { gt: this.artifactCursor.stampedAt } },
                        { stampedAt: this.artifactCursor.stampedAt, id: { gt: this.artifactCursor.id } },
                      ],
                    },
                  ],
                }
              : {}),
          },
          orderBy: [{ stampedAt: 'asc' }, { id: 'asc' }],
          take: 20,
          select: {
            id: true,
            stampedAt: true,
            idempotencyKey: true,
            attempts: true,
            facturapiId: true,
            uuid: true,
            venue: { select: { slug: true } },
            fiscalEmisor: { select: { id: true, provider: true, providerKeyEnc: true } },
          },
        }),
      { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'cfdiReconcile.findMissingArtifacts' },
    )
    const last = rows.at(-1)
    this.artifactCursor = last?.stampedAt ? { stampedAt: last.stampedAt, id: last.id } : null
    for (const row of rows) {
      try {
        if (!row.facturapiId || !row.uuid) continue
        await completarArchivos({
          cfdiId: row.id,
          idempotencyKey: row.idempotencyKey,
          version: row.attempts,
          providerInvoiceId: row.facturapiId,
          uuid: row.uuid,
          venueSlug: row.venue.slug,
          provider: resolveFiscalProvider(row.fiscalEmisor, { sandbox: NODE_ENV !== 'production' }),
        })
      } catch (err) {
        logger.error(`[cfdiReconcile] reparación de archivos falló cfdi=${row.id}`, err)
      }
    }
  }

  /**
   * Le pregunta al PAC por las cancelaciones que quedaron «en trámite». Sin esto una factura cancelada en
   * el SAT seguía «Timbrada» en Avoqado para siempre y la venta no se podía volver a facturar
   * (Testarudo, A-14, 21→24-sep-2026). Silencioso cuando no hay nada pendiente.
   */
  private async syncCancellations(startTime: number): Promise<void> {
    try {
      const sandbox = NODE_ENV !== 'production'
      const tally = await syncPendingCancellations(
        { sandbox, now: new Date(startTime) },
        {
          findPending: cutoff =>
            retry(
              () =>
                prisma.cfdi.findMany({
                  where: { cancelStatus: 'REQUESTED', cancelRequestedAt: { lt: cutoff } },
                  orderBy: [{ cancelRequestedAt: 'asc' }, { id: 'asc' }],
                  take: CANCEL_SYNC_MAX_PER_TICK,
                  include: { fiscalEmisor: true },
                }),
              { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'cfdiReconcile.findPendingCancels' },
            ),
          refresh: cfdi => refreshPendingCancellation(cfdi, { sandbox }),
        },
      )
      if (tally.revisadas > 0) logger.info('[cfdiReconcile] cancelaciones en trámite revisadas', { tally })
    } catch (err) {
      logger.error('[cfdiReconcile] no se pudieron revisar las cancelaciones en trámite', err)
    }
  }

  /** Emisores sin webhook de Facturapi (los que ya existían, o a los que les falló el alta). Silencioso si no hay. */
  private async webhooksFaltantes(): Promise<void> {
    try {
      const deps = defaultAsegurarFaltantesDeps()
      const tally = await asegurarWebhooksFaltantes({
        ...deps,
        findSinWebhook: () =>
          retry(deps.findSinWebhook, {
            retries: 2,
            initialDelay: 1500,
            shouldRetry: shouldRetryDbConnectionError,
            context: 'cfdiReconcile.findEmisoresSinWebhook',
          }),
      })
      if (tally.revisados > 0) logger.info('[cfdiReconcile] webhooks de Facturapi dados de alta', { tally })
    } catch (err) {
      logger.warn('[cfdiReconcile] no se pudieron revisar los webhooks de Facturapi', err)
    }
  }
}

// Export singleton instance — server.ts calls .start() and .stop()
export const cfdiReconcileJob = new CfdiReconcileJob()
