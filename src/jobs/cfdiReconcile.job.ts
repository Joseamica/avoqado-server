/**
 * Cada cinco minutos: concilia intentos inciertos y repara archivos de timbres confirmados.
 * Consultas de entrada con retry de conexión, páginas acotadas y fallos aislados por CFDI.
 * RESET conserva versión/sellos; nunca autoriza un nuevo envío por el mero paso del tiempo.
 */

import { conLimiteDeTiempo, dondeFaltanArchivos, repararArchivosCompartido } from '../services/fiscal/finalizadorCfdi'
import { CronJob } from 'cron'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { reconcileStuckCfdi, StuckCfdi } from '../services/fiscal/cfdiReconcile.service'
import {
  CANCEL_SYNC_MAX_PER_TICK,
  dondeBuscarCancelacionesPendientes,
  dondeBuscarCierresRecientes,
  refreshPendingCancellation,
  sincronizarCancelacionExterna,
  syncPendingCancellations,
  type CursorDeCancelaciones,
  type CursorDeCierres,
  tocaRevisarCancelaciones,
} from '../services/fiscal/cfdi.service'
import { NODE_ENV } from '../config/env'
import { asegurarWebhooksFaltantes, defaultAsegurarFaltantesDeps } from '../services/fiscal/facturapiWebhook.service'
import { scheduleJob } from '../observability/jobContext'
import { PREFIJO_EXTRACCION } from '../services/fiscal/exclusionGlobal'
import { registrarExtraccionEmitida } from '../services/fiscal/cfdiExtraccion.service'
import { utcTs } from '../utils/sqlDates'

// Antigüedad mínima; el CAS igualmente protege las respuestas concurrentes.
const STUCK_THRESHOLD_MS = 10 * 60_000

// Bound how many stuck rows a single tick processes (defensive — there should rarely be any).
const MAX_PER_TICK = 200

/**
 * C2 · ronda 1 (I1): lo más que dura la reparación de archivos en una pasada; después no toma más filas (el cursor sigue donde iba). C2 · OF-2
 * (T5 N4): es un presupuesto de la pasada, no un tiempo del PAC: alcanza para ~2.7 reparaciones en el peor caso (`LIMITE_REPARACION_MS`,
 * 45 s cada una) y, sumado a los de cancelaciones (60 s), webhooks (30 s) y atorados (60 s), cabe en los 5 min entre ticks.
 */
export const PRESUPUESTO_REPARACION_MS = 120_000
/** OF-1 (T5 N6): lo más que dura la conciliación de timbres atorados en una pasada (cada fila consulta al PAC sin tiempo límite propio). */
export const PRESUPUESTO_TIMBRES_ATORADOS_MS = 60_000
/** OF-1: lo más que se espera el alta de webhooks faltantes en una pasada (el SDK de Facturapi no tiene tiempo límite). */
export const PRESUPUESTO_WEBHOOKS_MS = 30_000
/** C3 (Codex C3-23): cuántas extracciones sin su evento repara una pasada (con cursor por id). */
export const EVENTOS_DE_EXTRACCION_POR_PASADA = 50

export class CfdiReconcileJob {
  private job: CronJob | null = null
  private isRunning = false
  // ponytail: cursores de una instancia, reinician con el proceso; persistir si reinicios/múltiples workers frenan el avance.
  private reconcileCursor: { updatedAt: Date; id: string } | null = null
  private artifactCursor: { stampedAt: Date; id: string } | null = null
  /** Última pasada del barrido de cancelaciones (en memoria: el server corre UNA instancia). */
  private ultimaRevisionDeCancelaciones: number | null = null
  /** C2-7: dónde se quedó el barrido de cancelaciones (como `artifactCursor`): con más de 50 en trámite, ninguna se salta. */
  private cancelCursor: CursorDeCancelaciones | null = null
  /** C2 ronda 2 (N1): dónde se quedó la fase de cierres recientes del barrido. */
  private cierresCursor: CursorDeCierres | null = null
  /** C3 (C3-23): dónde se quedó la pasada de eventos de extracción (por id). */
  private extraccionCursor: string | null = null

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
        // OF-1: el alta va por el SDK de Facturapi (sin tiempo límite); una colgada no detiene la pasada (nunca lanza: tiene su catch).
        await conLimiteDeTiempo(this.webhooksFaltantes(), PRESUPUESTO_WEBHOOKS_MS, () =>
          logger.warn('[cfdiReconcile] el alta de webhooks faltantes no terminó en su presupuesto; queda para la siguiente revisión'),
        )
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

