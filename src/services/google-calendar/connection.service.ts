/**
 * Google Calendar connection commit service (Phase 1).
 *
 * `commitConnection` is the single atomic write that finalizes an OAuth
 * exchange:
 *   1. Fetch calendar metadata via `calendarList.get` (also validates the
 *      tokens still work and re-checks accessRole — a defense-in-depth step
 *      because the picker UI's filter could theoretically be bypassed).
 *   2. Subscribe to `events.watch` BEFORE the DB transaction so the channel
 *      data is ready to be inserted atomically. If the watch fails, the
 *      session stays unconsumed and the dashboard can retry.
 *   3. ONE transaction that consumes the session, inserts the connection,
 *      and inserts the channel — all-or-nothing.
 *
 * Post-commit work (Phase A backfill) is intentionally NOT in this service.
 * The pull worker (Subagent 3) picks up connections with `syncToken=null`
 * via its standard "needs full sync" predicate, so a missed enqueue here
 * cannot leave a connection without backfill.
 */
import { google } from 'googleapis'

import logger from '@/config/logger'
import { InternalServerError, ValidationError } from '@/errors/AppError'
import { decryptToken } from '@/services/google-calendar/encryption.service'
import { consumeSession } from '@/services/google-calendar/oauth-session.service'
import { buildOAuthClient } from '@/services/google-calendar/oauth.service'
import { enqueuePullForConnection } from '@/services/google-calendar/pull.service'
import { subscribeToCalendar } from '@/services/google-calendar/watch-channel.service'
import prisma from '@/utils/prismaClient'

export interface CommitConnectionArgs {
  sessionId: string
  selectedCalendarId: string
  createdByStaffId: string
}

export async function commitConnection(args: CommitConnectionArgs) {
  const session = await prisma.googleOAuthSession.findUnique({ where: { id: args.sessionId } })
  if (!session) throw new InternalServerError('oauth_session_not_found_after_authorize')

  // 1. Fetch calendar metadata + re-validate accessRole.
  const auth = buildOAuthClient()
  auth.setCredentials({
    access_token: decryptToken(Buffer.from(session.encryptedAccessToken)),
    refresh_token: decryptToken(Buffer.from(session.encryptedRefreshToken)),
  })
  const calendarApi = google.calendar({ version: 'v3', auth })
  const meta = await calendarApi.calendarList.get({ calendarId: args.selectedCalendarId })

  const accessRole = meta.data.accessRole ?? 'reader'
  if (session.intent === 'staff_personal' && !['owner', 'writer'].includes(accessRole)) {
    throw new ValidationError(
      'El calendario seleccionado no tiene permisos de escritura. Elige otro calendario o ajusta los permisos en Google.',
    )
  }
  if (!meta.data.timeZone) {
    throw new InternalServerError('Google no devolvió la zona horaria del calendario')
  }

  // 2. Subscribe to push BEFORE the transaction so we have channel data atomic-insertable.
  const webhookBase = process.env.GOOGLE_CALENDAR_WEBHOOK_BASE
  if (!webhookBase) {
    throw new InternalServerError('GOOGLE_CALENDAR_WEBHOOK_BASE not set')
  }
  const webhookUrl = `${webhookBase}/api/v1/webhooks/google-calendar`

  const channel = await subscribeToCalendar({
    accessToken: decryptToken(Buffer.from(session.encryptedAccessToken)),
    refreshToken: decryptToken(Buffer.from(session.encryptedRefreshToken)),
    calendarId: args.selectedCalendarId,
    webhookUrl,
  })

  // 3. ONE transaction: consume session + create connection + create channel.
  // `consumeSession` throws ConflictError if 0 rows updated (concurrent commit
  // already won) — the transaction rolls back and the caller sees a 409.
  const connection = await prisma.$transaction(async tx => {
    await consumeSession(tx, session.id)

    const conn = await tx.googleCalendarConnection.create({
      data: {
        scope: session.intent === 'venue_master' ? 'VENUE' : 'STAFF_PERSONAL',
        venueId: session.intent === 'venue_master' ? session.venueId : null,
        staffId: session.intent === 'staff_personal' ? session.staffId : null,
        googleAccountEmail: session.googleAccountEmail,
        googleAccountSub: session.googleAccountSub,
        selectedCalendarId: args.selectedCalendarId,
        selectedCalendarSummary: meta.data.summary ?? args.selectedCalendarId,
        selectedCalendarTimeZone: meta.data.timeZone!,
        refreshTokenCiphertext: session.encryptedRefreshToken,
        accessTokenCiphertext: session.encryptedAccessToken,
        accessTokenExpiresAt: session.accessTokenExpiresAt,
        createdByStaffId: args.createdByStaffId,
      },
    })

    await tx.googleCalendarChannel.create({
      data: {
        connectionId: conn.id,
        channelId: channel.channelId,
        resourceId: channel.resourceId,
        token: channel.token,
        expiresAt: channel.expiresAt,
        status: 'ACTIVE',
      },
    })

    return conn
  })

  logger.info('gcal connection committed', {
    connectionId: connection.id,
    scope: connection.scope,
    venueId: connection.venueId,
    staffId: connection.staffId,
    calendarId: args.selectedCalendarId,
  })

  // Best-effort enqueue of Phase A backfill on the pull queue. If RabbitMQ is
  // down (server.ts:229 boots without it) or the publish fails, the worker's
  // "needs full sync" predicate (syncToken=null) still picks this connection
  // up on the next inbox-sweeper tick. The request path never fails because
  // of an enqueue hiccup.
  void enqueuePullForConnection(connection.id).catch(err => {
    logger.warn('gcal connection commit: failed to enqueue initial pull (sweeper will retry)', {
      err: err?.message,
      connectionId: connection.id,
    })
  })

  return connection
}
