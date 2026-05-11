import { CronJob } from 'cron'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { markNoShow } from '../services/dashboard/reservation.dashboard.service'

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
  private readonly CRON_PATTERN = '*/5 * * * *'

  constructor() {
    this.job = new CronJob(this.CRON_PATTERN, this.run.bind(this), null, false, 'America/Mexico_City')
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
      const candidates = await prisma.reservation.findMany({
        where: {
          status: { in: ['PENDING', 'CONFIRMED'] },
          checkedInAt: null,
          startsAt: { lt: now },
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
      })

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
          await markNoShow(reservation.venueId, reservation.id, 'SYSTEM')

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
            await prisma.reservation.update({
              where: { id: reservation.id },
              data: { noShowFeeAmount: feeAmount },
            })
            logger.warn(
              `[AUTO_NO_SHOW] fee_owed=${feeAmount} reservation=${reservation.id} confirmationCode=${reservation.confirmationCode} — actual capture deferred`,
            )
          }

          marked += 1
        } catch (err) {
          // One bad reservation must not kill the tick.
          logger.error(`❌ [AUTO NO-SHOW] Failed to mark reservation=${reservation.id} (${reservation.confirmationCode})`, err)
        }
      }

      logger.info(`🚫 [AUTO NO-SHOW] tick: marked ${marked} reservations`)
    } catch (error) {
      logger.error('❌ [AUTO NO-SHOW] Job failed', error)
    }
  }
}

export const reservationAutoNoShowJob = new ReservationAutoNoShowJob()
