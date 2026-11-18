// jobs/blumon-webhook-reconciliation.job.ts

import { CronJob } from 'cron'
import { EventStatus, Prisma, ProviderType } from '@prisma/client'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import {
  BLUMON_WEBHOOK_ERROR_REASONS,
  BLUMON_WEBHOOK_PENDING_TTL_MS,
  BlumonWebhookPayload,
  RETENCION_DIFERIDA,
  REVERSAL_OPERATION_TYPES,
  reconcileBlumonEvent,
} from '../services/tpv/blumon-webhook.service'
import { sdkPropioEncendido, soltarRetencionesDeReversados, vencerLapidasSinRespuesta } from '../services/tpv/reversoDeLaTerminal.service'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'
import { scheduleJob } from '../observability/jobContext'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'

/**
 * Familia D: lo que el núcleo contesta SIN lanzar pero no es desenlace — el registrador cayó (su candado, la base:
 * `PROCESSING_ERROR`, el aviso sigue PENDING) o la re-retención de la solicitud se difirió (`HOLD_DEFERRED`).
 */
function esFallaTransitoria(r: { errorReason?: string; message?: string }): boolean {
  return r.errorReason === BLUMON_WEBHOOK_ERROR_REASONS.PROCESSING_ERROR || r.message === RETENCION_DIFERIDA
}

/**
 * Blumon TPV webhook async reconciliation job
 *
 * Handles the residual cases that the inline 5s retry inside
 * `processBlumonPaymentWebhook` cannot cover:
 *
 *   • TPV recorded the Payment 30s+ after Blumon webhook arrived (slow 4G,
 *     offline queue replay, app killed mid-record).
 *   • TPV will eventually record it within 24h (offline queue is bounded by
 *     `PaymentSyncWorker` retries on the device).
 *
 * Strategy
 * --------
 * 1. Every 30s pull up to 100 PENDING events, oldest first: those WITHOUT saved
 *    context (`nextAttemptAt` null — today's traffic) only while younger than 24h,
 *    exactly as `develop`; those WITH context (only born with the SDK-propio switch
 *    on) once their turn arrived, also past 24h (they get a last retry, F5).
 * 2. Try the same matching logic again — but with `skipRetries=true` since
 *    we're already on a periodic schedule.
 * 3. Update each event row inline (status=PROCESSED on match,
 *    status=ERROR + errorReason=AMOUNT_MISMATCH on discrepancy, stays PENDING
 *    if still no match).
 * 4. Once per pass, sweep events older than 24h still PENDING → ERROR with
 *    errorReason=ORPHANED. Without context, all of them (as `develop`); with
 *    context, only those THIS pass retried with an outcome (F5 / family D).
 *    Ops dashboards filter on that.
 * 5. (SDK propio, Tarea 6) Nothing is touched before its `nextAttemptAt` (the
 *    receiver's exclusive window). An event that entered WITH our attempt link
 *    is recovered by `reconcileBlumonEvent` through the shared core, with the
 *    identity and tariff saved at ingress — never the weak matching.
 * 6. (SDK propio, Tarea 7) Before anything else, each pass expires reversal
 *    tombstones still `reversing` past `VENTANA_DEL_REVERSO_MS` (→
 *    `reverse_unconfirmed`), so a webhook held by one is released in the same pass.
 *    Only with the SDK-propio switch on (`sdkPropioEncendido`, redesign v2).
 *
 * Pattern matches the existing `AbandonedOrdersCleanupJob` / `tpvHealthMonitorJob`
 * structure used elsewhere in the codebase. Singleton, registered in
 * `src/server.ts`, gracefully stopped on SIGTERM.
 */
export class BlumonWebhookReconciliationJob {
  private job: CronJob | null = null

  /** Run every 30 seconds — sub-minute is fine, the work per pass is small. */
  private readonly CRON_PATTERN = DATABASE_JOB_SCHEDULES.blumonWebhookReconciliation
  private isRunning = false

  /** Cap per pass to avoid long transactions if a backlog builds up. */
  private readonly BATCH_SIZE = 100

  constructor() {
    this.job = scheduleJob('blumon-webhook-reconciliation', this.CRON_PATTERN, this.run.bind(this), null, false, 'America/Mexico_City')
  }

  start(): void {
    if (this.job) {
      this.job.start()
      logger.info(
        `🪝 Blumon webhook reconciliation job started — every 30s, batch ${this.BATCH_SIZE}, TTL ${BLUMON_WEBHOOK_PENDING_TTL_MS / 3600_000}h`,
      )
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('🪝 Blumon webhook reconciliation job stopped')
    }
  }

