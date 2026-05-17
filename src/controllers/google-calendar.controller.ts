/**
 * Google Calendar Sync — OAuth + Connection HTTP controllers (Phase 1).
 *
 * Five endpoints:
 *   - GET  /oauth/init       — authenticated. Returns the Google authorization URL.
 *   - GET  /oauth/callback   — UNAUTHENTICATED. Google's redirect target.
 *   - GET  /oauth/calendars  — authenticated. Returns the calendar picker list.
 *   - POST /connections      — authenticated. Atomically commits the connection.
 *   - GET  /connections      — authenticated. Lists the caller's connections.
 *   - DELETE /connections/:id — authenticated. Disconnects (revokes channel, drops blocks).
 *
 * Design notes:
 *   - The callback is intentionally cookie-less: Google performs a top-level
 *     redirect, and the dashboard's auth cookie may not be present. We validate
 *     the signed state JWT instead, then bridge the dashboard back in via a
 *     short-lived `GoogleOAuthSession` (see oauth-session.service.ts).
 *   - The picker filters by `accessRole` per-intent: `staff_personal` requires
 *     owner|writer (we have to insert events there); `venue_master` accepts
 *     reader too (read-only block calendar is a valid use case).
 *   - POST /connections re-validates accessRole at commit time and creates the
 *     connection + watch channel + session-consume in a single Prisma
 *     transaction, with the events.watch subscription performed BEFORE the
 *     transaction so a failure rolls everything back cleanly.
 */
import crypto from 'crypto'
import { NextFunction, Request, Response } from 'express'
import { google } from 'googleapis'

import logger from '@/config/logger'
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from '@/errors/AppError'
import { AuthContext } from '@/security'
import { getUserAccess, hasPermission } from '@/services/access/access.service'
import { commitConnection } from '@/services/google-calendar/connection.service'
import { decryptToken } from '@/services/google-calendar/encryption.service'
import { createOAuthSession, loadAndAuthorizeSession } from '@/services/google-calendar/oauth-session.service'
import {
  buildAuthUrl,
  buildOAuthClient,
  exchangeCodeForTokens,
  signState,
  verifyGoogleIdToken,
  verifyState,
} from '@/services/google-calendar/oauth.service'
import { encryptToken } from '@/services/google-calendar/encryption.service'
import { stopChannel } from '@/services/google-calendar/watch-channel.service'
import prisma from '@/utils/prismaClient'

const DASHBOARD_BASE = process.env.DASHBOARD_URL ?? 'https://dashboard.avoqado.io'

type Intent = 'staff_personal' | 'venue_master'

function getAuthContext(req: Request): AuthContext {
  const ctx = (req as any).authContext as AuthContext | undefined
  if (!ctx || !ctx.userId) {
    throw new UnauthorizedError('Autenticación requerida')
  }
  return ctx
}

/**
 * GET /api/v1/google-calendar/oauth/init?intent=staff_personal|venue_master
 *
 * Returns `{ url: string }` — the Google authorization URL the dashboard must
 * redirect the user to. Includes a JWT-signed `state` parameter so the callback
 * can prove the redirect originated from us and re-attach the intent/scope.
 */
