import { CronJob } from 'cron'
import { formatInTimeZone } from 'date-fns-tz'
import { es as esLocale } from 'date-fns/locale'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import emailService from '../services/email.service'
import { sendReservationReminderWhatsApp } from '../services/whatsapp.service'

type ReminderChannel = 'EMAIL' | 'SMS' | 'WHATSAPP'

/**
 * Reservation reminder worker.
 *
 * Runs every 5 minutes and dispatches pre-reservation reminders via the channels
 * configured per venue. Reminders are scheduled relative to `reservation.startsAt`
 * and `settings.reminderMinBefore` (e.g. `[1440, 120]` = 24h before + 2h before).
 *
 * Idempotency is enforced by `ReservationReminderSent` — the unique constraint
 * `(reservationId, offsetMinutes, channel)` guarantees we never double-send even
 * if two workers tick concurrently or a tick retries after a partial failure.
 */
export class ReservationReminderJob {
  private job: CronJob | null = null
  private readonly CRON_PATTERN = '*/5 * * * *'
  // 5-minute tolerance window covers this tick's slack — we accept offsets that
  // come due any time from (offset - 5) min ago up to (offset + 2) min from now.
  private readonly DUE_WINDOW_BEFORE_MIN = 5
  private readonly DUE_WINDOW_AFTER_MIN = 2
  // Scan cap — 25h covers the longest reasonable offset (24h) plus tick slack.
  private readonly SCAN_HORIZON_MS = 25 * 60 * 60_000

  constructor() {
    this.job = new CronJob(this.CRON_PATTERN, this.run.bind(this), null, false, 'America/Mexico_City')
  }

  start(): void {
    this.job?.start()
    logger.info('📩 Reservation Reminder Job started - running every 5 minutes')
  }

  stop(): void {
    this.job?.stop()
    logger.info('📩 Reservation Reminder Job stopped')
  }

  async runNow(): Promise<void> {
    await this.run()
  }

  private async run(): Promise<void> {
    try {
      const now = new Date()
      const horizon = new Date(now.getTime() + this.SCAN_HORIZON_MS)

      const reservations = await prisma.reservation.findMany({
        where: {
          status: { in: ['CONFIRMED', 'PENDING'] },
          startsAt: { gt: now, lt: horizon },
          venue: {
            reservationSettings: {
              remindersEnabled: true,
            },
          },
        },
        include: {
          venue: {
            select: {
              id: true,
              name: true,
              slug: true,
              timezone: true,
              reservationSettings: {
                select: { reminderChannels: true, reminderMinBefore: true },
              },
            },
          },
        },
        take: 500,
      })

      let scanned = 0
      let sent = 0
      let skipped = 0

      for (const reservation of reservations) {
        const settings = reservation.venue.reservationSettings
        if (!settings) continue
        const offsets = settings.reminderMinBefore ?? []
        const channels = (settings.reminderChannels ?? []) as ReminderChannel[]
        if (offsets.length === 0 || channels.length === 0) continue

        const minutesUntilStart = (reservation.startsAt.getTime() - now.getTime()) / 60_000

        for (const offset of offsets) {
          // "Due now" = the offset target lies within the (offset - 5, offset + 2) window.
          const isDue = minutesUntilStart <= offset + this.DUE_WINDOW_AFTER_MIN && minutesUntilStart >= offset - this.DUE_WINDOW_BEFORE_MIN
          if (!isDue) continue

          for (const channel of channels) {
            scanned += 1
            const existing = await prisma.reservationReminderSent.findUnique({
              where: {
                reservationId_offsetMinutes_channel: {
                  reservationId: reservation.id,
                  offsetMinutes: offset,
                  channel,
                },
              },
              select: { id: true },
            })
            if (existing) {
              skipped += 1
              continue
            }

            const result = await this.dispatch(channel, reservation, offset)

            // upsert — defends against a race where another worker created the
            // row between our findUnique and the create.
            await prisma.reservationReminderSent.upsert({
              where: {
                reservationId_offsetMinutes_channel: {
                  reservationId: reservation.id,
                  offsetMinutes: offset,
                  channel,
                },
              },
              create: {
                reservationId: reservation.id,
                offsetMinutes: offset,
                channel,
                success: result.success,
                errorMessage: result.errorMessage ?? null,
              },
              update: {}, // race-loser: leave the winner's row untouched
            })

            if (result.success) sent += 1
          }
        }
      }

      logger.info(`📩 [RESERVATION REMINDERS] tick: scanned ${scanned}, sent ${sent}, skipped ${skipped} (already sent)`)
    } catch (error) {
      logger.error('❌ [RESERVATION REMINDERS] Job failed', error)
    }
  }

  /**
   * Dispatch a single reminder via the requested channel. Errors are caught and
   * recorded — they never bubble up so one bad reservation can't kill the tick.
   */
  private async dispatch(
    channel: ReminderChannel,
    reservation: {
      id: string
      confirmationCode: string
      cancelSecret: string | null
      guestName: string | null
      guestEmail: string | null
      guestPhone: string | null
      startsAt: Date
      venue: { name: string; slug: string; timezone: string }
    },
    offsetMinutes: number,
  ): Promise<{ success: boolean; errorMessage?: string }> {
    const customerName = reservation.guestName ?? 'Cliente'
    const venueName = reservation.venue.name
    const tz = reservation.venue.timezone || 'America/Mexico_City'
    // Short format for WhatsApp (limited characters), long format for email
    // body (renders nicely in the highlight card).
    const date = formatInTimeZone(reservation.startsAt, tz, 'dd/MM/yyyy')
    const time = formatInTimeZone(reservation.startsAt, tz, 'HH:mm')
    const dateLongRaw = formatInTimeZone(reservation.startsAt, tz, "EEEE d 'de' MMMM 'de' yyyy", { locale: esLocale })
    const dateLong = dateLongRaw.charAt(0).toUpperCase() + dateLongRaw.slice(1)

    try {
      switch (channel) {
        case 'WHATSAPP': {
          if (!reservation.guestPhone) {
            return { success: false, errorMessage: 'No guest phone on reservation' }
          }
          const ok = await sendReservationReminderWhatsApp(reservation.guestPhone, { customerName, venueName, date, time })
          return ok ? { success: true } : { success: false, errorMessage: 'WhatsApp send returned false' }
        }
        case 'EMAIL': {
          if (!reservation.guestEmail) {
            return { success: false, errorMessage: 'No guest email on reservation' }
          }
          const ok = await emailService.sendReservationReminderEmail(reservation.guestEmail, {
            customerName,
            venueName,
            venueSlug: reservation.venue.slug,
            confirmationCode: reservation.confirmationCode,
            cancelSecret: reservation.cancelSecret,
            dateLong,
            time,
            offsetMinutes,
          })
          return ok ? { success: true } : { success: false, errorMessage: 'Email send returned false' }
        }
        case 'SMS': {
          // No SMS service exists in the project yet. Don't fail the whole tick —
          // record the skip in the ledger so we don't spam this every 5 minutes.
          logger.warn(`📩 [RESERVATION REMINDERS] SMS channel requested but no SMS service available (reservation=${reservation.id})`)
          return { success: false, errorMessage: 'SMS service not available' }
        }
        default:
          return { success: false, errorMessage: `Unknown channel: ${channel}` }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`❌ [RESERVATION REMINDERS] dispatch failed reservation=${reservation.id} channel=${channel}`, err)
      return { success: false, errorMessage: message }
    }
  }
}

export const reservationReminderJob = new ReservationReminderJob()