  private async run(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[Blumon recon] tick skipped — previous run still in progress')
      return
    }
    this.isRunning = true
    const startedAt = Date.now()
    try {
      // Un solo «ahora» por pase (Tarea 7, pendiente de la 6): lo que `reconcilePending` deja fuera por su turno, `markOrphaned`
      // tampoco lo vence. Primero las lápidas del reverso que vencieron: así su aviso retenido sale en este mismo pase.
      const ahora = new Date()
      let lapidasVencidas = 0
      // Rediseño v2: con el candado del SDK propio apagado no hay lápidas que barrer (sus rutas no existen): el pase es el de develop.
      if (sdkPropioEncendido()) {
        // F8: una falla del barrido de lápidas (p. ej. P1001) no tumba el pase: los avisos pendientes se recuperan igual.
        try {
          lapidasVencidas = await vencerLapidasSinRespuesta(ahora)
        } catch (err) {
          logger.error('❌ [Blumon recon] El barrido de lápidas del reverso falló — el pase sigue con los avisos pendientes', {
            error: err instanceof Error ? err.message : err,
            stack: err instanceof Error ? err.stack : undefined,
          })
        }
        // Familia C: las solicitudes que la ventana retuvo por un aviso que la terminal ya reversó y que nadie soltó.
        try {
          await soltarRetencionesDeReversados(ahora)
        } catch (err) {
          logger.error('❌ [Blumon recon] El barrido de retenciones de avisos reversados falló — el pase sigue', {
            error: err instanceof Error ? err.message : err,
            stack: err instanceof Error ? err.stack : undefined,
          })
        }
      }
      // F5: los avisos CON contexto que este pase intentó; `markOrphaned` no vence uno que no se intentó (quedó fuera del lote).
      const intentados = new Set<string>()
      const reconciled = await this.reconcilePending(ahora, intentados)
      const orphaned = await this.markOrphaned(ahora, intentados)
      if (reconciled > 0 || orphaned > 0 || lapidasVencidas > 0) {
        logger.info('🪝 [Blumon recon] Pass complete', {
          lapidasVencidas,
          reconciled,
          orphaned,
          elapsedMs: Date.now() - startedAt,
        })
      }
    } catch (err) {
      logger.error('❌ [Blumon recon] Job pass failed', {
        error: err instanceof Error ? err.message : err,
        stack: err instanceof Error ? err.stack : undefined,
      })
    } finally {
      this.isRunning = false
    }
  }

  /**
   * Pull PENDING events and retry matching once each.
   * Returns the count of events that newly transitioned out of PENDING.
   */
  async reconcilePending(now: Date = new Date(), intentados?: Set<string>): Promise<number> {
    const cutoff = new Date(now.getTime() - BLUMON_WEBHOOK_PENDING_TTL_MS)
    const pending = await retry(
      () =>
        prisma.providerEventLog.findMany({
          take: this.BATCH_SIZE,
          where: {
            provider: ProviderType.PAYMENT_PROCESSOR,
            status: EventStatus.PENDING,
            // Only Blumon TPV events have eventId starting with 'blumon-tpv-'.
            // Use a startsWith to leave room for other providers in the same table.
            eventId: { startsWith: 'blumon-tpv-' },
            AND: [
              // Reversals are informational — they must never enter the sale
              // reconciliation path. Written as an explicit exclusion (rather than
              // `type: 'VENTA'`) so rows typed 'UNKNOWN' or null — which ARE sales —
              // keep being reconciled.
              { OR: [{ type: null }, { type: { notIn: [...REVERSAL_OPERATION_TYPES] } }] },
              {
                OR: [
                  // Rediseño v2 (Codex r4 #3–#5): sin contexto (`nextAttemptAt` null, el tráfico de hoy), la selección de develop:
                  // sólo dentro de la ventana de 24 h. Uno vencido nunca vuelve a la búsqueda automática (un código de
                  // autorización reciclado lo casaría con otro cobro): `markOrphaned` lo manda a conciliación manual.
                  { nextAttemptAt: null, createdAt: { gte: cutoff } },
                  // Tarea 6: con contexto (sólo con el candado prendido), nada antes de su turno; pasadas las 24 h también, para
                  // que reciba su último intento antes del vencimiento (F5).
                  { nextAttemptAt: { lte: now } },
                ],
              },
            ],
          },
          orderBy: { createdAt: 'asc' },
          select: { id: true, payload: true },
        }),
      { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'blumon-webhook-reconciliation.findPending' },
    )

    if (pending.length === 0) return 0

    let resolved = 0
    for (const row of pending) {
      try {
        const payload = row.payload as unknown as BlumonWebhookPayload
        // No explicit scope — `reconcileBlumonEvent` re-resolves the venue
        // scope from `payload.serialNumber` on every pass so a shared Blumon
        // MerchantAccount (one merchant → N venues) doesn't get pinned to the
        // single terminal's venue that was cached at insert time.
        const result = await reconcileBlumonEvent(row.id, payload)
        // Familia D (filas con contexto): sólo cuenta como intentado (y `markOrphaned` puede vencerlo) el aviso cuyo intento terminó
        // con un desenlace. Una excepción (la lectura de recuperación, la base) o una falla transitoria que el núcleo contesta sin
        // lanzar —el registrador cayó (su candado, la base) o la re-retención se difirió— lo deja PENDING para el siguiente pase.
        if (!esFallaTransitoria(result)) intentados?.add(row.id)
        // Con contexto, el núcleo contesta PENDING cuando el evento sigue esperando (p. ej. AMOUNT_MISMATCH): no salió.
        // HELD_BY_REVERSAL: retenido por la lápida del reverso, sigue PENDING.
        if (result.action !== 'NOT_FOUND' && result.action !== 'PENDING' && result.action !== 'HELD_BY_REVERSAL') resolved++
      } catch (err) {
        logger.error('❌ [Blumon recon] Failed to retry event', {
          eventLogId: row.id,
          error: err instanceof Error ? err.message : err,
        })
      }
    }

    return resolved
  }

  /**
   * Promote stale PENDING events (> TTL) to ERROR with errorReason=ORPHANED.
   * Bulk update is fine — these are not eligible for further retries.
   * Sin contexto (`nextAttemptAt` null, el tráfico de hoy): todos los de más de 24 h, como en develop (rediseño v2). Con contexto
   * (F5): sólo si ESTE pase lo intentó con un desenlace (`intentados`) y ya era su turno; uno que quedó fuera del lote o cuyo
   * intento falló espera al siguiente pase.
   */
  async markOrphaned(now: Date = new Date(), intentados: ReadonlySet<string> = new Set()): Promise<number> {
    const cutoff = new Date(now.getTime() - BLUMON_WEBHOOK_PENDING_TTL_MS)
    const orphanWhere = {
      provider: ProviderType.PAYMENT_PROCESSOR,
      status: EventStatus.PENDING,
      createdAt: { lt: cutoff },
      eventId: { startsWith: 'blumon-tpv-' },
      AND: [
        // Never orphan-alert a reversal: it is money LEAVING, so "charge with no
        // Avoqado payment" would be a false alarm. Same NULL-tolerant exclusion
        // as the pending sweep above.
        { OR: [{ type: null }, { type: { notIn: [...REVERSAL_OPERATION_TYPES] } }] },
        {
          OR: [
            { nextAttemptAt: null },
            // Tarea 6 + F5: nunca antes de su turno (su recuperación por el vínculo todavía va a correr), y sólo si este pase ya le
            // dio su último intento con desenlace.
            { nextAttemptAt: { lte: now }, id: { in: [...intentados] } },
          ],
        },
      ],
    } satisfies Prisma.ProviderEventLogWhereInput

    // Fetch the rows BEFORE flipping them so we can emit a per-event alert with
    // enough detail for manual reconciliation. An ORPHANED event means Blumon
    // confirmed a charge but no Avoqado Payment ever recorded it (e.g. the TPV
    // never synced its offline queue). Ops must reconcile these by hand.
    // BetterStack alerts on the '🚨 [Blumon recon] ORPHANED' message.
    const toOrphan = await prisma.providerEventLog.findMany({
      where: orphanWhere,
      select: { id: true, venueId: true, terminalId: true, payload: true, createdAt: true },
    })

    if (toOrphan.length === 0) return 0

    for (const row of toOrphan) {
      const p = row.payload as unknown as BlumonWebhookPayload
      logger.error('🚨 [Blumon recon] ORPHANED webhook — Blumon charge with NO Avoqado payment', {
        eventLogId: row.id,
        venueId: row.venueId,
        terminalId: row.terminalId,
        amount: p?.amount,
        authorizationCode: p?.authorizationCode, // R6: sin lastFour en el log
        reference: p?.reference,
        operationNumber: p?.operationNumber,
        serialNumber: p?.serialNumber,
        ageHours: Math.round((Date.now() - new Date(row.createdAt).getTime()) / 3_600_000),
      })
    }

    const result = await prisma.providerEventLog.updateMany({
      where: orphanWhere,
      data: {
        status: EventStatus.ERROR,
        errorReason: BLUMON_WEBHOOK_ERROR_REASONS.ORPHANED,
        processedAt: new Date(),
      },
    })

    logger.warn('🚨 [Blumon recon] Marked orphaned events (no Payment match within 24h)', {
      count: result.count,
    })

    return result.count
  }
}

export const blumonWebhookReconciliationJob = new BlumonWebhookReconciliationJob()