export async function oauthInit(req: Request, res: Response, next: NextFunction) {
  try {
    const intent = String(req.query.intent ?? '') as Intent
    if (intent !== 'staff_personal' && intent !== 'venue_master') {
      throw new BadRequestError('intent inválido')
    }

    const ctx = getAuthContext(req)
    const access = await getUserAccess(ctx.userId, ctx.venueId)

    if (intent === 'venue_master' && !hasPermission(access, 'calendar:manage_venue')) {
      throw new ForbiddenError('No tienes permiso para conectar el calendario del establecimiento')
    }
    if (intent === 'staff_personal' && !hasPermission(access, 'calendar:connect_self')) {
      throw new ForbiddenError('No tienes permiso para conectar tu calendario personal')
    }

    const state = signState({
      intent,
      authUserId: ctx.userId,
      staffId: intent === 'staff_personal' ? ctx.userId : undefined,
      venueId: intent === 'venue_master' ? ctx.venueId : undefined,
      csrfNonce: crypto.randomBytes(32).toString('hex'),
    })

    res.status(200).json({ url: buildAuthUrl(state, false) })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/google-calendar/oauth/callback?code=...&state=...
 *
 * Google's redirect target. NO auth middleware mounts before this — Google
 * performs a top-level navigation and the dashboard cookie may not be present.
 *
 * Behavior:
 *   1. Verify the signed state JWT.
 *   2. Exchange the code with Google for tokens.
 *   3. If Google omitted `refresh_token` (re-consent path), redirect again
 *      with `prompt=consent` to force a fresh refresh token.
 *   4. Cryptographically verify the OIDC id_token against Google's JWKS.
 *   5. Encrypt the tokens, create a one-shot `GoogleOAuthSession` row, and
 *      303-redirect back to the dashboard picker with `?session=<token>`.
 */
export async function oauthCallback(req: Request, res: Response, next: NextFunction) {
  try {
    const code = String(req.query.code ?? '')
    const state = String(req.query.state ?? '')
    if (!code || !state) {
      throw new BadRequestError('Faltan los parámetros code o state')
    }

    let decoded: ReturnType<typeof verifyState>
    try {
      decoded = verifyState(state)
    } catch (err) {
      logger.warn('gcal oauth callback: invalid state JWT', { err: (err as Error).message })
      throw new BadRequestError('state inválido o expirado')
    }

    const tokens = await exchangeCodeForTokens(code)

    // Refresh-token retry path: when Google returns no refresh_token (re-consent
    // session) we redirect back through OAuth with `prompt=consent` to force the
    // consent screen and emit a fresh refresh_token. The state is preserved so
    // the second callback round-trip lands with the same intent/identity.
    if (!tokens.refresh_token) {
      const retryState = signState({
        intent: decoded.intent,
        authUserId: decoded.authUserId,
        staffId: decoded.staffId,
        venueId: decoded.venueId,
        csrfNonce: decoded.csrfNonce,
      })
      return res.redirect(303, buildAuthUrl(retryState, true))
    }

    const { sub, email } = await verifyGoogleIdToken(tokens.id_token!)

    const { sessionToken } = await createOAuthSession({
      authUserId: decoded.authUserId,
      intent: decoded.intent,
      venueId: decoded.venueId,
      staffId: decoded.staffId,
      encryptedRefreshToken: encryptToken(tokens.refresh_token),
      encryptedAccessToken: encryptToken(tokens.access_token!),
      accessTokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
      googleAccountEmail: email,
      googleAccountSub: sub,
    })

    return res.redirect(303, `${DASHBOARD_BASE}/google-calendar/picker?session=${sessionToken}`)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/google-calendar/oauth/calendars?session=<sessionToken>
 *
 * Lists the user's calendars filtered by accessRole based on the session's
 * intent. Called by the dashboard's picker UI after a successful callback
 * redirect lands them back logged in.
 *
 * Filtering rules (spec §7.4 step 2):
 *   - staff_personal: owner|writer only. Reader/freeBusyReader excluded —
 *     personal calendars must be writable to insert push events later.
 *   - venue_master: owner|writer|reader. Read-only calendars are valid block
 *     sources for venues that disable Avoqado→Google push.
 */
export async function listCalendars(req: Request, res: Response, next: NextFunction) {
  try {
    const ctx = getAuthContext(req)
    const sessionToken = String(req.query.session ?? '')
    if (!sessionToken) throw new BadRequestError('Falta el parámetro session')

    const session = await loadAndAuthorizeSession(sessionToken, ctx)

    const auth = buildOAuthClient()
    auth.setCredentials({
      access_token: decryptToken(Buffer.from(session.encryptedAccessToken)),
      refresh_token: decryptToken(Buffer.from(session.encryptedRefreshToken)),
    })
    const calendar = google.calendar({ version: 'v3', auth })

    const list = await calendar.calendarList.list({ minAccessRole: 'reader', showHidden: false })

    const minRoles = session.intent === 'staff_personal' ? ['owner', 'writer'] : ['owner', 'writer', 'reader']
    const calendars = (list.data.items ?? [])
      .filter(c => minRoles.includes(c.accessRole ?? 'reader'))
      .map(c => ({
        id: c.id,
        summary: c.summary,
        timeZone: c.timeZone,
        accessRole: c.accessRole,
        primary: c.primary ?? false,
      }))

    res.status(200).json({ calendars })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/google-calendar/connections
 *
 * Atomically commit the connection after the user picks a calendar.
 *
 * Body: `{ session: string, selectedCalendarId: string }`
 *
 * Internals delegated to `commitConnection`:
 *   1. Fetch calendar metadata (validates tokens still work + final accessRole check).
 *   2. Subscribe to events.watch BEFORE the transaction.
 *   3. Single transaction: consume session + create connection + create channel.
 *   4. Post-commit: TODO enqueue backfill (Subagent 3 wires the pull worker).
 */
export async function postConnection(req: Request, res: Response, next: NextFunction) {
  try {
    const ctx = getAuthContext(req)
    const sessionToken = String(req.body?.session ?? '')
    const calendarId = String(req.body?.selectedCalendarId ?? '')

    if (!sessionToken) throw new BadRequestError('Falta el parámetro session')
    if (!calendarId) throw new BadRequestError('Falta el parámetro selectedCalendarId')

    const session = await loadAndAuthorizeSession(sessionToken, ctx)

    const connection = await commitConnection({
      sessionId: session.id,
      selectedCalendarId: calendarId,
      createdByStaffId: ctx.userId,
    })

    res.status(201).json({
      connection: {
        id: connection.id,
        scope: connection.scope,
        googleAccountEmail: connection.googleAccountEmail,
        selectedCalendarId: connection.selectedCalendarId,
        selectedCalendarSummary: connection.selectedCalendarSummary,
        selectedCalendarTimeZone: connection.selectedCalendarTimeZone,
        status: connection.status,
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/google-calendar/connections
 *
 * Lists connections the caller can see:
 *   - All venue connections in the caller's current venue.
 *   - The caller's own personal connection (any venue).
 *
 * Selects only display-safe columns (never returns ciphertext / syncToken).
 */
export async function listConnections(req: Request, res: Response, next: NextFunction) {
  try {
    const ctx = getAuthContext(req)

    const connections = await prisma.googleCalendarConnection.findMany({
      where: {
        OR: [{ staffId: ctx.userId }, { venueId: ctx.venueId, scope: 'VENUE' }],
      },
      select: {
        id: true,
        scope: true,
        venueId: true,
        staffId: true,
        googleAccountEmail: true,
        selectedCalendarId: true,
        selectedCalendarSummary: true,
        selectedCalendarTimeZone: true,
        status: true,
        statusReason: true,
        lastSyncedAt: true,
        connectedAt: true,
        disconnectedAt: true,
      },
      orderBy: { connectedAt: 'desc' },
    })

    res.status(200).json({ connections })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/google-calendar/connections/:id
 *
 * Detailed status of a single connection — used by the dashboard's per-connection
 * settings/diagnostics view. Returns:
 *   - The display-safe connection columns.
 *   - The latest ACTIVE watch channel (if any).
 *   - Aggregate counts of pending/failed and dead-letter outbox rows.
 *
 * Authorization (spec §12):
 *   - Own personal: scope=STAFF_PERSONAL && staffId === caller.userId (always allowed).
 *   - Otherwise: require `calendar:view_status` for the caller's current venue.
 */
export async function getConnectionDetail(req: Request, res: Response, next: NextFunction) {
  try {
    const ctx = getAuthContext(req)
    const id = String(req.params.id ?? '')
    if (!id) throw new BadRequestError('Falta el id de conexión')

    const conn = await prisma.googleCalendarConnection.findUnique({
      where: { id },
      select: {
        id: true,
        scope: true,
        venueId: true,
        staffId: true,
        googleAccountEmail: true,
        selectedCalendarId: true,
        selectedCalendarSummary: true,
        selectedCalendarTimeZone: true,
        status: true,
        statusReason: true,
        lastSyncedAt: true,
        lastHorizonEnd: true,
        connectedAt: true,
        disconnectedAt: true,
      },
    })
    if (!conn) throw new NotFoundError('Conexión no encontrada')

    const isOwnPersonal = conn.scope === 'STAFF_PERSONAL' && conn.staffId === ctx.userId
    if (!isOwnPersonal) {
      const access = await getUserAccess(ctx.userId, ctx.venueId)
      if (!hasPermission(access, 'calendar:view_status')) {
        throw new ForbiddenError('No tienes permiso para ver el estado de esta conexión')
      }
    }

    const [pendingCount, deadLetterCount, latestChannel] = await Promise.all([
      prisma.calendarSyncOutbox.count({
        where: { targetConnectionId: id, status: { in: ['PENDING', 'FAILED'] } },
      }),
      prisma.calendarSyncOutbox.count({
        where: { targetConnectionId: id, status: 'DEAD_LETTER' },
      }),
      prisma.googleCalendarChannel.findFirst({
        where: { connectionId: id, status: 'ACTIVE' },
        orderBy: { expiresAt: 'desc' },
        select: { expiresAt: true, status: true },
      }),
    ])

    res.status(200).json({
      connection: {
        id: conn.id,
        scope: conn.scope,
        status: conn.status,
        statusReason: conn.statusReason,
        googleAccountEmail: conn.googleAccountEmail,
        selectedCalendarId: conn.selectedCalendarId,
        selectedCalendarSummary: conn.selectedCalendarSummary,
        selectedCalendarTimeZone: conn.selectedCalendarTimeZone,
        lastSyncedAt: conn.lastSyncedAt,
        lastHorizonEnd: conn.lastHorizonEnd,
        connectedAt: conn.connectedAt,
        disconnectedAt: conn.disconnectedAt,
        channel: latestChannel ? { expiresAt: latestChannel.expiresAt, status: latestChannel.status } : null,
        pendingCount,
        deadLetterCount,
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/google-calendar/connections/:id
 *
 * Disconnect a Google Calendar integration:
 *   - Stop all ACTIVE/RENEWING watch channels at Google (best-effort).
 *   - Delete the connection's ExternalBusyBlock rows.
 *   - Mark all channels STOPPED and the connection DISCONNECTED in one txn.
 *
 * Authorization (spec §12):
 *   - Own personal: scope=STAFF_PERSONAL && staffId === caller.userId.
 *   - Venue master: scope=VENUE && venueId === caller.venueId AND `calendar:manage_venue`.
 *   - Another's personal: scope=STAFF_PERSONAL && staffId !== caller.userId
 *     AND `calendar:disconnect_staff`.
 */
export async function disconnectConnection(req: Request, res: Response, next: NextFunction) {
  try {
    const ctx = getAuthContext(req)
    const id = String(req.params.id ?? '')
    if (!id) throw new BadRequestError('Falta el id de conexión')

    const conn = await prisma.googleCalendarConnection.findUnique({
      where: { id },
      include: { channels: true },
    })
    if (!conn) throw new NotFoundError('Conexión no encontrada')

    const access = await getUserAccess(ctx.userId, ctx.venueId)

    const isOwnPersonal = conn.scope === 'STAFF_PERSONAL' && conn.staffId === ctx.userId
    const isVenueAdmin = conn.scope === 'VENUE' && conn.venueId === ctx.venueId && hasPermission(access, 'calendar:manage_venue')
    const isStaffAdmin =
      conn.scope === 'STAFF_PERSONAL' && conn.staffId !== ctx.userId && hasPermission(access, 'calendar:disconnect_staff')

    if (!isOwnPersonal && !isVenueAdmin && !isStaffAdmin) {
      throw new ForbiddenError('No tienes permiso para desconectar esta conexión')
    }

    // Best-effort: stop the channel at Google. If our tokens were revoked
    // upstream, the call throws — we swallow it and still mark our local
    // state DISCONNECTED so the connection stops trying to renew.
    const activeChannels = (conn.channels ?? []).filter(c => c.status === 'ACTIVE' || c.status === 'RENEWING')
    for (const ch of activeChannels) {
      try {
        await stopChannel({
          accessToken: conn.accessTokenCiphertext ? decryptToken(Buffer.from(conn.accessTokenCiphertext)) : '',
          refreshToken: decryptToken(Buffer.from(conn.refreshTokenCiphertext)),
          channelId: ch.channelId,
          resourceId: ch.resourceId,
        })
      } catch (err) {
        logger.warn('gcal disconnect: stopChannel failed (token may already be revoked); proceeding', {
          err: (err as Error).message,
          connectionId: conn.id,
          channelId: ch.channelId,
        })
      }
    }

    await prisma.$transaction([
      prisma.externalBusyBlock.deleteMany({ where: { googleConnectionId: conn.id } }),
      prisma.googleCalendarChannel.updateMany({
        where: { connectionId: conn.id },
        data: { status: 'STOPPED', stoppedAt: new Date() },
      }),
      prisma.googleCalendarConnection.update({
        where: { id: conn.id },
        data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
      }),
    ])

    res.status(204).end()
  } catch (error) {
    next(error)
  }
}
