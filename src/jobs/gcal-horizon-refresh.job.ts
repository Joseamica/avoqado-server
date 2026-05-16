/**
 * Google Calendar Horizon Refresh (Phase 1)
 *
 * Initial backfill at connect time covers [NOW, NOW + maxAdvanceDays]. As days
 * pass, the booking horizon shifts forward by one day every day. Pure webhook-
 * driven incremental sync does NOT notify on "this previously-existing event
 * just fell inside the booking window" — Google only fires on changes.
 *
 * This job runs daily and serves TWO purposes:
 *
 *   1. **Normal path** — for connections that have completed their initial
 *      backfill (`syncToken` and `lastHorizonEnd` both set), do a bounded
 *      windowed re-sync of [lastHorizonEnd, NOW + maxAdvanceDays] to catch
 *      events newly entering the booking horizon. Does NOT touch `syncToken`.
 *
 *   2. **Rescue path** — for connections where `syncToken IS NULL` OR
 *      `lastHorizonEnd IS NULL`, the initial inline backfill in
 *      `connection.service.ts` failed (e.g., transient Google API error at
 *      connect time, or process crashed mid-sync). Run a full `runBackfill()`
 *      here instead of the windowed re-sync. This is the long-tail safety net
 *      that guarantees every CONNECTED row eventually completes its backfill.
 *
 * Cron: daily at 04:00 Mexico City.
 */
import { CronJob } from 'cron'
import { google, calendar_v3 } from 'googleapis'
import logger from '../config/logger'
import prisma from '../utils/prismaClient'
import { buildOAuthClient } from '../services/google-calendar/oauth.service'
import { decryptToken } from '../services/google-calendar/encryption.service'
import { upsertBlock } from '../services/google-calendar/external-busy-block.service'
import { runBackfill } from '../services/google-calendar/pull.service'

const TIMEZONE = 'America/Mexico_City'
const DEFAULT_MAX_ADVANCE_DAYS = 60
const MAX_RESULTS = 250

export class GcalHorizonRefreshJob {
  private job: CronJob | null = null
  private isRunning = false

  constructor() {
    this.job = new CronJob(
      '0 4 * * *',
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
      logger.info('Gcal Horizon Refresh Job started — daily at 04:00 Mexico City')
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('Gcal Horizon Refresh Job stopped')
    }
  }

  async runNow(): Promise<void> {
    return this.process()
  }

  private async process(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true

    try {
      const connections = await prisma.googleCalendarConnection.findMany({
        where: { status: 'CONNECTED' },
        include: { venue: { include: { reservationSettings: true } } },
      })

      for (const conn of connections) {
        try {
          if (!conn.accessTokenCiphertext) continue

          // RESCUE PATH: initial backfill never completed. Run a full backfill
          // instead of the windowed re-sync — `runBackfill` queries from NOW
          // to NOW+maxAdvanceDays and stamps `syncToken + lastSyncedAt +
          // lastHorizonEnd` in a single transaction.
          if (!conn.syncToken || !conn.lastHorizonEnd) {
            logger.info('gcal horizon refresh: rescuing connection with incomplete backfill', {
              connectionId: conn.id,
              hadSyncToken: !!conn.syncToken,
              hadLastHorizonEnd: !!conn.lastHorizonEnd,
            })
            await runBackfill(conn.id)
            continue
          }

          // NORMAL PATH: windowed re-sync of [lastHorizonEnd, NOW + maxAdvanceDays].
          const maxAdvanceDays = conn.venue?.reservationSettings?.maxAdvanceDays ?? DEFAULT_MAX_ADVANCE_DAYS
          const now = new Date()
          const newHorizonEnd = new Date(now.getTime() + maxAdvanceDays * 86400_000)
          const windowStart = conn.lastHorizonEnd

          // Skip if no new uncovered window
          if (windowStart >= newHorizonEnd) continue

          const auth = buildOAuthClient()
          auth.setCredentials({
            access_token: decryptToken(Buffer.from(conn.accessTokenCiphertext)),
            refresh_token: decryptToken(Buffer.from(conn.refreshTokenCiphertext)),
          })
          const calendar = google.calendar({ version: 'v3', auth })

          const collected: calendar_v3.Schema$Event[] = []
          let pageToken: string | undefined
          do {
            const page = await calendar.events.list({
              calendarId: conn.selectedCalendarId,
              timeMin: windowStart.toISOString(),
              timeMax: newHorizonEnd.toISOString(),
              singleEvents: true,
              showDeleted: false,
              maxResults: MAX_RESULTS,
              pageToken,
            })
            for (const ev of page.data.items ?? []) collected.push(ev)
            pageToken = page.data.nextPageToken ?? undefined
          } while (pageToken)

          await prisma.$transaction(async tx => {
            for (const ev of collected) {
              if (!ev.id) continue
              if (ev.extendedProperties?.private?.avoqadoOrigin === 'avoqado') continue
              if (ev.transparency === 'transparent') continue
              const selfDeclined = (ev.attendees ?? []).some(a => a.self && a.responseStatus === 'declined')
              if (selfDeclined) continue
              await upsertBlock(tx, {
                connectionId: conn.id,
                venueId: conn.venueId,
                staffId: conn.staffId,
                externalCalendarId: conn.selectedCalendarId,
                event: ev,
                calendarTimeZone: conn.selectedCalendarTimeZone,
              })
            }
            await tx.googleCalendarConnection.update({
              where: { id: conn.id },
              data: { lastHorizonEnd: newHorizonEnd },
            })
          })
        } catch (err) {
          logger.warn('gcal horizon refresh failed for connection', { err, connectionId: conn.id })
        }
      }
    } catch (err) {
      logger.error('Gcal Horizon Refresh Job failed', { err })
    } finally {
      this.isRunning = false
    }
  }
}

export const gcalHorizonRefreshJob = new GcalHorizonRefreshJob()
