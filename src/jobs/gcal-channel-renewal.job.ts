/**
 * Google Calendar Watch Channel Renewal (Phase 1)
 *
 * Renews `events.watch` channels before they expire (Google's max ≈ 7 days).
 * For each ACTIVE channel with `expiresAt < NOW + 48h`:
 *   1. Call `subscribeToCalendar` to create a NEW channel (Google returns fresh expiration).
 *   2. Insert the new channel row as ACTIVE in the same transaction that marks the old RENEWING.
 *   3. Best-effort `stopChannel` on the old one at Google.
 *   4. Mark the old channel STOPPED.
 *
 * Failure handling: 3 consecutive renewal failures on the SAME connection → connection.status = WATCH_FAILED.
 *
 * Cron: every 12 hours.
 */
import { CronJob } from 'cron'
import logger from '../config/logger'
import prisma from '../utils/prismaClient'
import { subscribeToCalendar, stopChannel } from '../services/google-calendar/watch-channel.service'
import { decryptToken } from '../services/google-calendar/encryption.service'

const TIMEZONE = 'America/Mexico_City'
const RENEWAL_WINDOW_MS = 48 * 3600_000
const BATCH_SIZE = 200
const MAX_CONSECUTIVE_FAILURES = 3

const renewalFailures = new Map<string, number>()

export class GcalChannelRenewalJob {
  private job: CronJob | null = null
  private isRunning = false

  constructor() {
    this.job = new CronJob(
      '0 */12 * * *',
      async () => {
        await this.process()
      },
      null,
      false,
      TIMEZONE,
    )
  }

  start(): void {
    if (this.job) {
      this.job.start()
      logger.info('Gcal Channel Renewal Job started — every 12 hours')
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('Gcal Channel Renewal Job stopped')
    }
  }

  async runNow(): Promise<void> {
    return this.process()
  }

  private async process(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true

    try {
      const expiringChannels = await prisma.googleCalendarChannel.findMany({
        where: {
          status: 'ACTIVE',
          expiresAt: { lt: new Date(Date.now() + RENEWAL_WINDOW_MS) },
        },
        include: { connection: true },
        take: BATCH_SIZE,
      })

      for (const ch of expiringChannels) {
        if (ch.connection.status !== 'CONNECTED') continue
        if (!ch.connection.accessTokenCiphertext) continue

        try {
          const newCh = await subscribeToCalendar({
            accessToken: decryptToken(Buffer.from(ch.connection.accessTokenCiphertext)),
            refreshToken: decryptToken(Buffer.from(ch.connection.refreshTokenCiphertext)),
            calendarId: ch.connection.selectedCalendarId,
            webhookUrl: `${process.env.GOOGLE_CALENDAR_WEBHOOK_BASE}/api/v1/webhooks/google-calendar`,
          })

          await prisma.$transaction([
            prisma.googleCalendarChannel.update({
              where: { id: ch.id },
              data: { status: 'RENEWING' },
            }),
            prisma.googleCalendarChannel.create({
              data: {
                connectionId: ch.connectionId,
                channelId: newCh.channelId,
                resourceId: newCh.resourceId,
                token: newCh.token,
                expiresAt: newCh.expiresAt,
                status: 'ACTIVE',
              },
            }),
          ])

          // Stop old channel at Google (best-effort)
          await stopChannel({
            accessToken: decryptToken(Buffer.from(ch.connection.accessTokenCiphertext)),
            refreshToken: decryptToken(Buffer.from(ch.connection.refreshTokenCiphertext)),
            channelId: ch.channelId,
            resourceId: ch.resourceId,
          }).catch(err => {
            logger.warn('gcal stopChannel best-effort failed', { err, channelId: ch.channelId })
          })

          await prisma.googleCalendarChannel.update({
            where: { id: ch.id },
            data: { status: 'STOPPED', stoppedAt: new Date() },
          })

          renewalFailures.delete(ch.connectionId)
        } catch (err) {
          const fails = (renewalFailures.get(ch.connectionId) ?? 0) + 1
          renewalFailures.set(ch.connectionId, fails)
          logger.warn('gcal channel renewal failed', { err, connectionId: ch.connectionId, fails })

          if (fails >= MAX_CONSECUTIVE_FAILURES) {
            await prisma.googleCalendarConnection
              .update({
                where: { id: ch.connectionId },
                data: { status: 'WATCH_FAILED', statusReason: `renewal_failed_${fails}_consecutive` },
              })
              .catch(() => {})
            renewalFailures.delete(ch.connectionId)
            logger.error('gcal connection marked WATCH_FAILED after 3 failed renewals', { connectionId: ch.connectionId })
          }
        }
      }
    } catch (err) {
      logger.error('Gcal Channel Renewal Job failed', { err })
    } finally {
      this.isRunning = false
    }
  }
}

export const gcalChannelRenewalJob = new GcalChannelRenewalJob()
