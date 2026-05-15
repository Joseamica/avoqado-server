/**
 * Google Calendar Connection Health Check (Phase 1)
 *
 * For each CONNECTED connection that hasn't synced in 24h, ping `calendarList.get`
 * to detect silent failure modes:
 *   - 403/404 → access revoked at the calendar level (not OAuth) → status=CALENDAR_LOST
 *   - 401 → token expired, refresh path via handleAuthError
 *   - success → stamp lastSyncedAt so we don't keep pinging
 *
 * This catches the "quiet revocation" case: user revoked Avoqado in Google
 * settings but no calendar event changed for days, so we never noticed.
 *
 * Cron: daily at 05:00 Mexico City.
 */
import { CronJob } from 'cron'
import { google } from 'googleapis'
import logger from '../config/logger'
import prisma from '../utils/prismaClient'
import { buildOAuthClient } from '../services/google-calendar/oauth.service'
import { decryptToken } from '../services/google-calendar/encryption.service'
import { handleAuthError } from '../services/google-calendar/pull.service'

const TIMEZONE = 'America/Mexico_City'
const QUIET_AFTER_MS = 24 * 3600_000

export class GcalHealthCheckJob {
  private job: CronJob | null = null
  private isRunning = false

  constructor() {
    this.job = new CronJob(
      '0 5 * * *',
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
      logger.info('Gcal Health Check Job started — daily at 05:00 Mexico City')
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('Gcal Health Check Job stopped')
    }
  }

  async runNow(): Promise<void> {
    return this.process()
  }

  private async process(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true

    try {
      const cutoff = new Date(Date.now() - QUIET_AFTER_MS)
      const connections = await prisma.googleCalendarConnection.findMany({
        where: {
          status: 'CONNECTED',
          OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: cutoff } }],
        },
      })

      for (const conn of connections) {
        if (!conn.accessTokenCiphertext) continue
        try {
          const auth = buildOAuthClient()
          auth.setCredentials({
            access_token: decryptToken(Buffer.from(conn.accessTokenCiphertext)),
            refresh_token: decryptToken(Buffer.from(conn.refreshTokenCiphertext)),
          })
          const calendar = google.calendar({ version: 'v3', auth })
          await calendar.calendarList.get({ calendarId: conn.selectedCalendarId })

          await prisma.googleCalendarConnection.update({
            where: { id: conn.id },
            data: { lastSyncedAt: new Date() },
          })
        } catch (err) {
          const status =
            (err as { code?: number; response?: { status?: number } }).code ?? (err as { response?: { status?: number } }).response?.status
          if (status === 401) {
            await handleAuthError(conn.id).catch(authErr => {
              logger.warn('gcal health-check handleAuthError failed', { err: authErr, connectionId: conn.id })
            })
          } else if (status === 403 || status === 404) {
            await prisma.googleCalendarConnection.update({
              where: { id: conn.id },
              data: { status: 'CALENDAR_LOST', statusReason: `calendarList_get_${status}` },
            })
            logger.warn('gcal connection marked CALENDAR_LOST', { connectionId: conn.id, status })
          } else {
            logger.warn('gcal health-check unexpected error', { err, connectionId: conn.id })
          }
        }
      }
    } catch (err) {
      logger.error('Gcal Health Check Job failed', { err })
    } finally {
      this.isRunning = false
    }
  }
}

export const gcalHealthCheckJob = new GcalHealthCheckJob()
