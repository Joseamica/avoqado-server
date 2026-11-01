import { CronJob } from 'cron'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { markNoShow, PASS_ARRIVAL_PENDING } from '../services/dashboard/reservation.dashboard.service'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { scheduleJob } from '../observability/jobContext'
import { conNegocio } from '../services/demo/candadoDemo'
import { flushPendingCorrectionNotices, sendClassNoShowSummaries } from '../services/reservation/noShowNotices.service'

/**
 * Los avisos del tick anterior siguen saliendo (`cron` no espera a que un tick termine, y los correos van con pausa).
 * Sólo cubre los avisos: el marcado de «No asistió» corre en cada tick pase lo que pase.
 */
let avisosEnCurso = false

/**
 * Auto no-show worker.
 *
 * When a reservation passes its `startsAt + noShowGraceMin` deadline without a
 * check-in, mark it `NO_SHOW`. If the venue has `noShowFeePercent` configured
 * and the reservation has a paid deposit, the worker also records the fee
 * intent (`noShowFeeAmount` + future `noShowFeeCapturedAt`). Actual fund
 * capture is deferred to the Stripe webhook path — this worker just decides
 * "yes, this customer no-showed" and writes the intent.
 *
 * Credit-pack refunds (when `creditNoShowRefund` is true) are inherited for
 * free because we delegate the status transition to the existing manual
 * `markNoShow()` service — it already handles refunds and activity log entries.
 */
export class ReservationAutoNoShowJob {
  private job: CronJob | null = null
  // Offset 35s off the minute mark — several other */5 jobs (marketing, reservation
  // reminders, POS monitor, stale-pending alert) share this cadence; firing on the
  // exact same tick can exhaust the connection pool (P2024 incident 2026-07-03).
  // See .claude/rules/cron-jobs.md checklist item 4.
  private readonly CRON_PATTERN = '35 */5 * * * *'

  constructor() {
    this.job = scheduleJob('reservation-auto-no-show', this.CRON_PATTERN, this.run.bind(this), null, false, 'America/Mexico_City')
  }

  start(): void {
    this.job?.start()
    logger.info('🚫 Reservation Auto No-Show Job started - running every 5 minutes')
  }

  stop(): void {
    this.job?.stop()
    logger.info('🚫 Reservation Auto No-Show Job stopped')
  }

  async runNow(): Promise<void> {
    await this.run()
  }

  private async run(): Promise<void> {
    try {
      const now = new Date()

      // Pull candidates first, then per-row check the grace deadline. We can't
      // express `startsAt + noShowGraceMin < now` directly in Prisma's predicate
      // language without raw SQL — but the candidate set is bounded (past start,
      // not checked-in, not terminal) so this is cheap.
      // Entry read only. Retry on transient DB connection blips (P1001 during the cron
      // stampede); the markNoShow/fee writes below are NOT retried. See .claude/rules/cron-jobs.md
      const candidates = await retry(
        () =>
          prisma.reservation.findMany({
            where: {
              status: { in: ['PENDING', 'CONFIRMED'] },
              checkedInAt: null,
              startsAt: { lt: now },
              // Conector de pases: el socio ya marcó su llegada en el agregador y el estudio todavía puede confirmarla
              // (o vence sola). La transición lo vuelve a comprobar bajo candado (carrera con la ingesta).
              aggregatorVisits: { none: { status: 'PENDING', deadlineAt: { gt: now } } },
              venue: {
                reservationSettings: {
                  noShowGraceMin: { gt: 0 },
                },
              },
            },
            include: {
              venue: {
                select: {
                  id: true,
                  reservationSettings: {
                    select: { noShowGraceMin: true, noShowFeePercent: true },
                  },
                },
              },
            },
            take: 500,
          }),
        { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'reservation-auto-no-show.findCandidates' },
      )

      let marked = 0

      for (const reservation of candidates) {
        const settings = reservation.venue.reservationSettings
        if (!settings) continue
        const graceMin = settings.noShowGraceMin ?? 0
        if (graceMin <= 0) continue

        const graceDeadline = new Date(reservation.startsAt.getTime() + graceMin * 60_000)
        if (graceDeadline > now) continue // still inside the grace window

        try {
          // Delegate to the existing service so we inherit:
          //   - state-machine validation + race guard (`transitionReservation`)
          //   - statusLog audit entry
          //   - activity log (`RESERVATION_NO_SHOW`)
          //   - credit pack refund when `creditNoShowRefund` is true
          // Con el negocio de la reserva en el contexto (candado demo, capa 3): el aviso de no-show de un demo no sale.
          await conNegocio(reservation.venueId, () => markNoShow(reservation.venueId, reservation.id, 'SYSTEM'))

          // Record the fee intent if the venue charges a no-show fee AND a deposit
          // was actually paid. Capture is deferred — Stripe webhook owns funds.
          const feePercent = settings.noShowFeePercent
          if (
            feePercent != null &&
            feePercent > 0 &&
            reservation.depositStatus === 'PAID' &&
            reservation.depositAmount &&
            reservation.depositAmount.toNumber() > 0
          ) {
            const feeAmount = Number(((reservation.depositAmount.toNumber() * feePercent) / 100).toFixed(2))
            // Conditional: a correction («sí llegó») may have landed after markNoShow committed.
            const { count } = await prisma.reservation.updateMany({
              where: { id: reservation.id, venueId: reservation.venueId, status: 'NO_SHOW' },
              data: { noShowFeeAmount: feeAmount },
            })
            if (count === 0) {
              logger.info(`🚫 [AUTO NO-SHOW] ${reservation.confirmationCode} is no longer NO_SHOW — fee not recorded`)
            } else {
              logger.warn(
                `[AUTO_NO_SHOW] fee_owed=${feeAmount} reservation=${reservation.id} confirmationCode=${reservation.confirmationCode} — actual capture deferred`,
              )
            }
          }

          marked += 1
        } catch (err) {
          if ((err as { code?: string })?.code === PASS_ARRIVAL_PENDING) {
            logger.info(`🚫 [AUTO NO-SHOW] ${reservation.confirmationCode}: llegada de pase por confirmar, se revisa en el siguiente tick`)
            continue
          }
          // One bad reservation must not kill the tick.
          logger.error(`❌ [AUTO NO-SHOW] Failed to mark reservation=${reservation.id} (${reservation.confirmationCode})`, err)
        }
      }

      logger.info(`🚫 [AUTO NO-SHOW] tick: marked ${marked} reservations`)
    } catch (error) {
      logger.error('❌ [AUTO NO-SHOW] Job failed', error)
    }

    // D4: avisos durables de «No asistió», DESPUÉS de marcar (el resumen espera a que la clase no tenga PENDING/CONFIRMED).
    // Cada uno en su try: uno que truena no tumba al otro ni al marcado. Si el tick anterior sigue mandando, se saltan.
    if (avisosEnCurso) {
      logger.info('🚫 [AUTO NO-SHOW] los avisos del tick anterior siguen saliendo; éste no los repite')
      return
    }
    avisosEnCurso = true
    try {
      try {
        await flushPendingCorrectionNotices(new Date())
      } catch (error) {
        logger.error('❌ [AUTO NO-SHOW] avisos de correcciones pendientes', error)
      }
      try {
        await sendClassNoShowSummaries(new Date())
      } catch (error) {
        logger.error('❌ [AUTO NO-SHOW] resumen de «No asistió» por clase', error)
      }
    } finally {
      avisosEnCurso = false
    }
  }
}

export const reservationAutoNoShowJob = new ReservationAutoNoShowJob()