      const sandbox = NODE_ENV !== 'production'
      const now = new Date()
      const tally: Record<string, number> = { COMPLETED: 0, RESET: 0, INCONCLUSIVE: 0, SKIPPED: 0, ERROR: 0 }

      // ── Per-row processing — isolated try/catch ───────────────────────────
      // OF-1 (T5 N6): `reconcileStuckCfdi` consulta al PAC con el SDK (sin tiempo límite) y baja archivos. Con presupuesto por pasada, como
      // la reparación de archivos: cada fila espera a lo más lo que quede (la que pierde sigue sola y escribe con su CAS), y al agotarse no
      // se toman más; el cursor queda en la última INTENTADA (con la página entera es la última de la página, como antes).
      const inicioAtorados = Date.now()
      let intentada: StuckCfdi | undefined
      for (const cfdi of stuck) {
        const restante = PRESUPUESTO_TIMBRES_ATORADOS_MS - (Date.now() - inicioAtorados)
        if (restante <= 0) break
        intentada = cfdi
        try {
          const result = await conLimiteDeTiempo(reconcileStuckCfdi({ cfdi, now, sandbox }), restante, () => ({
            outcome: 'INCONCLUSIVE' as const,
            cfdiId: cfdi.id,
            detail: 'el PAC no contestó dentro del presupuesto de la pasada',
          }))
          tally[result.outcome] = (tally[result.outcome] ?? 0) + 1
          logger.info(`[cfdiReconcile] cfdi=${cfdi.id} outcome=${result.outcome}${result.detail ? ` (${result.detail})` : ''}`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.error(`[cfdiReconcile] unhandled error for cfdi=${cfdi.id}: ${message}`)
          tally.ERROR += 1
        }
      }
      if (intentada && intentada !== stuck.at(-1))
        logger.warn('[cfdiReconcile] conciliación de timbres atorados cortada por presupuesto', {
          intentadas: stuck.indexOf(intentada) + 1,
          enLaPagina: stuck.length,
        })
      this.reconcileCursor = intentada ? { updatedAt: intentada.updatedAt, id: intentada.id } : null

      await this.repairArtifacts(cutoff)
      await this.repararEventosDeExtraccion(cutoff)

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
          where: dondeFaltanArchivos(cutoff, this.artifactCursor),
          orderBy: [{ stampedAt: 'asc' }, { id: 'asc' }],
          take: 20,
          // Sólo lo del cursor: la reparación relee cada fila (fresca) con su select y arma los parámetros (C2 · T5).
          select: { id: true, stampedAt: true },
        }),
      { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'cfdiReconcile.findMissingArtifacts' },
    )
    // C2 · T5 ronda 1 (I1): la reparación tiene presupuesto por pasada, y cada fila espera a lo más lo que quede de él (además del límite
    // propio de la reparación). Así un PAC o un almacenamiento lento nunca deja `isRunning` en `true`: la pasada siguiente corre
    // completa (cancelaciones, STAMPING atorados, webhooks y archivos).
    const sandbox = NODE_ENV !== 'production'
    const inicio = Date.now()
    let intentada: (typeof rows)[number] | undefined
    for (const row of rows) {
      const restante = PRESUPUESTO_REPARACION_MS - (Date.now() - inicio)
      if (restante <= 0) break
      intentada = row
      try {
        // C2 · T5: la MISMA reparación que pide una nota que espera el XML de su original. C2 · OF-2 (T7 N4): la COMPARTIDA (una en vuelo
        // por factura con las vistas; lo permanente —p. ej. `XML_NO_DISPONIBLE`, que no se persiste— se recuerda una hora en vez de volver
        // a bajarse en cada vuelta del cursor). El límite de aquí se queda como defensa.
        await conLimiteDeTiempo(repararArchivosCompartido(row.id, { sandbox, esperaMs: restante }), restante, () => 'FALLO' as const)
      } catch (err) {
        logger.error(`[cfdiReconcile] reparación de archivos falló cfdi=${row.id}`, err)
      }
    }
    // El cursor queda en la última fila INTENTADA: si la pasada se cortó, la siguiente sigue con la primera que no alcanzó (la que se colgó
    // no se reintenta hasta la vuelta). Con la página entera es la última de la página, como antes; con la página vacía, vuelve al principio.
    if (intentada && intentada !== rows.at(-1))
      logger.warn('[cfdiReconcile] reparación de archivos cortada por presupuesto', {
        intentadas: rows.indexOf(intentada) + 1,
        enLaPagina: rows.length,
      })
    this.artifactCursor = intentada?.stampedAt ? { stampedAt: intentada.stampedAt, id: intentada.id } : null
  }

  /**
   * C3 (Codex C3-23, v7/v8): extracciones timbradas SIN su `CFDI_EXTRACCION_EMITIDA` —el proceso cayó entre finalizar y registrar y nadie
   * volvió a llamar—, también las que se CANCELARON antes de esta pasada (la cancelación no borra que se emitió: `uuid` y `stampedAt` son la
   * evidencia del timbre). Sólo las timbradas hace más de `STUCK_THRESHOLD_MS` (antes, el camino del usuario puede estar registrándola con
   * su actor). El `NOT EXISTS` usa el índice único parcial `ActivityLog_extraccion_emitida_key`; `registrarExtraccionEmitida` es idempotente
   * por él, así que una carrera con el usuario no duplica. El actor se perdió con el proceso: `staffId: null`, como los demás eventos del job.
   * Una fila que falla no detiene a las demás. El corte mira también `updatedAt` (C3 · T4): una extracción que el usuario acaba de recuperar
   * o finalizar trae el `stampedAt` del PAC (viejo), y el job no debe ganarle el registro dejándolo sin actor. El corte va con `utcTs` (`stampedAt` es UTC sin zona; un `Date` suelto se compara en la zona
   * de la SESIÓN: la base local está en America/Mexico_City y lo corría 6 h — lo encontró la integración). ponytail: recorre `Cfdi` sin índice propio (filtra por llave y estado); un índice parcial por
   * llave si la tabla crece tanto que la pasada pese.
   */
  private async repararEventosDeExtraccion(cutoff: Date): Promise<void> {
    const filas = await retry(
      () => prisma.$queryRaw<Array<{ id: string }>>`
        SELECT c.id FROM "Cfdi" c
        WHERE c.status IN ('STAMPED', 'CANCELLED') AND c.type = 'EGRESO' AND c.uuid IS NOT NULL
          AND c."stampedAt" IS NOT NULL AND GREATEST(c."stampedAt", c."updatedAt") < ${utcTs(cutoff)}
          AND starts_with(c."idempotencyKey", ${PREFIJO_EXTRACCION})
          AND NOT EXISTS (SELECT 1 FROM "ActivityLog" a WHERE a.action = 'CFDI_EXTRACCION_EMITIDA' AND a."entityId" = c.id)
          AND c.id > ${this.extraccionCursor ?? ''}
        ORDER BY c.id
        LIMIT ${EVENTOS_DE_EXTRACCION_POR_PASADA}`,
      { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'cfdiReconcile.findExtraccionesSinEvento' },
    )
    this.extraccionCursor = filas.length === EVENTOS_DE_EXTRACCION_POR_PASADA ? filas[filas.length - 1].id : null
    for (const { id } of filas) {
      try {
        await registrarExtraccionEmitida(await prisma.cfdi.findUniqueOrThrow({ where: { id } }), null)
      } catch (err) {
        logger.error(`[cfdiReconcile] no se pudo registrar la extracción cfdi=${id}`, err)
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
        { sandbox, now: new Date(startTime), cursor: this.cancelCursor, cursorCerradas: this.cierresCursor },
        {
          findPending: (cutoff, cursor) =>
            retry(
              () =>
                prisma.cfdi.findMany({
                  where: dondeBuscarCancelacionesPendientes(cutoff, cursor),
                  orderBy: [{ cancelRequestedAt: 'asc' }, { id: 'asc' }],
                  take: CANCEL_SYNC_MAX_PER_TICK,
                  include: { fiscalEmisor: true },
                  omit: { xmlConceptos: true }, // C2 · T5 ronda 1 (M1): ~1 MiB en una global; el barrido no lo usa
                }),
              { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'cfdiReconcile.findPendingCancels' },
            ),
          refresh: cfdi => refreshPendingCancellation(cfdi, { sandbox }),
          // C2 ronda 2 (N1): los cierres recientes de intentos enviados, otra vez al PAC (sólo GET; la vía externa los reabre si hace falta).
          findRecentlyClosed: (desde, cursor) =>
            retry(
              () =>
                prisma.cfdi.findMany({
                  where: dondeBuscarCierresRecientes(desde, cursor),
                  orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
                  take: CANCEL_SYNC_MAX_PER_TICK,
                  include: { fiscalEmisor: true },
                  omit: { xmlConceptos: true }, // C2 · T5 ronda 1 (M1)
                }),
              { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'cfdiReconcile.findRecentlyClosed' },
            ),
          recheckClosed: cfdi => sincronizarCancelacionExterna(cfdi, { sandbox }),
        },
      )
      this.cancelCursor = tally.cursor
      this.cierresCursor = tally.cursorCerradas ?? null
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
